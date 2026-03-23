/**
 * Persistent mutation queue backed by the embedded runtime's
 * `_resolve_pending` system table.
 *
 * Mutations are appended when the monitor can't immediately push to
 * remote (offline, or as part of the serial queue). The queue survives
 * page reloads because entries are persisted to the embedded DB.
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";

import { createLogger } from "@/shared/logger";

const log = createLogger("pending-queue");

// ---------------------------------------------------------------------------
// System function paths (must match convex-embedded's SYSTEM_FUNCTIONS keys)
// ---------------------------------------------------------------------------

const SYS_PENDING_PUSH = "_system:pendingPush";
const SYS_PENDING_GET_ALL = "_system:pendingGetAll";
const SYS_PENDING_REMOVE = "_system:pendingRemove";
const SYS_PENDING_CLEAR = "_system:pendingClear";
const SYS_PENDING_BLOCK = "_system:pendingBlock";
const SYS_PENDING_UNBLOCK_ALL = "_system:pendingUnblockAll";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A mutation entry in the pending queue. */
export interface PendingEntry {
  /** Persisted document ID in _resolve_pending (for removal). */
  _id: string;
  /** Function name string (e.g. "tasks:create"). */
  ref: string;
  /** Serialized mutation args (JSON string). */
  args: string;
  /** Serialized local mutation result (JSON string). */
  localResult: string;
  /** Table name this mutation targets. */
  table: string;
  /** Identity namespace this entry belongs to. */
  identityKey?: string;
  /** Replay state for this entry. */
  state?: "pending" | "blocked";
  /** Optional blocked replay reason. */
  blockedReason?: "reauthRequired" | "authorizationDenied" | "scopeChanged";
}

export class PendingQueuePersistenceError extends Error {
  readonly entry: PendingEntry;

  constructor(entry: PendingEntry, cause: Error) {
    super(
      `Failed to persist pending mutation for ${entry.ref}; queued entry is ephemeral for this session only.`,
      { cause },
    );
    this.name = "PendingQueuePersistenceError";
    this.entry = entry;
  }
}

// ---------------------------------------------------------------------------
// PendingQueue
// ---------------------------------------------------------------------------

/**
 * Optional direct query function that bypasses the ConvexClient
 * subscription machinery. See {@link IdMap} for details on why
 * hydration reads must not go through ConvexClient.query().
 */
export type DirectQueryFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type DirectMutationFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export class PendingQueue {
  /** In-memory queue — kept in remote with the DB. */
  private _entries: PendingEntry[] = [];

  /** The local embedded client. */
  private _localClient: ConvexClient;

  /** Direct query bypass (avoids subscription version conflicts). */
  private _queryFn: DirectQueryFn | null;

  /** Direct mutation bypass (avoids patched ConvexClient.mutation()). */
  private _mutationFn: DirectMutationFn | null;

  /** Active identity namespace for persistence. */
  private _getIdentityKey: (() => string | null) | null;

  constructor(
    localClient: ConvexClient,
    queryFn?: DirectQueryFn,
    mutationFn?: DirectMutationFn,
    getIdentityKey?: () => string | null,
  ) {
    this._localClient = localClient;
    this._queryFn = queryFn ?? null;
    this._mutationFn = mutationFn ?? null;
    this._getIdentityKey = getIdentityKey ?? null;
  }

  // -----------------------------------------------------------------------
  // Hydration
  // -----------------------------------------------------------------------

  /**
   * Load all persisted pending mutations from the embedded DB.
   * Must be called (and awaited) before processing the queue.
   */
  hydrate(): Promise<void> {
    const identityKey = this._getIdentityKey?.() ?? null;
    return Fx.run(
      Fx.from({
        ok: () => {
          if (this._queryFn) {
            return this._queryFn(SYS_PENDING_GET_ALL, {
              identityKey,
            }) as Promise<Array<Record<string, unknown>>>;
          }
          return (this._localClient as any).query(SYS_PENDING_GET_ALL, {
            identityKey,
          }) as Promise<Array<Record<string, unknown>>>;
        },
        err: (e) => e as Error,
      }).pipe(
        Fx.tap((entries) =>
          Fx.sync(() => {
            this._entries = entries.map((e) => ({
              _id: e._id as string,
              ref: e.ref as string,
              args: e.args as string,
              localResult: e.localResult as string,
              table: e.table as string,
              identityKey: (e.identityKey as string | undefined) ?? undefined,
              state:
                (e.state as PendingEntry["state"] | undefined) ?? "pending",
              blockedReason:
                (e.blockedReason as
                  | PendingEntry["blockedReason"]
                  | undefined) ?? undefined,
            }));
            log.info(
              `pending-queue: hydrated ${this._entries.length} entry/entries`,
            );
          }),
        ),
        Fx.inspect((err) =>
          Fx.sync(() =>
            log.warn(
              "pending-queue: hydration failed (starting with empty queue)",
              err,
            ),
          ),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Queue operations
  // -----------------------------------------------------------------------

  /**
   * Append a mutation to the queue and persist it.
   *
   * The function reference is stored as its name string (e.g. "tasks:create")
   * via `getFunctionName()`. Args and localResult are JSON-serialized.
   */
  push(
    ref: unknown,
    args: Record<string, unknown>,
    localResult: unknown,
    table: string,
  ): Promise<void> {
    // Extract the function name from the FunctionReference.
    // getFunctionName also accepts plain strings as a passthrough.
    const refName = typeof ref === "string" ? ref : getFunctionName(ref as any);

    const serialized = {
      ref: refName,
      args: JSON.stringify(args),
      localResult: JSON.stringify(localResult),
      table,
      identityKey: this._getIdentityKey?.() ?? null,
      state: "pending" as const,
    };
    let persistenceError: PendingQueuePersistenceError | null = null;

    return Fx.run(
      Fx.from({
        ok: () =>
          (this._mutationFn
            ? this._mutationFn(SYS_PENDING_PUSH, serialized)
            : (this._localClient as any).mutation(
                SYS_PENDING_PUSH,
                serialized,
              )) as Promise<string>,
        err: (e) => e as Error,
      }).pipe(
        Fx.tap((id) =>
          Fx.sync(() => {
            this._entries.push({ _id: id, ...serialized });
            log.debug(
              `pending-queue: pushed entry (table: ${table}, queue size: ${this._entries.length})`,
            );
          }),
        ),
        Fx.inspect((err) =>
          Fx.sync(() => {
            log.warn("pending-queue: failed to persist entry", err);
            const ephemeralEntry = {
              _id: `ephemeral_${Date.now()}`,
              ...serialized,
            };
            // Keep an in-memory fallback for this session, but surface that
            // durability has been lost so callers can react explicitly.
            this._entries.push(ephemeralEntry);
            persistenceError = new PendingQueuePersistenceError(
              ephemeralEntry,
              err,
            );
          }),
        ),
        Fx.recover((err) => Fx.fail(persistenceError ?? (err as Error))),
        Fx.map(() => undefined as void),
      ),
    );
  }

  /**
   * Peek at the first entry without removing it.
   */
  peek(): PendingEntry | undefined {
    return this._entries[0];
  }

  async block(
    entry: PendingEntry,
    reason: NonNullable<PendingEntry["blockedReason"]>,
  ): Promise<void> {
    entry.state = "blocked";
    entry.blockedReason = reason;

    if (entry._id.startsWith("ephemeral_")) {
      return;
    }

    await (this._mutationFn
      ? this._mutationFn(SYS_PENDING_BLOCK, { id: entry._id, reason })
      : ((this._localClient as any).mutation(SYS_PENDING_BLOCK, {
          id: entry._id,
          reason,
        }) as Promise<unknown>));
  }

  async unblockAll(): Promise<void> {
    for (const entry of this._entries) {
      entry.state = "pending";
      delete entry.blockedReason;
    }

    await (this._mutationFn
      ? this._mutationFn(SYS_PENDING_UNBLOCK_ALL, {
          identityKey: this._getIdentityKey?.() ?? null,
        })
      : ((this._localClient as any).mutation(SYS_PENDING_UNBLOCK_ALL, {
          identityKey: this._getIdentityKey?.() ?? null,
        }) as Promise<unknown>));
  }

  /**
   * Remove the first entry from the queue (after successful processing).
   */
  shift(): Promise<PendingEntry | undefined> {
    const entry = this._entries.shift();
    if (entry === undefined) return Promise.resolve(undefined);

    if (entry._id.startsWith("ephemeral_")) {
      return Promise.resolve(entry);
    }

    return Fx.run(
      Fx.from({
        ok: () =>
          this._mutationFn
            ? this._mutationFn(SYS_PENDING_REMOVE, { id: entry._id })
            : ((this._localClient as any).mutation(SYS_PENDING_REMOVE, {
                id: entry._id,
              }) as Promise<unknown>),
        err: (e) => e as Error,
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() =>
            log.warn("pending-queue: failed to remove persisted entry", err),
          ),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => entry),
      ),
    );
  }

  /**
   * Clear all entries from the queue.
   */
  clear(): Promise<void> {
    this._entries = [];

    return Fx.run(
      Fx.from({
        ok: () =>
          this._mutationFn
            ? this._mutationFn(SYS_PENDING_CLEAR, {
                identityKey: this._getIdentityKey?.() ?? null,
              })
            : ((this._localClient as any).mutation(SYS_PENDING_CLEAR, {
                identityKey: this._getIdentityKey?.() ?? null,
              }) as Promise<unknown>),
        err: (e) => e as Error,
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() =>
            log.warn("pending-queue: failed to clear persisted entries", err),
          ),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  /** Number of entries in the queue. */
  get length(): number {
    return this._entries.length;
  }

  /** Whether the queue is empty. */
  get isEmpty(): boolean {
    return this._entries.length === 0;
  }
}
