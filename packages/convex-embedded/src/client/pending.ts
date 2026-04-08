/**
 * Persistent mutation queue backed by the embedded runtime's
 * `_resolve_pending` system table.
 *
 * Mutations are appended when the sync engine can't immediately push to
 * remote (offline, or as part of the serial queue). The queue survives
 * page reloads because entries are persisted to the embedded DB.
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";

import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import { getFunctionName } from "@/shared/function-refs";
import { createLogger } from "@/shared/logger";
import type { PendingReplayMeta } from "@/shared/symbols";

const log = createLogger("pending-queue");

// ---------------------------------------------------------------------------
// System function paths (must match convex-embedded's SYSTEM_FUNCTIONS keys)
// ---------------------------------------------------------------------------

const SYS_PENDING_PUSH = "_system:pendingPush";
const SYS_PENDING_GET_ALL = "_system:pendingGetAll";
const SYS_PENDING_CLAIM_NEXT = "_system:pendingClaimNext";
const SYS_PENDING_RENEW_LEASE = "_system:pendingRenewLease";
const SYS_PENDING_REMOVE = "_system:pendingRemove";
const SYS_PENDING_RELEASE = "_system:pendingRelease";
const SYS_PENDING_CLEAR = "_system:pendingClear";
const SYS_PENDING_BLOCK = "_system:pendingBlock";
const SYS_PENDING_UNBLOCK_ALL = "_system:pendingUnblockAll";

export const PENDING_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "pendingQueue",
  scope: "identity",
  version: 1,
};

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
  /** Forward-only payload version for args/localResult migration. */
  payloadVersion?: number;
  /** Identity namespace this entry belongs to. */
  identityKey?: string | null;
  /** Replay state for this entry. */
  state?: "pending" | "processing" | "blocked";
  /** Active processor owner when this entry is being replayed. */
  owner?: string;
  /** When the current processing lease started. */
  processingStartedAt?: number;
  /** When the current replay lease expires. */
  leaseExpiresAt?: number;
  /** Optional blocked replay reason. */
  blockedReason?: "reauthRequired" | "authorizationDenied" | "scopeChanged";
  /** True when this entry was loaded from persistence during hydrate. */
  hydrated?: boolean;
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
 * Optional local query executor used for runtime-first hydration reads.
 */
export type LocalQueryExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type LocalMutationExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface PendingEntryStoreAdapter {
  transaction<T>(work: () => Promise<T> | T): Promise<T>;
  list(identityKey: string | null): Promise<Array<Record<string, unknown>>>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
}

export async function migratePendingEntries(
  adapter: PendingEntryStoreAdapter,
  identityKey: string | null,
  replayMetadata: ReadonlyMap<string, PendingReplayMeta>,
): Promise<void> {
  await adapter.transaction(async () => {
    const entries = await adapter.list(identityKey);
    for (const entry of entries) {
      const ref = typeof entry.ref === "string" ? entry.ref : null;
      const argsJson = typeof entry.args === "string" ? entry.args : null;
      const localResultJson =
        typeof entry.localResult === "string" ? entry.localResult : null;
      if (!ref || !argsJson || !localResultJson) {
        continue;
      }

      const meta = replayMetadata.get(ref);
      const targetVersion = meta?.version ?? 1;
      let currentVersion =
        typeof entry.payloadVersion === "number" ? entry.payloadVersion : 1;

      if (currentVersion > targetVersion) {
        throw new Error(
          `Pending queue entry for "${ref}" is at payload version ${currentVersion}, but this app only supports ${targetVersion}.`,
        );
      }

      let args = JSON.parse(argsJson) as Record<string, unknown>;
      let localResult = JSON.parse(localResultJson) as unknown;

      for (
        let version = currentVersion + 1;
        version <= targetVersion;
        version++
      ) {
        const step = meta?.migrate[version];
        if (!step) {
          currentVersion = version;
          continue;
        }

        const next = await step({
          ref,
          fromVersion: version - 1,
          toVersion: version,
          args,
          localResult,
        });
        args = next.args;
        localResult = next.localResult;
        currentVersion = version;
      }

      const nextArgs = JSON.stringify(args);
      const nextLocalResult = JSON.stringify(localResult);
      if (
        currentVersion !== entry.payloadVersion ||
        nextArgs !== argsJson ||
        nextLocalResult !== localResultJson
      ) {
        await adapter.patch(String(entry._id), {
          args: nextArgs,
          localResult: nextLocalResult,
          payloadVersion: currentVersion,
        });
      }
    }
  });
}

export class PendingQueue {
  /** In-memory queue — kept in remote with the DB. */
  private _entries: PendingEntry[] = [];

  /** The local embedded client. */
  private _localClient: ConvexClient;

  /** Local query executor used for runtime-first hydration reads. */
  private _queryFn: LocalQueryExecutorFn | null;

  /** Local mutation executor used for runtime-first bookkeeping writes. */
  private _mutationFn: LocalMutationExecutorFn | null;

  /** Active identity namespace for persistence. */
  private _getIdentityKey: (() => string | null) | null;

  constructor(
    localClient: ConvexClient,
    queryFn?: LocalQueryExecutorFn,
    mutationFn?: LocalMutationExecutorFn,
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
              payloadVersion:
                typeof e.payloadVersion === "number"
                  ? (e.payloadVersion as number)
                  : 1,
              identityKey: (e.identityKey as string | undefined) ?? undefined,
              state:
                (e.state as PendingEntry["state"] | undefined) ?? "pending",
              owner: (e.owner as string | undefined) ?? undefined,
              processingStartedAt:
                (e.processingStartedAt as number | undefined) ?? undefined,
              leaseExpiresAt:
                (e.leaseExpiresAt as number | undefined) ?? undefined,
              blockedReason:
                (e.blockedReason as
                  | PendingEntry["blockedReason"]
                  | undefined) ?? undefined,
              hydrated: true,
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
    payloadVersion = 1,
  ): Promise<void> {
    // Extract the function name from the FunctionReference.
    // getFunctionName also accepts plain strings as a passthrough.
    const refName = typeof ref === "string" ? ref : getFunctionName(ref as any);

    const serialized = {
      ref: refName,
      args: JSON.stringify(args),
      localResult: JSON.stringify(localResult),
      table,
      payloadVersion,
      identityKey: this._getIdentityKey?.() ?? null,
      state: "pending" as const,
    };

    if (this._hasEquivalentPendingEntry(serialized)) {
      log.debug(
        `pending-queue: skipped duplicate entry (table: ${table}, queue size: ${this._entries.length})`,
      );
      return Promise.resolve();
    }

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
            this._entries.push({ _id: id, ...serialized, hydrated: false });
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
              hydrated: false,
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

  /** Read-only snapshot of the current queue. */
  entries(): readonly PendingEntry[] {
    return this._entries;
  }

  async block(
    entry: PendingEntry,
    reason: NonNullable<PendingEntry["blockedReason"]>,
  ): Promise<void> {
    entry.state = "blocked";
    delete entry.owner;
    delete entry.processingStartedAt;
    delete entry.leaseExpiresAt;
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
      delete entry.owner;
      delete entry.processingStartedAt;
      delete entry.leaseExpiresAt;
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
   * Remove an entry from the queue after successful processing.
   */
  remove(
    target?: PendingEntry,
    owner?: string,
  ): Promise<PendingEntry | undefined> {
    const index =
      target === undefined
        ? 0
        : this._entries.findIndex((entry) => entry._id === target._id);
    if (index < 0) {
      return Promise.resolve(undefined);
    }

    const [entry] = this._entries.splice(index, 1);
    if (entry === undefined) return Promise.resolve(undefined);

    if (entry._id.startsWith("ephemeral_")) {
      return Promise.resolve(entry);
    }

    return Fx.run(
      Fx.from({
        ok: () =>
          this._mutationFn
            ? this._mutationFn(SYS_PENDING_REMOVE, { id: entry._id, owner })
            : ((this._localClient as any).mutation(SYS_PENDING_REMOVE, {
                id: entry._id,
                owner,
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

  async claimNext(
    owner: string,
    leaseMs = 30_000,
  ): Promise<PendingEntry | undefined> {
    const identityKey = this._getIdentityKey?.() ?? null;
    const claimed = (await (this._mutationFn
      ? this._mutationFn(SYS_PENDING_CLAIM_NEXT, {
          identityKey,
          owner,
          leaseMs,
        })
      : ((this._localClient as any).mutation(SYS_PENDING_CLAIM_NEXT, {
          identityKey,
          owner,
          leaseMs,
        }) as Promise<PendingEntry | null>))) as PendingEntry | null;

    const fallback = this._entries.find(
      (entry) =>
        (entry.identityKey ?? identityKey ?? null) === identityKey &&
        (entry.state === undefined || entry.state === "pending"),
    );

    if (
      claimed &&
      typeof claimed.ref === "string" &&
      typeof claimed.args === "string" &&
      typeof claimed.localResult === "string" &&
      typeof claimed.table === "string"
    ) {
      const existing = this._entries.find((entry) => entry._id === claimed._id);
      if (existing) {
        Object.assign(existing, claimed);
        return existing;
      }

      this._entries.push(claimed);
      return claimed;
    }

    if (fallback) {
      fallback.state = "processing";
      fallback.owner = owner;
      fallback.processingStartedAt = Date.now();
      fallback.leaseExpiresAt = Date.now() + leaseMs;
      return fallback;
    }

    if (!claimed) {
      await this.hydrate();
      return undefined;
    }

    await this.hydrate();
    return undefined;
  }

  async renewLease(
    entry: PendingEntry,
    owner: string,
    leaseMs = 30_000,
  ): Promise<boolean> {
    entry.owner = owner;
    entry.leaseExpiresAt = Date.now() + leaseMs;

    if (entry._id.startsWith("ephemeral_")) {
      return true;
    }

    const renewed = (await (this._mutationFn
      ? this._mutationFn(SYS_PENDING_RENEW_LEASE, {
          id: entry._id,
          owner,
          leaseMs,
        })
      : ((this._localClient as any).mutation(SYS_PENDING_RENEW_LEASE, {
          id: entry._id,
          owner,
          leaseMs,
        }) as Promise<unknown>))) as boolean | null;

    if (!renewed) {
      await this.hydrate();
      const reacquired = await this.claimNext(owner, leaseMs);
      if (reacquired?._id === entry._id) {
        Object.assign(entry, reacquired);
        return true;
      }
      return false;
    }
    return true;
  }

  async release(entry: PendingEntry, owner?: string): Promise<void> {
    entry.state = "pending";
    delete entry.owner;
    delete entry.processingStartedAt;
    delete entry.leaseExpiresAt;
    delete entry.blockedReason;

    if (entry._id.startsWith("ephemeral_")) {
      return;
    }

    await (this._mutationFn
      ? this._mutationFn(SYS_PENDING_RELEASE, { id: entry._id, owner })
      : ((this._localClient as any).mutation(SYS_PENDING_RELEASE, {
          id: entry._id,
          owner,
        }) as Promise<unknown>));
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

  private _hasEquivalentPendingEntry(candidate: {
    ref: string;
    args: string;
    identityKey: string | null;
  }): boolean {
    if (!candidate.ref.endsWith(":remove")) {
      return false;
    }

    const candidateId = this._extractMutationTargetId(candidate.args);
    if (candidateId === null) {
      return false;
    }

    return this._entries.some((entry) => {
      if (entry.ref !== candidate.ref) {
        return false;
      }
      if ((entry.identityKey ?? null) !== candidate.identityKey) {
        return false;
      }
      return this._extractMutationTargetId(entry.args) === candidateId;
    });
  }

  private _extractMutationTargetId(argsJson: string): string | null {
    try {
      const args = JSON.parse(argsJson) as { id?: unknown };
      return typeof args.id === "string" ? args.id : null;
    } catch {
      return null;
    }
  }
}
