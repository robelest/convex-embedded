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
  flushScheduled?: boolean;
  retryCount?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  epoch?: number;
}

export interface SubscriptionsState {
  scopes: Map<string, ScopeRecord>;
  pulledScopes: Set<string>;
  pullListeners: Map<string, Set<() => void>>;
  activationEpoch: number;
  flushScheduled: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

export interface SubscriptionsDeps {
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

export function createSubscriptionsState(): SubscriptionsState {
  return {
    scopes: new Map(),
    pulledScopes: new Set(),
    pullListeners: new Map(),
    activationEpoch: 0,
    flushScheduled: false,
    flushTimer: null,
  };
}

export function get(
  state: SubscriptionsState,
  scopeKey: string,
): ScopeRecord | undefined {
  return state.scopes.get(scopeKey);
}

export function set(
  state: SubscriptionsState,
  scopeKey: string,
  partial: Partial<ScopeRecord> & {
    tableName?: string;
    scopeArgs?: Record<string, unknown>;
  },
): ScopeRecord {
  const existing = state.scopes.get(scopeKey);
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
  state.scopes.set(scopeKey, record);
  return record;
}

export function deleteScope(
  state: SubscriptionsState,
  scopeKey: string,
): boolean {
  return state.scopes.delete(scopeKey);
}

export function scopes(
  state: SubscriptionsState,
): ReadonlyMap<string, ScopeRecord> {
  return state.scopes;
}

export function hasActive(state: SubscriptionsState): boolean {
  return state.scopes.size > 0;
}

export function bumpEpoch(state: SubscriptionsState): number {
  state.activationEpoch += 1;
  return state.activationEpoch;
}

export function getEpoch(state: SubscriptionsState): number {
  return state.activationEpoch;
}

export function setTeardownTimer(
  state: SubscriptionsState,
  scopeKey: string,
  timer: ReturnType<typeof setTimeout>,
): void {
  const record = state.scopes.get(scopeKey);
  if (!record) return;
  if (record.teardownTimer !== undefined) {
    clearTimeout(record.teardownTimer);
  }
  record.teardownTimer = timer;
}

export function clearTeardownTimer(
  state: SubscriptionsState,
  scopeKey: string,
): void {
  const record = state.scopes.get(scopeKey);
  if (!record || record.teardownTimer === undefined) return;
  clearTimeout(record.teardownTimer);
  record.teardownTimer = undefined;
}

export function getTeardownTimer(
  state: SubscriptionsState,
  scopeKey: string,
): ReturnType<typeof setTimeout> | undefined {
  return state.scopes.get(scopeKey)?.teardownTimer;
}

export function clearAllTeardownTimers(state: SubscriptionsState): void {
  for (const record of state.scopes.values()) {
    if (record.teardownTimer !== undefined) {
      clearTimeout(record.teardownTimer);
      record.teardownTimer = undefined;
    }
  }
}

export function addReader(
  state: SubscriptionsState,
  scopeKey: string,
  readKey: string,
): void {
  const record = state.scopes.get(scopeKey);
  if (!record) return;
  (record.readers ??= new Set<string>()).add(readKey);
}

export function removeReader(
  state: SubscriptionsState,
  scopeKey: string,
  readKey: string,
): number {
  const record = state.scopes.get(scopeKey);
  if (!record || !record.readers) return 0;
  record.readers.delete(readKey);
  return record.readers.size;
}

export function markPulled(state: SubscriptionsState, scopeKey: string): void {
  if (state.pulledScopes.has(scopeKey)) return;
  state.pulledScopes.add(scopeKey);
  const listeners = state.pullListeners.get(scopeKey);
  if (!listeners) return;
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      log.warn("sync: scope-pulled listener failed", err);
    }
  }
}

export function isPulled(state: SubscriptionsState, scopeKey: string): boolean {
  return state.pulledScopes.has(scopeKey);
}

export function clearPulled(state: SubscriptionsState, scopeKey: string): void {
  state.pulledScopes.delete(scopeKey);
}

export function onPulled(
  state: SubscriptionsState,
  deps: SubscriptionsDeps,
  tableName: string,
  scopeArgs: Record<string, unknown> | undefined,
  cb: () => void,
): () => void {
  const normalized = deps.canonicalizeScopeArgs(scopeArgs);
  const scopeKey = deps.buildScopeKey(tableName, normalized);
  let listeners = state.pullListeners.get(scopeKey);
  if (!listeners) {
    listeners = new Set();
    state.pullListeners.set(scopeKey, listeners);
  }
  listeners.add(cb);
  if (state.pulledScopes.has(scopeKey)) {
    try {
      cb();
    } catch (err) {
      log.warn("sync: scope-pulled listener failed", err);
    }
  }
  return () => {
    const set = state.pullListeners.get(scopeKey);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) {
      state.pullListeners.delete(scopeKey);
    }
  };
}

export function resetPulled(state: SubscriptionsState): void {
  state.pulledScopes.clear();
  state.pullListeners.clear();
}

export function bufferRemoteSnapshot(
  state: SubscriptionsState,
  deps: SubscriptionsDeps,
  tableName: string,
  docs: Array<Record<string, unknown>>,
  scopeArgs?: Record<string, unknown>,
): void {
  const normalized = deps.canonicalizeScopeArgs(scopeArgs);
  const scopeKey = deps.buildScopeKey(tableName, normalized);
  let record = state.scopes.get(scopeKey);
  if (!record) {
    record = {
      tableName,
      scopeArgs: normalized,
    };
    state.scopes.set(scopeKey, record);
  }
  record.bufferedSnapshot = docs;
  record.retryCount = 0;
  scheduleFlush(state, deps);
}

export function scheduleFlush(
  state: SubscriptionsState,
  deps: SubscriptionsDeps,
  delayMs = 0,
): void {
  if (delayMs > 0) {
    if (state.flushScheduled) return;
    state.flushScheduled = true;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void flushAll(state, deps);
    }, delayMs);
    return;
  }
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
    state.flushScheduled = false;
  }
  if (state.flushScheduled) return;
  state.flushScheduled = true;
  runDetached(() => flushAll(state, deps), "[sync] flush buffered:");
}

export async function flushAll(
  state: SubscriptionsState,
  deps: SubscriptionsDeps,
): Promise<void> {
  state.flushScheduled = false;
  const bufferedTables = new Set<string>();
  for (const record of state.scopes.values()) {
    if (record.bufferedSnapshot !== undefined) {
      bufferedTables.add(record.tableName);
    }
  }
  const flushOrder = [
    ...deps.orderedTables.filter((t) => bufferedTables.has(t)),
    ...Array.from(bufferedTables).filter(
      (t) => !deps.orderedTables.includes(t),
    ),
  ];
  for (const tableName of flushOrder) {
    const scopeKeys: string[] = [];
    for (const [key, record] of state.scopes) {
      if (
        record.tableName === tableName &&
        record.bufferedSnapshot !== undefined
      ) {
        scopeKeys.push(key);
      }
    }
    for (const scopeKey of scopeKeys) {
      await flushScope(state, deps, scopeKey);
      await deps.yieldToEventLoop();
    }
  }
}

export async function flushScope(
  state: SubscriptionsState,
  deps: SubscriptionsDeps,
  scopeKey: string,
): Promise<void> {
  const record = state.scopes.get(scopeKey);
  if (!record) return;
  if (record.bufferedSnapshot === undefined) {
    record.flushScheduled = false;
    return;
  }
  const snapshot = record.bufferedSnapshot;
  record.bufferedSnapshot = undefined;
  record.flushScheduled = false;
  const { scopeArgs, tableName } = record;

  const projected = deps.projectRemoteSnapshot({
    localDocs: await deps.getDocumentsForTable(tableName),
    remoteDocs: snapshot,
    pendingEntries: deps.getPendingEntries(),
    recentlyReplayedIds: deps.getRecentlyReplayedIdSet(),
    tableName,
    getAliases: (id) => deps.getAliases(id),
  });
  const { accepted, skipped } = await deps.filterAfterHydratingReferences({
    docs: projected,
    tableName,
  });

  try {
    if (accepted.length > 0) {
      await deps.runSpan({
        name: "convex_embedded.remote.buffered_snapshot.ingest",
        attributes: {
          table: tableName,
          accepted_count: accepted.length,
          projected_count: projected.length,
        },
        run: () =>
          deps.ingestDocuments(
            tableName,
            accepted,
            Object.keys(scopeArgs).length > 0 ? scopeArgs : undefined,
          ),
      });
    }

    if (skipped.length > 0) {
      const retryCount = record.retryCount ?? 0;
      await deps.runSpan({
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
      record.flushScheduled = false;
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
      scheduleFlush(state, deps, delayMs);
      log.warn(
        `sync: deferred ${skipped.length} "${tableName}" snapshot doc(s) with unresolved references`,
      );
      return;
    }

    record.retryCount = 0;
  } catch (error) {
    record.bufferedSnapshot = snapshot;
    record.flushScheduled = false;
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
    scheduleFlush(state, deps, delayMs);
    log.warn(
      `sync: delayed buffered snapshot ingest for "${tableName}" (retry ${record.retryCount}/${MAX_BUFFERED_SNAPSHOT_RETRIES})`,
      error,
    );
    return;
  }

  if (record.bufferedSnapshot !== undefined && !record.flushScheduled) {
    scheduleFlush(state, deps);
  }
}

export function softResetBuffers(state: SubscriptionsState): void {
  for (const record of state.scopes.values()) {
    record.bufferedSnapshot = undefined;
  }
}

export function clearAll(
  state: SubscriptionsState,
  deps: SubscriptionsDeps,
): void {
  state.flushScheduled = false;
  if (state.flushTimer !== null) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  for (const record of state.scopes.values()) {
    if (record.retryTimer !== undefined) {
      clearTimeout(record.retryTimer);
      record.retryTimer = undefined;
    }
    record.bufferedSnapshot = undefined;
    record.flushScheduled = false;
    record.retryCount = 0;
  }
  deps.clearPullSequencing();
}
