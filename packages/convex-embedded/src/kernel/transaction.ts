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

import type { DocumentId, Timestamp } from "@/runtime/db/types";
import { retryWithBackoff } from "@/utils/retry";

/**
 * Subset of the Database interface used by OccTransaction.
 * Defined here to avoid circular dependencies with database.ts.
 */
export interface TransactionDatabase {
  /** Current MVCC timestamp. */
  readonly timestamp: Timestamp;
  startTransaction(): void;
  commitAsync(): Promise<unknown>;
  rollbackWrites(): void;
  getDocumentTimestamp(id: DocumentId): Timestamp | null;
  getTableLastWriteTimestamp(tableName: string): Timestamp | null;
  /** Look up the table name for a document ID (from the ID→table map). */
  getTableForId(id: string): string | undefined;
}

export const OCC_MAX_RETRIES = 5;
const OCC_BASE_DELAY_MS = 50;

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
export interface TransactionManager {
  begin(isNested: boolean): Promise<void>;
  commit(isNested: boolean): void;
  rollback(isNested: boolean): void;
  isInTransaction(): boolean;
}

export function createTransactionManager(): TransactionManager {
  let waitOnCurrentFunction: Promise<void> | null = null;
  let markTransactionDone: (() => void) | null = null;

  function endTransaction(isNested: boolean): void {
    if (!isNested) {
      if (markTransactionDone === null) {
        throw new Error("TransactionManager: no active transaction to end");
      }
      const done = markTransactionDone;
      waitOnCurrentFunction = null;
      markTransactionDone = null;
      done();
    }
  }

  return {
    async begin(isNested: boolean): Promise<void> {
      if (!isNested) {
        while (waitOnCurrentFunction !== null) {
          await waitOnCurrentFunction;
        }
        waitOnCurrentFunction = new Promise<void>((resolve) => {
          markTransactionDone = resolve;
        });
      }
    },
    commit(isNested: boolean): void {
      endTransaction(isNested);
    },
    rollback(isNested: boolean): void {
      endTransaction(isNested);
    },
    isInTransaction(): boolean {
      return waitOnCurrentFunction !== null;
    },
  };
}

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
  /** Database timestamp captured at the start of each attempt. */
  private _startTs: Timestamp = 0;

  constructor(opts: OccTransactionOptions) {
    this._db = opts.db;
    this._maxRetries = opts.maxRetries ?? OCC_MAX_RETRIES;
  }

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

  /**
   * Run `fn` inside the OCC envelope. Retries up to `maxRetries` times on
   * conflict, using exponential backoff with jitter.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(
      async () => {
        this._readSet.clear();
        this._tablesRead.clear();
        this._startTs = this._db.timestamp;

        this._db.startTransaction();

        let result: T;
        try {
          result = await fn();
        } catch (err) {
          this._db.rollbackWrites();
          throw err;
        }

        try {
          this._validateReadSet();
          await this._db.commitAsync();
          return result;
        } catch (err) {
          this._db.rollbackWrites();
          if (err instanceof OccConflictError) {
            throw err;
          }
          throw err;
        }
      },
      {
        maxRetries: this._maxRetries,
        baseMs: OCC_BASE_DELAY_MS,
        jitter: true,
        shouldRetry: (err) => err instanceof OccConflictError,
      },
    );
  }

  /**
   * Check every entry in the read set against the current database state.
   *
   * Throws `OccConflictError` if any document (or scanned table) has been
   * modified since the recorded timestamp.
   */
  private _validateReadSet(): void {
    for (const [id, readTs] of this._readSet) {
      const currentTs: Timestamp | null = this._db.getDocumentTimestamp(id);

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

    for (const tableName of this._tablesRead) {
      const tableTs: Timestamp | null =
        this._db.getTableLastWriteTimestamp(tableName);

      if (tableTs === null) {
        continue;
      }

      for (const [id, readTs] of this._readSet) {
        if (!this._belongsToTable(id, tableName)) {
          continue;
        }
        if (tableTs > readTs) {
          throw new OccConflictError(
            `OCC conflict: table "${tableName}" was written (ts=${tableTs}) after scan read at ts=${readTs}`,
          );
        }
      }

      const hasDocReadsInTable = [...this._readSet.keys()].some((id) =>
        this._belongsToTable(id, tableName),
      );
      if (!hasDocReadsInTable && tableTs > this._startTs) {
        throw new OccConflictError(
          `OCC conflict: table "${tableName}" was written (ts=${tableTs}) after transaction started (ts=${this._startTs}) but scan returned no rows`,
        );
      }
    }
  }

  /**
   * Check whether a document ID belongs to the given table via the
   * database's ID→table map.
   */
  private _belongsToTable(id: DocumentId, tableName: string): boolean {
    return this._db.getTableForId(id as string) === tableName;
  }
}
