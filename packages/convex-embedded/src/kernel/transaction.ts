/**
 * OCC (Optimistic Concurrency Control) transaction manager.
 *
 * Two complementary pieces:
 *
 * 1. `TransactionManager` — serializes function execution via a promise-based
 *    mutex, matching convex-test's pattern. Nested calls (e.g. a mutation
 *    calling `ctx.runQuery`) share the parent lock.
 *
 * 2. `OccTransaction` — full optimistic concurrency control with read-set
 *    tracking, conflict detection, and automatic retry with exponential
 *    backoff + jitter.
 */

import { Fx } from "@robelest/fx";

import type { DocumentId, Timestamp } from "@/core/types";

// ---------------------------------------------------------------------------
// TransactionDatabase — the interface OccTransaction expects
// ---------------------------------------------------------------------------

/**
 * Subset of the Database interface used by OccTransaction.
 * Defined here to avoid circular dependencies with database.ts.
 */
export interface TransactionDatabase {
  startTransaction(): void;
  commit(): void;
  rollbackWrites(): void;
  getDocumentTimestamp(id: DocumentId): Timestamp | null;
  getTableLastWriteTimestamp(tableName: string): Timestamp | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OCC_MAX_RETRIES = 5;
export const OCC_BASE_DELAY_MS = 50;

// ---------------------------------------------------------------------------
// TransactionManager — promise-based mutex for sequential execution
// ---------------------------------------------------------------------------

/**
 * Serializes function execution so that only one top-level mutation / query
 * runs at a time. Actions may invoke mutations concurrently, but each
 * mutation acquires this lock before touching the database.
 *
 * Nested transactions (e.g. `ctx.runQuery` inside a mutation) share the
 * parent's lock and are *not* independently isolated.
 *
 * This follows the standard condition-variable pattern used in convex-test:
 * a loop that awaits the current promise ensures correctness even when
 * multiple waiters are woken simultaneously.
 */
export class TransactionManager {
  /** Resolves when the current top-level transaction finishes. */
  private _waitOnCurrentFunction: Promise<void> | null = null;
  /** Resolver for `_waitOnCurrentFunction`. */
  private _markTransactionDone: (() => void) | null = null;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire the transaction lock.
   *
   * For **top-level** calls (`isNested === false`) this waits until any
   * in-flight transaction completes, then sets up a new promise gate.
   *
   * For **nested** calls the lock is already held by the parent — we just
   * pass through.
   */
  async begin(isNested: boolean): Promise<void> {
    if (!isNested) {
      // Standard condition-variable loop: the current promise might resolve
      // and another waiter could acquire the lock before us, so keep looping.
      while (this._waitOnCurrentFunction !== null) {
        await this._waitOnCurrentFunction;
      }
      this._waitOnCurrentFunction = new Promise<void>((resolve) => {
        this._markTransactionDone = resolve;
      });
    }
  }

  /**
   * Commit the transaction and release the lock (top-level only).
   */
  commit(isNested: boolean): void {
    this._endTransaction(isNested);
  }

  /**
   * Rollback the transaction and release the lock (top-level only).
   */
  rollback(isNested: boolean): void {
    this._endTransaction(isNested);
  }

  /**
   * Returns `true` when a transaction lock is currently held.
   */
  isInTransaction(): boolean {
    return this._waitOnCurrentFunction !== null;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _endTransaction(isNested: boolean): void {
    if (!isNested) {
      if (this._markTransactionDone === null) {
        throw new Error("TransactionManager: no active transaction to end");
      }
      // Clear the gate *before* resolving so that the next waiter in line
      // sees `_waitOnCurrentFunction === null` and can proceed.
      const done = this._markTransactionDone;
      this._waitOnCurrentFunction = null;
      this._markTransactionDone = null;
      done();
    }
  }
}

// ---------------------------------------------------------------------------
// OccTransaction — optimistic concurrency control with conflict detection
// ---------------------------------------------------------------------------

/**
 * Conflict error thrown when the read set is invalidated.
 */
export class OccConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OccConflictError";
  }
}

export interface OccTransactionOptions {
  /** The database instance implementing the transaction interface. */
  db: TransactionDatabase;
  maxRetries?: number;
}

/**
 * Runs a function inside an OCC envelope:
 *
 * 1. Begin a database transaction (snapshot reads, staged writes).
 * 2. Execute the user function — reads are recorded via `addRead` /
 *    `addTableRead`.
 * 3. **Validate**: check that nothing in the read set was modified after
 *    the recorded timestamps.
 * 4. On conflict → rollback, backoff with jitter, retry.
 * 5. On success → commit and return the result.
 *
 * The retry budget defaults to `OCC_MAX_RETRIES` (5).
 */
export class OccTransaction {
  private readonly _db: TransactionDatabase;
  private readonly _maxRetries: number;

  /** Document-level read set: documentId → timestamp at read time. */
  private _readSet: Map<DocumentId, Timestamp> = new Map();
  /** Table-level read set: tables scanned (full table scans, etc.). */
  private _tablesRead: Set<string> = new Set();

  constructor(opts: OccTransactionOptions) {
    this._db = opts.db;
    this._maxRetries = opts.maxRetries ?? OCC_MAX_RETRIES;
  }

  // -------------------------------------------------------------------------
  // Read tracking
  // -------------------------------------------------------------------------

  /**
   * Record that `id` was read at `timestamp`. If the same document is read
   * more than once, we keep the *earliest* timestamp — the most conservative
   * check.
   */
  addRead(id: DocumentId, timestamp: Timestamp): void {
    const existing = this._readSet.get(id);
    if (existing === undefined || timestamp < existing) {
      this._readSet.set(id, timestamp);
    }
  }

  /**
   * Record that a full table scan was performed on `tableName`.
   */
  addTableRead(tableName: string): void {
    this._tablesRead.add(tableName);
  }

  // -------------------------------------------------------------------------
  // Execute with retry
  // -------------------------------------------------------------------------

  /**
   * Run `fn` inside the OCC envelope. Retries up to `maxRetries` times on
   * conflict, using exponential backoff with jitter.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const retrySchedule = Fx.retry.compose(
      Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
      Fx.retry.recurs(this._maxRetries),
    );

    const attempt = Fx.defer(() => {
      // Reset read tracking for each attempt.
      this._readSet.clear();
      this._tablesRead.clear();

      this._db.startTransaction();

      return Fx.from({ ok: () => fn(), err: (e) => e }).pipe(
        Fx.then((result) =>
          Fx.from({
            ok: () => {
              this._validateReadSet();
              this._db.commit();
              return result;
            },
            err: (e) => e,
          }),
        ),
        Fx.recover((err) => {
          this._db.rollbackWrites();
          return err instanceof OccConflictError ? Fx.fail(err) : Fx.fatal(err);
        }),
      );
    });

    return Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Check every entry in the read set against the current database state.
   *
   * Throws `OccConflictError` if any document (or scanned table) has been
   * modified since the recorded timestamp.
   */
  private _validateReadSet(): void {
    // Document-level checks
    for (const [id, readTs] of this._readSet) {
      const currentTs: Timestamp | null = this._db.getDocumentTimestamp(id);

      // Document was deleted (or never existed) — conflict if we previously
      // read a valid version.
      if (currentTs === null) {
        throw new OccConflictError(
          `OCC conflict: document ${id} was deleted after being read at ts=${readTs}`,
        );
      }

      if (currentTs !== readTs) {
        throw new OccConflictError(
          `OCC conflict: document ${id} changed (read ts=${readTs}, current ts=${currentTs})`,
        );
      }
    }

    // Table-level checks (for full scans / index range scans)
    for (const tableName of this._tablesRead) {
      const tableTs: Timestamp | null =
        this._db.getTableLastWriteTimestamp(tableName);

      // A null tableTs means the table is empty / untouched — no conflict.
      if (tableTs === null) {
        continue;
      }

      // If *any* document-level read in this table was at a timestamp that
      // precedes the table's latest write, a new row may have appeared that
      // our scan missed.
      for (const [id, readTs] of this._readSet) {
        // Skip documents in other tables.
        if (!this._belongsToTable(id, tableName)) {
          continue;
        }
        if (tableTs > readTs) {
          throw new OccConflictError(
            `OCC conflict: table "${tableName}" was written (ts=${tableTs}) after scan read at ts=${readTs}`,
          );
        }
      }

      // Even if no individual document was read, a table scan that observed
      // zero rows should still conflict if a write occurred after the
      // transaction started. We approximate this by checking if we have *no*
      // document reads in the table — meaning we saw an empty result — but
      // the table has been written to.
      const hasDocReadsInTable = [...this._readSet.keys()].some((id) =>
        this._belongsToTable(id, tableName),
      );
      if (!hasDocReadsInTable && tableTs !== null) {
        // The table has data now; we scanned and saw nothing — possible
        // phantom. Conservative: flag conflict.
        throw new OccConflictError(
          `OCC conflict: table "${tableName}" has writes (ts=${tableTs}) but scan returned no rows`,
        );
      }
    }
  }

  /**
   * Check whether a document ID belongs to the given table.
   *
   * Our ID format is `"<counter>;<tableName>"`, so we split on `";"` and
   * compare the second segment.
   */
  private _belongsToTable(id: DocumentId, tableName: string): boolean {
    const parts = (id as string).split(";");
    return parts.length === 2 && parts[1] === tableName;
  }
}
