import type { ConvexClient } from "convex/browser";

import { createLogger } from "@/shared/logger";

const log = createLogger("pending-uploads");

const SYS_PUSH = "_system:pendingUploadPush";
const SYS_GET_ALL = "_system:pendingUploadGetAll";
const SYS_CLAIM_NEXT = "_system:pendingUploadClaimNext";
const SYS_RENEW_LEASE = "_system:pendingUploadRenewLease";
const SYS_REMOVE = "_system:pendingUploadRemove";
const SYS_RELEASE = "_system:pendingUploadRelease";

/**
 * One blob waiting to be uploaded to the remote Convex deployment.
 * Persisted in `_resolve_pending_uploads`; the engine drains the queue
 * on reconnect, calls `generateUploadUrl` + PUTs the blob, records
 * the local→remote ID translation in {@link IdMap}, then removes the
 * row.
 *
 * @public
 */
export interface PendingUploadEntry {
  _id: string;
  /** The local storage id returned to user code from `ctx.storage.store()`. */
  localStorageId: string;
  sha256: string;
  size: number;
  contentType: string;
  identityKey?: string | null;
  state?: "pending" | "processing";
  /** Processor id holding the lease while uploading. */
  owner?: string;
  processingStartedAt?: number;
  leaseExpiresAt?: number;
  createdAt?: number;
  /** True when this entry was loaded from storage during hydrate. */
  hydrated?: boolean;
}

import type {
  LocalQueryExecutorFn,
  LocalMutationExecutorFn,
} from "@/client/ids";

export type {
  LocalQueryExecutorFn,
  LocalMutationExecutorFn,
} from "@/client/ids";

/**
 * Persistent queue of `ctx.storage.store(blob)` calls that still need to be
 * uploaded to the remote Convex deployment. Mirrors {@link PendingQueue}
 * but for blobs.
 */
export class PendingUploadQueue {
  private _entries: PendingUploadEntry[] = [];

  constructor(
    private readonly _localClient: ConvexClient,
    private readonly _queryFn: LocalQueryExecutorFn | null = null,
    private readonly _mutationFn: LocalMutationExecutorFn | null = null,
    private readonly _getIdentityKey: (() => string | null) | null = null,
  ) {}

  get length(): number {
    return this._entries.length;
  }

  entries(): readonly PendingUploadEntry[] {
    return this._entries;
  }

  async hydrate(): Promise<void> {
    const identityKey = this._getIdentityKey?.() ?? null;
    try {
      const rows = await this._runQuery(SYS_GET_ALL, { identityKey });
      this._entries = (rows as PendingUploadEntry[]).map((row) => ({
        ...row,
        hydrated: true,
      }));
      log.info(
        `pending-uploads: hydrated ${this._entries.length} entry/entries`,
      );
    } catch (err) {
      log.warn("pending-uploads: hydration failed", err);
    }
  }

  async push(input: {
    localStorageId: string;
    sha256: string;
    size: number;
    contentType: string;
  }): Promise<void> {
    if (this._entries.some((e) => e.localStorageId === input.localStorageId)) {
      return;
    }
    const identityKey = this._getIdentityKey?.() ?? null;
    const serialized = {
      localStorageId: input.localStorageId,
      sha256: input.sha256,
      size: input.size,
      contentType: input.contentType,
      identityKey,
    };
    try {
      const id = (await this._runMutation(SYS_PUSH, serialized)) as string;
      this._entries.push({
        _id: id,
        ...serialized,
        state: "pending",
      });
      log.debug(
        `pending-uploads: pushed (storageId: ${input.localStorageId}, queue: ${this._entries.length})`,
      );
    } catch (err) {
      log.warn(
        `pending-uploads: failed to persist (storageId: ${input.localStorageId}); queueing in-memory`,
        err,
      );
      this._entries.push({
        _id: `ephemeral_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        ...serialized,
        state: "pending",
      });
    }
  }

  async claimNext(
    owner: string,
    leaseMs = 30_000,
    processorStaleMs = leaseMs,
  ): Promise<PendingUploadEntry | undefined> {
    const identityKey = this._getIdentityKey?.() ?? null;
    const claimed = (await this._runMutation(SYS_CLAIM_NEXT, {
      identityKey,
      owner,
      leaseMs,
      processorStaleMs,
    })) as PendingUploadEntry | null;
    if (!claimed) return undefined;
    const idx = this._entries.findIndex((e) => e._id === claimed._id);
    if (idx >= 0) {
      Object.assign(this._entries[idx]!, claimed);
      return this._entries[idx];
    }
    this._entries.push(claimed);
    return claimed;
  }

  async renewLease(
    entry: PendingUploadEntry,
    owner: string,
    leaseMs = 30_000,
  ): Promise<boolean> {
    entry.owner = owner;
    entry.leaseExpiresAt = Date.now() + leaseMs;
    if (entry._id.startsWith("ephemeral_")) return true;
    const renewed = (await this._runMutation(SYS_RENEW_LEASE, {
      id: entry._id,
      owner,
      leaseMs,
    })) as boolean | null;
    if (!renewed) {
      await this.hydrate();
      return false;
    }
    return true;
  }

  async remove(entry: PendingUploadEntry, owner?: string): Promise<void> {
    const idx = this._entries.findIndex((e) => e._id === entry._id);
    if (idx >= 0) this._entries.splice(idx, 1);
    if (entry._id.startsWith("ephemeral_")) return;
    try {
      await this._runMutation(SYS_REMOVE, {
        id: entry._id,
        ...(owner !== undefined ? { owner } : {}),
      });
    } catch (err) {
      log.warn("pending-uploads: failed to remove persisted entry", err);
    }
  }

  async release(entry: PendingUploadEntry, owner?: string): Promise<void> {
    entry.state = "pending";
    delete entry.owner;
    delete entry.processingStartedAt;
    delete entry.leaseExpiresAt;
    if (entry._id.startsWith("ephemeral_")) return;
    try {
      await this._runMutation(SYS_RELEASE, {
        id: entry._id,
        ...(owner !== undefined ? { owner } : {}),
      });
    } catch (err) {
      log.warn("pending-uploads: failed to release persisted entry", err);
    }
  }

  private _runQuery(path: string, args: Record<string, unknown>) {
    return (
      this._queryFn?.(path, args) ??
      ((this._localClient as any).query(path, args) as Promise<unknown>)
    );
  }

  private _runMutation(path: string, args: Record<string, unknown>) {
    return (
      this._mutationFn?.(path, args) ??
      ((this._localClient as any).mutation(path, args) as Promise<unknown>)
    );
  }
}
