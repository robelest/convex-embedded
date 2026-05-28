import type { PendingEntry } from "@/client/pending/queue";
import { createLogger } from "@/shared/logger";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

const MAX_BUFFERED_SNAPSHOT_RETRIES = 8;
const BUFFERED_SNAPSHOT_RETRY_BASE_MS = 25;
const BUFFERED_SNAPSHOT_RETRY_MAX_MS = 1000;

export interface ScopeRecord {
  tableName: string;
  scopeArgs: Record<string, unknown>;

  unsubscribe?: () => void;
  pendingActivation?: Promise<void>;
  readers?: Set<string>;
  teardownTimer?: ReturnType<typeof setTimeout>;

  bufferedSnapshot?: Array<Record<string, unknown>>;
  retryCount?: number;
}

export interface SubscriptionsRefs {
  orderedTables: string[];
  canonicalizeScopeArgs: (
    scopeArgs?: Record<string, unknown>,
  ) => Record<string, unknown>;
  buildScopeKey: (
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ) => string;
  projectRemoteSnapshot: (input: {
    localDocs: Array<Record<string, unknown>>;
    remoteDocs: Array<Record<string, unknown>>;
    pendingEntries: readonly PendingEntry[];
    recentlyReplayedIds: ReadonlySet<string>;
    tableName: string;
    getAliases: (id: string) => Set<string>;
  }) => Array<Record<string, unknown>>;
  getDocumentsForTable: (
    tableName: string,
  ) => Promise<Array<Record<string, unknown>>>;
  filterAfterHydratingReferences: (input: {
    docs: Array<Record<string, unknown>>;
    tableName: string;
  }) => Promise<{
    accepted: Array<Record<string, unknown>>;
    skipped: Array<Record<string, unknown>>;
  }>;
  ingestDocuments: (
    tableName: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ) => Promise<void>;
  runSpan: <T>(input: {
    name: string;
    attributes?: Record<string, string | number | boolean | null | undefined>;
    run: () => Promise<T> | T;
  }) => Promise<T>;
  yieldToEventLoop: () => Promise<void>;
  getRecentlyReplayedIdSet: () => ReadonlySet<string>;
  getPendingEntries: () => readonly PendingEntry[];
  getAliases: (id: string) => Set<string>;
  clearPullSequencing: () => void;
}

export interface SubscriptionsSubsystem {
  get(scopeKey: string): ScopeRecord | undefined;
  set(
    scopeKey: string,
    partial: Partial<ScopeRecord> & {
      tableName?: string;
      scopeArgs?: Record<string, unknown>;
    },
  ): ScopeRecord;
  deleteScope(scopeKey: string): boolean;
  scopes(): ReadonlyMap<string, ScopeRecord>;
  hasActive(): boolean;
  bumpEpoch(): number;
  getEpoch(): number;
  setTeardownTimer(
    scopeKey: string,
    timer: ReturnType<typeof setTimeout>,
  ): void;
  clearTeardownTimer(scopeKey: string): void;
  clearAllTeardownTimers(): void;
  addReader(scopeKey: string, readKey: string): void;
  removeReader(scopeKey: string, readKey: string): number;
  markPulled(scopeKey: string): void;
  isPulled(scopeKey: string): boolean;
  clearPulled(scopeKey: string): void;
  onPulled(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    cb: () => void,
  ): () => void;
  resetPulled(): void;
  bufferRemoteSnapshot(
    tableName: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ): void;
  softResetBuffers(): void;
  clearAll(): void;
}

export function createSubscriptions(
  refs: SubscriptionsRefs,
): SubscriptionsSubsystem {
  const {
    orderedTables,
    canonicalizeScopeArgs,
    buildScopeKey,
    projectRemoteSnapshot,
    getDocumentsForTable,
    filterAfterHydratingReferences,
    ingestDocuments,
    runSpan,
    yieldToEventLoop,
    getRecentlyReplayedIdSet,
    getPendingEntries,
    getAliases,
    clearPullSequencing,
  } = refs;

  const scopesMap = new Map<string, ScopeRecord>();
  const pulledScopes = new Set<string>();
  const pullListeners = new Map<string, Set<() => void>>();
  let activationEpoch = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function get(scopeKey: string): ScopeRecord | undefined {
    return scopesMap.get(scopeKey);
  }

  function set(
    scopeKey: string,
    partial: Partial<ScopeRecord> & {
      tableName?: string;
      scopeArgs?: Record<string, unknown>;
    },
  ): ScopeRecord {
    const existing = scopesMap.get(scopeKey);
    if (existing) {
      Object.assign(existing, partial);
      return existing;
    }
    if (partial.tableName === undefined || partial.scopeArgs === undefined) {
      throw new Error(
        `[convex-embedded] subscriptions.set: cannot create ScopeRecord for "${scopeKey}" without tableName + scopeArgs`,
      );
    }
    const record: ScopeRecord = {
      tableName: partial.tableName,
      scopeArgs: partial.scopeArgs,
      ...partial,
    };
    scopesMap.set(scopeKey, record);
    return record;
  }

  function deleteScope(scopeKey: string): boolean {
    return scopesMap.delete(scopeKey);
  }

  function scopes(): ReadonlyMap<string, ScopeRecord> {
    return scopesMap;
  }

  function hasActive(): boolean {
    return scopesMap.size > 0;
  }

  function bumpEpoch(): number {
    activationEpoch += 1;
    return activationEpoch;
  }

  function getEpoch(): number {
    return activationEpoch;
  }

  function setTeardownTimer(
    scopeKey: string,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    const record = scopesMap.get(scopeKey);
    if (!record) return;
    if (record.teardownTimer !== undefined) {
      clearTimeout(record.teardownTimer);
    }
    record.teardownTimer = timer;
  }

  function clearTeardownTimer(scopeKey: string): void {
    const record = scopesMap.get(scopeKey);
    if (!record || record.teardownTimer === undefined) return;
    clearTimeout(record.teardownTimer);
    record.teardownTimer = undefined;
  }

  function clearAllTeardownTimers(): void {
    for (const record of scopesMap.values()) {
      if (record.teardownTimer !== undefined) {
        clearTimeout(record.teardownTimer);
        record.teardownTimer = undefined;
      }
    }
  }

  function addReader(scopeKey: string, readKey: string): void {
    const record = scopesMap.get(scopeKey);
    if (!record) return;
    (record.readers ??= new Set<string>()).add(readKey);
  }

  function removeReader(scopeKey: string, readKey: string): number {
    const record = scopesMap.get(scopeKey);
    if (!record || !record.readers) return 0;
    record.readers.delete(readKey);
    return record.readers.size;
  }

  function markPulled(scopeKey: string): void {
    if (pulledScopes.has(scopeKey)) return;
    pulledScopes.add(scopeKey);
    const listeners = pullListeners.get(scopeKey);
    if (!listeners) return;
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        log.warn("sync: scope-pulled listener failed", err);
      }
    }
  }

  function isPulled(scopeKey: string): boolean {
    return pulledScopes.has(scopeKey);
  }

  function clearPulled(scopeKey: string): void {
    pulledScopes.delete(scopeKey);
  }

  function onPulled(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    cb: () => void,
  ): () => void {
    const normalized = canonicalizeScopeArgs(scopeArgs);
    const scopeKey = buildScopeKey(tableName, normalized);
    let listeners = pullListeners.get(scopeKey);
    if (!listeners) {
      listeners = new Set();
      pullListeners.set(scopeKey, listeners);
    }
    listeners.add(cb);
    if (pulledScopes.has(scopeKey)) {
      try {
        cb();
      } catch (err) {
        log.warn("sync: scope-pulled listener failed", err);
      }
    }
    return () => {
      const current = pullListeners.get(scopeKey);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) {
        pullListeners.delete(scopeKey);
      }
    };
  }

  function resetPulled(): void {
    pulledScopes.clear();
    pullListeners.clear();
  }

  function bufferRemoteSnapshot(
    tableName: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ): void {
    const normalized = canonicalizeScopeArgs(scopeArgs);
    const scopeKey = buildScopeKey(tableName, normalized);
    let record = scopesMap.get(scopeKey);
    if (!record) {
      record = { tableName, scopeArgs: normalized };
      scopesMap.set(scopeKey, record);
    }
    record.bufferedSnapshot = docs;
    record.retryCount = 0;
    scheduleFlush();
  }

  function scheduleFlush(delayMs = 0): void {
    if (delayMs > 0) {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushAll();
      }, delayMs);
      return;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    runDetached(() => flushAll(), "[sync] flush buffered:");
  }

  async function flushAll(): Promise<void> {
    const bufferedTables = new Set<string>();
    for (const record of scopesMap.values()) {
      if (record.bufferedSnapshot !== undefined) {
        bufferedTables.add(record.tableName);
      }
    }
    const flushOrder = [
      ...orderedTables.filter((t) => bufferedTables.has(t)),
      ...Array.from(bufferedTables).filter((t) => !orderedTables.includes(t)),
    ];
    for (const tableName of flushOrder) {
      const scopeKeys: string[] = [];
      for (const [key, record] of scopesMap) {
        if (
          record.tableName === tableName &&
          record.bufferedSnapshot !== undefined
        ) {
          scopeKeys.push(key);
        }
      }
      for (const scopeKey of scopeKeys) {
        await flushScope(scopeKey);
        await yieldToEventLoop();
      }
    }
  }

  async function flushScope(scopeKey: string): Promise<void> {
    const record = scopesMap.get(scopeKey);
    if (!record) return;
    if (record.bufferedSnapshot === undefined) return;
    const snapshot = record.bufferedSnapshot;
    record.bufferedSnapshot = undefined;
    const { scopeArgs, tableName } = record;

    const projected = projectRemoteSnapshot({
      localDocs: await getDocumentsForTable(tableName),
      remoteDocs: snapshot,
      pendingEntries: getPendingEntries(),
      recentlyReplayedIds: getRecentlyReplayedIdSet(),
      tableName,
      getAliases: (id) => getAliases(id),
    });
    const { accepted, skipped } = await filterAfterHydratingReferences({
      docs: projected,
      tableName,
    });

    try {
      if (accepted.length > 0) {
        await runSpan({
          name: "convex_embedded.remote.buffered_snapshot.ingest",
          attributes: {
            table: tableName,
            accepted_count: accepted.length,
            projected_count: projected.length,
          },
          run: () =>
            ingestDocuments(
              tableName,
              accepted,
              Object.keys(scopeArgs).length > 0 ? scopeArgs : undefined,
            ),
        });
      }

      if (skipped.length > 0) {
        const retryCount = record.retryCount ?? 0;
        await runSpan({
          name: "convex_embedded.remote.buffered_snapshot.defer",
          attributes: {
            table: tableName,
            accepted_count: accepted.length,
            skipped_count: skipped.length,
            retry_count: retryCount,
          },
          run: async () => undefined,
        });
        record.bufferedSnapshot = skipped;
        if (retryCount >= MAX_BUFFERED_SNAPSHOT_RETRIES) {
          log.error(
            `sync: giving up buffered snapshot ingest for "${tableName}" after ${retryCount} retries due to unresolved references`,
          );
          return;
        }
        record.retryCount = retryCount + 1;
        const delayMs = Math.min(
          BUFFERED_SNAPSHOT_RETRY_BASE_MS * 2 ** retryCount,
          BUFFERED_SNAPSHOT_RETRY_MAX_MS,
        );
        scheduleFlush(delayMs);
        log.warn(
          `sync: deferred ${skipped.length} "${tableName}" snapshot doc(s) with unresolved references`,
        );
        return;
      }

      record.retryCount = 0;
    } catch (error) {
      record.bufferedSnapshot = snapshot;
      const retryCount = record.retryCount ?? 0;

      if (retryCount >= MAX_BUFFERED_SNAPSHOT_RETRIES) {
        log.error(
          `sync: giving up buffered snapshot ingest for "${tableName}" after ${retryCount} retries`,
          error,
        );
        return;
      }

      record.retryCount = retryCount + 1;
      const delayMs = Math.min(
        BUFFERED_SNAPSHOT_RETRY_BASE_MS * 2 ** retryCount,
        BUFFERED_SNAPSHOT_RETRY_MAX_MS,
      );
      scheduleFlush(delayMs);
      log.warn(
        `sync: delayed buffered snapshot ingest for "${tableName}" (retry ${record.retryCount}/${MAX_BUFFERED_SNAPSHOT_RETRIES})`,
        error,
      );
      return;
    }

    if (record.bufferedSnapshot !== undefined && flushTimer === null) {
      scheduleFlush();
    }
  }

  function softResetBuffers(): void {
    for (const record of scopesMap.values()) {
      record.bufferedSnapshot = undefined;
    }
  }

  function clearAll(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const record of scopesMap.values()) {
      record.bufferedSnapshot = undefined;
      record.retryCount = 0;
    }
    clearPullSequencing();
  }

  return {
    get,
    set,
    deleteScope,
    scopes,
    hasActive,
    bumpEpoch,
    getEpoch,
    setTeardownTimer,
    clearTeardownTimer,
    clearAllTeardownTimers,
    addReader,
    removeReader,
    markPulled,
    isPulled,
    clearPulled,
    onPulled,
    resetPulled,
    bufferRemoteSnapshot,
    softResetBuffers,
    clearAll,
  };
}
