import { createLogger } from "@/shared/logger";

const log = createLogger("resolve");

interface TableCoalesceEntry {
  signalSeqs: Set<number>;
  pendingThunks: Map<string, () => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Tracks pull-related sequencing and coalescing state for the engine:
 *
 * - `expectedSelfCausedSignals` — post-commit seqs we predicted from our own
 *   mutations; lets us skip the redundant remote bind that immediately
 *   echoes back the same write.
 * - `lastKnownCollectionSeqByTable` — highest seq we've observed via either
 *   a self-caused echo or a fired coalesce.
 * - `lastResolvedScopeSeq` — per-scope highest seq we've successfully
 *   resolved through; used to short-circuit redundant partial pulls.
 * - `tableCoalesceMap` — per-table debounce window for snapshot handlers.
 * - `pullInFlight` / `resolveRerun` — single-flight guard + rerun marker
 *   for `getTableSpec` invocations.
 *
 * All state is read/written from inside the engine's own subsystems
 * (Replay, ScopeManager, WorkScheduler) via the public methods below.
 */
export class PullBatchCoordinator {
  private readonly expectedSelfCausedSignals = new Map<string, number[]>();
  private readonly lastKnownCollectionSeqByTable = new Map<string, number>();
  private readonly lastResolvedScopeSeq = new Map<string, number>();
  private readonly pullInFlight = new Map<string, Promise<void>>();
  private readonly resolveRerun = new Set<string>();
  private readonly tableCoalesceMap = new Map<string, TableCoalesceEntry>();
  private readonly coalesceWindowMs: number;
  private readonly buildScopeKey: (
    tableName: string,
    scopeArgs: Record<string, unknown>,
  ) => string;

  constructor(deps: {
    buildScopeKey: (
      tableName: string,
      scopeArgs: Record<string, unknown>,
    ) => string;
    coalesceWindowMs?: number;
  }) {
    this.buildScopeKey = deps.buildScopeKey;
    this.coalesceWindowMs = deps.coalesceWindowMs ?? 32;
  }

  recordExpectedSelfCausedSignal(
    tableName: string,
    postCommitSeq: number,
  ): void {
    const existing = this.expectedSelfCausedSignals.get(tableName) ?? [];
    existing.push(postCommitSeq);
    existing.sort((a, b) => a - b);
    this.expectedSelfCausedSignals.set(tableName, existing);
  }

  nextExpectedSelfCausedSeq(tableName: string): number {
    const lastKnown = this.lastKnownCollectionSeqByTable.get(tableName) ?? -1;
    const pending = this.expectedSelfCausedSignals.get(tableName);
    const highestPending =
      pending && pending.length > 0 ? pending[pending.length - 1]! : -1;
    return Math.max(lastKnown, highestPending) + 1;
  }

  consumeExpectedSelfCausedSignal(
    tableName: string,
    signalSeq: number,
  ): boolean {
    const seqs = this.expectedSelfCausedSignals.get(tableName);
    if (!seqs || seqs.length === 0) return false;
    let bestIndex = -1;
    for (let i = seqs.length - 1; i >= 0; i--) {
      if (seqs[i]! <= signalSeq) {
        bestIndex = i;
        break;
      }
    }
    if (bestIndex < 0) return false;
    seqs.splice(bestIndex, 1);
    if (seqs.length === 0) {
      this.expectedSelfCausedSignals.delete(tableName);
    } else {
      this.expectedSelfCausedSignals.set(tableName, seqs);
    }
    if (signalSeq >= 0) {
      this.lastKnownCollectionSeqByTable.set(tableName, signalSeq);
    }
    log.debug(
      `sync: skipping self-caused bind for "${tableName}" (signalSeq=${signalSeq})`,
    );
    return true;
  }

  hasPendingSelfCausedSignal(tableName: string): boolean {
    const pending = this.expectedSelfCausedSignals.get(tableName);
    return pending !== undefined && pending.length > 0;
  }

  getLastKnownCollectionSeq(tableName: string): number | undefined {
    return this.lastKnownCollectionSeqByTable.get(tableName);
  }

  recordPulledScopeSeq(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    collectionSeq: number | null,
  ): void {
    if (collectionSeq === null) return;
    const scopeKey = this.buildScopeKey(tableName, scopeArgs ?? {});
    const prev = this.lastResolvedScopeSeq.get(scopeKey) ?? -Infinity;
    if (collectionSeq > prev) {
      this.lastResolvedScopeSeq.set(scopeKey, collectionSeq);
    }
  }

  hasResolvedScopeSeq(scopeKey: string): boolean {
    return this.lastResolvedScopeSeq.has(scopeKey);
  }

  shouldSkipRedundantPartialPull(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    signalSeq: number,
  ): boolean {
    if (signalSeq < 0) return false;
    const scopeKey = this.buildScopeKey(tableName, scopeArgs ?? {});
    const resolvedSeq = this.lastResolvedScopeSeq.get(scopeKey);
    if (resolvedSeq === undefined) return false;
    if (signalSeq <= resolvedSeq) {
      log.debug(
        `sync: skipping redundant partial resolve for "${tableName}" ` +
          `(signalSeq=${signalSeq} <= resolvedSeq=${resolvedSeq})`,
      );
      return true;
    }
    return false;
  }

  scheduleTableCoalesce(input: {
    tableName: string;
    scopeKey: string;
    signalSeq: number;
    runHandler: () => void;
  }): void {
    const { tableName, scopeKey, signalSeq, runHandler } = input;
    let entry = this.tableCoalesceMap.get(tableName);
    if (!entry) {
      entry = {
        signalSeqs: new Set(),
        pendingThunks: new Map(),
        timer: null,
      };
      this.tableCoalesceMap.set(tableName, entry);
    }
    if (signalSeq >= 0) {
      entry.signalSeqs.add(signalSeq);
    }
    entry.pendingThunks.set(scopeKey, runHandler);
    if (entry.timer === null) {
      entry.timer = setTimeout(() => {
        this.fireCoalescedTableUpdate(tableName);
      }, this.coalesceWindowMs);
    }
  }

  fireCoalescedTableUpdate(tableName: string): void {
    const entry = this.tableCoalesceMap.get(tableName);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pendingThunks.size === 0) {
      this.tableCoalesceMap.delete(tableName);
      return;
    }
    if (entry.signalSeqs.size > 0) {
      const highestSeq = Math.max(...Array.from(entry.signalSeqs));
      if (highestSeq >= 0) {
        this.lastKnownCollectionSeqByTable.set(tableName, highestSeq);
      }
    }
    const thunks = Array.from(entry.pendingThunks.values());
    this.tableCoalesceMap.delete(tableName);
    for (const thunk of thunks) {
      try {
        thunk();
      } catch (err) {
        log.warn(`sync: coalesced bind thunk for "${tableName}" failed`, err);
      }
    }
  }

  /** Single-flight guard for `getTableSpec`-style pull invocations. */
  pullInFlightGet(key: string): Promise<void> | undefined {
    return this.pullInFlight.get(key);
  }
  pullInFlightSet(key: string, promise: Promise<void>): void {
    this.pullInFlight.set(key, promise);
  }
  pullInFlightDelete(key: string): void {
    this.pullInFlight.delete(key);
  }

  /** Re-run marker set when a pull arrives mid-flight. */
  markRerun(key: string): void {
    this.resolveRerun.add(key);
  }
  takeRerun(key: string): boolean {
    return this.resolveRerun.delete(key);
  }

  clearAll(): void {
    for (const entry of this.tableCoalesceMap.values()) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
    }
    this.tableCoalesceMap.clear();
    this.expectedSelfCausedSignals.clear();
    this.lastKnownCollectionSeqByTable.clear();
    this.lastResolvedScopeSeq.clear();
    this.pullInFlight.clear();
    this.resolveRerun.clear();
  }
}
