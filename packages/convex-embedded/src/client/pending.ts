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

import type { ConvexClient } from "convex/browser";

import { createLogger } from "@/shared/logger";
import { getFunctionName } from "@/shared/refs";

const log = createLogger("pending-queue");

const SYS_PENDING_PUSH = "_system:pendingPush";
const SYS_PENDING_GET_ALL = "_system:pendingGetAll";
const SYS_PENDING_CLAIM_NEXT = "_system:pendingClaimNext";
const SYS_PENDING_RENEW_LEASE = "_system:pendingRenewLease";
const SYS_PENDING_REMOVE = "_system:pendingRemove";
const SYS_PENDING_RELEASE = "_system:pendingRelease";
const SYS_PENDING_CLEAR = "_system:pendingClear";
const SYS_PENDING_BLOCK = "_system:pendingBlock";
const SYS_PENDING_UNBLOCK_ALL = "_system:pendingUnblockAll";

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
  /** True when this entry was loaded from storage during hydrate. */
  hydrated?: boolean;
}

export class PendingQueueStorageError extends Error {
  readonly entry: PendingEntry;

  constructor(entry: PendingEntry, cause: Error) {
    super(
      `Failed to persist pending mutation for ${entry.ref}; queued entry is ephemeral for this session only.`,
      { cause },
    );
    this.name = "PendingQueueStorageError";
    this.entry = entry;
  }
}

export type {
  LocalQueryExecutorFn,
  LocalMutationExecutorFn,
} from "@/client/system-fns";
import type {
  LocalQueryExecutorFn,
  LocalMutationExecutorFn,
} from "@/client/system-fns";

export class PendingQueue {
  private _entries: PendingEntry[] = [];
  private _localClient: ConvexClient;
  private _queryFn: LocalQueryExecutorFn | null;
  private _mutationFn: LocalMutationExecutorFn | null;
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

  /**
   * Load all persisted pending mutations from the embedded DB.
   * Must be called (and awaited) before processing the queue.
   */
  async hydrate(): Promise<void> {
    const identityKey = this._getIdentityKey?.() ?? null;
    try {
      const entries = await (async () => {
        if (this._queryFn) {
          return this._queryFn(SYS_PENDING_GET_ALL, {
            identityKey,
          }) as Promise<Array<Record<string, unknown>>>;
        }
        return (this._localClient as any).query(SYS_PENDING_GET_ALL, {
          identityKey,
        }) as Promise<Array<Record<string, unknown>>>;
      })();

      this._entries = entries.map((e: any) => ({
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
        state: (e.state as PendingEntry["state"] | undefined) ?? "pending",
        owner: (e.owner as string | undefined) ?? undefined,
        processingStartedAt:
          (e.processingStartedAt as number | undefined) ?? undefined,
        leaseExpiresAt: (e.leaseExpiresAt as number | undefined) ?? undefined,
        blockedReason:
          (e.blockedReason as PendingEntry["blockedReason"] | undefined) ??
          undefined,
        hydrated: true,
      }));
      log.info(`pending-queue: hydrated ${this._entries.length} entry/entries`);
    } catch (err) {
      log.warn(
        "pending-queue: hydration failed (starting with empty queue)",
        err,
      );
    }
  }

  /**
   * Append a mutation to the queue and persist it.
   *
   * The function reference is stored as its name string (e.g. "tasks:create")
   * via `getFunctionName()`. Args and localResult are JSON-serialized.
   */
  async push(
    ref: unknown,
    args: Record<string, unknown>,
    localResult: unknown,
    table: string,
    payloadVersion = 1,
  ): Promise<void> {
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

    const collapsed = this._collapseTransientCreateDelete(
      serialized,
      localResult,
    );
    if (collapsed) {
      return collapsed;
    }

    if (this._hasEquivalentPendingEntry(serialized)) {
      log.debug(
        `pending-queue: skipped duplicate entry (table: ${table}, queue size: ${this._entries.length})`,
      );
      return;
    }

    let storageError: PendingQueueStorageError | null = null;

    try {
      const id = await ((
        this._mutationFn
          ? this._mutationFn(SYS_PENDING_PUSH, serialized)
          : (this._localClient as any).mutation(SYS_PENDING_PUSH, serialized)
      ) as Promise<string>);

      this._entries.push({ _id: id, ...serialized, hydrated: false });
      log.debug(
        `pending-queue: pushed entry (table: ${table}, queue size: ${this._entries.length})`,
      );
    } catch (err) {
      log.warn("pending-queue: failed to persist entry", err);
      const ephemeralEntry = {
        _id: `ephemeral_${Date.now()}`,
        ...serialized,
        hydrated: false,
      };
      this._entries.push(ephemeralEntry);
      storageError = new PendingQueueStorageError(
        ephemeralEntry,
        err as Error,
      );
      throw storageError;
    }
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
  async remove(
    target?: PendingEntry,
    owner?: string,
  ): Promise<PendingEntry | undefined> {
    const index =
      target === undefined
        ? 0
        : this._entries.findIndex((entry) => entry._id === target._id);
    if (index < 0) {
      return undefined;
    }

    const entry = this._entries[index];
    if (entry === undefined) return undefined;

    if (entry._id.startsWith("ephemeral_")) {
      this._entries.splice(index, 1);
      return entry;
    }

    try {
      const result = await (this._mutationFn
        ? this._mutationFn(SYS_PENDING_REMOVE, { id: entry._id, owner })
        : ((this._localClient as any).mutation(SYS_PENDING_REMOVE, {
            id: entry._id,
            owner,
          }) as Promise<unknown>));

      if (result === false) {
        log.warn(
          `pending-queue: remove rejected for ${entry.ref} (lease lost or stale)`,
        );
        return undefined;
      }
      this._entries.splice(index, 1);
      return entry;
    } catch (err) {
      log.warn("pending-queue: failed to remove persisted entry", err);
      return undefined;
    }
  }

  async claimNext(
    owner: string,
    leaseMs = 30_000,
    processorStaleMs = leaseMs,
  ): Promise<PendingEntry | undefined> {
    const identityKey = this._getIdentityKey?.() ?? null;
    const claimed = (await (this._mutationFn
      ? this._mutationFn(SYS_PENDING_CLAIM_NEXT, {
          identityKey,
          owner,
          leaseMs,
          processorStaleMs,
        })
      : ((this._localClient as any).mutation(SYS_PENDING_CLAIM_NEXT, {
          identityKey,
          owner,
          leaseMs,
          processorStaleMs,
        }) as Promise<PendingEntry | null>))) as PendingEntry | null;

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
  async clear(): Promise<void> {
    this._entries = [];

    try {
      await (this._mutationFn
        ? this._mutationFn(SYS_PENDING_CLEAR, {
            identityKey: this._getIdentityKey?.() ?? null,
          })
        : ((this._localClient as any).mutation(SYS_PENDING_CLEAR, {
            identityKey: this._getIdentityKey?.() ?? null,
          }) as Promise<unknown>));
    } catch (err) {
      log.warn("pending-queue: failed to clear persisted entries", err);
    }
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

  private _collapseTransientCreateDelete(
    candidate: {
      ref: string;
      args: string;
      localResult: string;
      table: string;
      identityKey: string | null;
    },
    localResult: unknown,
  ): Promise<void> | null {
    if (!candidate.ref.endsWith(":remove")) {
      return null;
    }

    const candidateId = this._extractMutationTargetId(candidate.args);
    if (candidateId === null) {
      return null;
    }

    const matchingEntries = this._entries.filter((entry) => {
      if (entry.table !== candidate.table) {
        return false;
      }
      if ((entry.identityKey ?? null) !== candidate.identityKey) {
        return false;
      }
      return this._extractEntryLogicalId(entry) === candidateId;
    });

    const hasCreate = matchingEntries.some((entry) =>
      entry.ref.endsWith(":create"),
    );
    if (!hasCreate) {
      return null;
    }

    return Promise.all(matchingEntries.map((entry) => this.remove(entry))).then(
      () => {
        log.debug(
          `pending-queue: collapsed transient create/delete pair (table: ${candidate.table}, queue size: ${this._entries.length})`,
          { localResult },
        );
      },
    );
  }

  private _extractEntryLogicalId(entry: PendingEntry): string | null {
    if (entry.ref.endsWith(":create")) {
      try {
        const parsed = JSON.parse(entry.localResult) as unknown;
        return typeof parsed === "string" ? parsed : null;
      } catch {
        return null;
      }
    }

    return this._extractMutationTargetId(entry.args);
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
