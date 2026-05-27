import type { PendingEntry } from "@/client/pending/queue";
import { createLogger } from "@/shared/logger";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

const MAX_BUFFERED_SNAPSHOT_RETRIES = 8;
const BUFFERED_SNAPSHOT_RETRY_BASE_MS = 25;
const BUFFERED_SNAPSHOT_RETRY_MAX_MS = 1000;

export type TableRemoteSyncState = {
  tableName: string;
  scopeArgs: Record<string, unknown>;
  bufferedSnapshot: Array<Record<string, unknown>> | null;
  flushScheduled: boolean;
  epoch: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
};

export interface SnapshotIngestDeps {
  orderedTables: string[];
  canonicalizeScopeArgs: (
    scopeArgs?: Record<string, unknown>,
  ) => Record<string, unknown>;
  buildScopeKey: (
    tableName: string,
    scopeArgs: Record<string, unknown>,
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
}

export interface SnapshotIngestRuntime {
  /** Recent replay IDs to suppress in the projected snapshot. */
  getRecentlyReplayedIdSet: () => ReadonlySet<string>;
  getPendingEntries: () => readonly PendingEntry[];
  getAliases: (id: string) => Set<string>;
  /** Pull batch coordinator's clearAll, called from clearAll() teardown. */
  clearPullBatch: () => void;
}

/**
 * Owns the per-scope buffered-snapshot retry state for remote subscriptions
 * and the global flush scheduler.
 *
 * The engine's remote-bind callbacks call `bufferRemoteSnapshot(...)` when
 * a fresh snapshot arrives. The flusher walks the buffered scopes in the
 * canonical table order, projects each one against pending local writes,
 * filters by ID-translation readiness, and ingests via the embedded
 * runtime. On filter/ingest errors it backs off with exponential delay up
 * to `MAX_BUFFERED_SNAPSHOT_RETRIES`.
 */
export class SnapshotIngest {
  private readonly states = new Map<string, TableRemoteSyncState>();
  private flushScheduled = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: SnapshotIngestDeps;
  private readonly runtime: SnapshotIngestRuntime;

  constructor(deps: SnapshotIngestDeps, runtime: SnapshotIngestRuntime) {
    this.deps = deps;
    this.runtime = runtime;
  }

  /**
   * Get-or-create the per-scope state entry. Used by external callers
   * (Scope subsystem) that need to track an active subscription's epoch.
   */
  getTableReplicationState(
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ): TableRemoteSyncState {
    const normalizedScope = this.deps.canonicalizeScopeArgs(scopeArgs);
    const scopeKey = this.deps.buildScopeKey(tableName, normalizedScope);
    let state = this.states.get(scopeKey);
    if (!state) {
      state = {
        tableName,
        scopeArgs: normalizedScope,
        bufferedSnapshot: null,
        flushScheduled: false,
        epoch: 0,
        retryTimer: null,
        retryCount: 0,
      };
      this.states.set(scopeKey, state);
    }
    return state;
  }

  async bufferRemoteSnapshot(
    tableName: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    const state = this.getTableReplicationState(tableName, scopeArgs);
    state.bufferedSnapshot = docs;
    state.retryCount = 0;
    this.scheduleFlush();
  }

  scheduleFlush(delayMs = 0): void {
    if (delayMs > 0) {
      if (this.flushScheduled) return;
      this.flushScheduled = true;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushAll();
      }, delayMs);
      return;
    }
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.flushScheduled = false;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    runDetached(() => this.flushAll(), "[sync] flush buffered:");
  }

  async flushAll(): Promise<void> {
    this.flushScheduled = false;
    const bufferedTables = new Set(
      Array.from(this.states.values()).map((state) => state.tableName),
    );
    const flushOrder = [
      ...this.deps.orderedTables.filter((t) => bufferedTables.has(t)),
      ...Array.from(bufferedTables).filter(
        (t) => !this.deps.orderedTables.includes(t),
      ),
    ];
    for (const tableName of flushOrder) {
      const scopeKeys = Array.from(this.states.entries())
        .filter(([, state]) => state.tableName === tableName)
        .map(([scopeKey]) => scopeKey);
      for (const scopeKey of scopeKeys) {
        await this.flushScope(scopeKey);
        await this.deps.yieldToEventLoop();
      }
    }
  }

  async flushScope(scopeKey: string): Promise<void> {
    const state = this.states.get(scopeKey);
    if (!state) return;
    if (state.bufferedSnapshot === null) {
      state.flushScheduled = false;
      return;
    }
    const snapshot = state.bufferedSnapshot;
    state.bufferedSnapshot = null;
    state.flushScheduled = false;
    const { scopeArgs, tableName } = state;

    const projected = this.deps.projectRemoteSnapshot({
      localDocs: await this.deps.getDocumentsForTable(tableName),
      remoteDocs: snapshot,
      pendingEntries: this.runtime.getPendingEntries(),
      recentlyReplayedIds: this.runtime.getRecentlyReplayedIdSet(),
      tableName,
      getAliases: (id) => this.runtime.getAliases(id),
    });
    const { accepted, skipped } =
      await this.deps.filterAfterHydratingReferences({
        docs: projected,
        tableName,
      });
    try {
      if (accepted.length > 0) {
        await this.deps.runSpan({
          name: "convex_embedded.remote.buffered_snapshot.ingest",
          attributes: {
            table: tableName,
            accepted_count: accepted.length,
            projected_count: projected.length,
          },
          run: () =>
            this.deps.ingestDocuments(
              tableName,
              accepted,
              Object.keys(scopeArgs).length > 0 ? scopeArgs : undefined,
            ),
        });
      }

      if (skipped.length > 0) {
        await this.deps.runSpan({
          name: "convex_embedded.remote.buffered_snapshot.defer",
          attributes: {
            table: tableName,
            accepted_count: accepted.length,
            skipped_count: skipped.length,
            retry_count: state.retryCount,
          },
          run: async () => undefined,
        });
        state.bufferedSnapshot = skipped;
        state.flushScheduled = false;
        if (state.retryCount >= MAX_BUFFERED_SNAPSHOT_RETRIES) {
          log.error(
            `sync: giving up buffered snapshot ingest for "${tableName}" after ${state.retryCount} retries due to unresolved references`,
          );
          return;
        }
        state.retryCount += 1;
        const delayMs = Math.min(
          BUFFERED_SNAPSHOT_RETRY_BASE_MS * 2 ** (state.retryCount - 1),
          BUFFERED_SNAPSHOT_RETRY_MAX_MS,
        );
        this.scheduleFlush(delayMs);
        log.warn(
          `sync: deferred ${skipped.length} "${tableName}" snapshot doc(s) with unresolved references`,
        );
        return;
      }

      state.retryCount = 0;
    } catch (error) {
      state.bufferedSnapshot = snapshot;
      state.flushScheduled = false;

      if (state.retryCount >= MAX_BUFFERED_SNAPSHOT_RETRIES) {
        log.error(
          `sync: giving up buffered snapshot ingest for "${tableName}" after ${state.retryCount} retries`,
          error,
        );
        return;
      }

      state.retryCount += 1;
      const delayMs = Math.min(
        BUFFERED_SNAPSHOT_RETRY_BASE_MS * 2 ** (state.retryCount - 1),
        BUFFERED_SNAPSHOT_RETRY_MAX_MS,
      );
      this.scheduleFlush(delayMs);
      log.warn(
        `sync: delayed buffered snapshot ingest for "${tableName}" (retry ${state.retryCount}/${MAX_BUFFERED_SNAPSHOT_RETRIES})`,
        error,
      );
      return;
    }

    if (state.bufferedSnapshot !== null && !state.flushScheduled) {
      this.scheduleFlush();
    }
  }

  /**
   * Clear in-flight buffers without dropping the state entries. Called
   * after a replay drain succeeds — the next remote snapshot is the
   * authoritative one.
   */
  softResetBuffers(): void {
    for (const state of this.states.values()) {
      state.bufferedSnapshot = null;
    }
  }

  /**
   * Full teardown: cancel timers, clear all buffered state, and also tell
   * the pull batch coordinator to drop its sequencing state (the two
   * subsystems' invariants are paired around the offline transition).
   */
  clearAll(): void {
    this.flushScheduled = false;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const state of this.states.values()) {
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
      }
      state.retryCount = 0;
    }
    this.states.clear();
    this.runtime.clearPullBatch();
  }
}
