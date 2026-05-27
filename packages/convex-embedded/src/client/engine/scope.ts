import { createLogger } from "@/shared/logger";

const log = createLogger("resolve");

export interface ActiveScope {
  tableName: string;
  scopeArgs: Record<string, unknown>;
  unsubscribe?: () => void;
  pendingActivation?: Promise<void>;
  readers?: Set<string>;
}

/**
 * Owns the engine's active-subscription bookkeeping:
 *
 * - `activeScopes` — per-scope subscription state (unsubscribe handle,
 *   pending-activation promise, set of currently-reading consumers)
 * - `scopeTeardownTimers` — debounced scope-deactivation timers, fired
 *   `SCOPE_TEARDOWN_DEBOUNCE_MS` after the last reader releases
 * - `resolvedScopes` — scopes that have completed at least one resolve
 *   since activation; used to gate preloaded values from showing stale
 *   local rows
 * - `scopeResolveListeners` — per-scope first-resolve callbacks
 * - `activationEpoch` — monotonic counter bumped on every
 *   `stopRemoteSubscriptions()` so in-flight activations can detect
 *   their scope was torn down
 *
 * Higher-level lifecycle (the complex activateScope / startRemoteSubscriptions
 * implementations and the platform-adapter glue) stays in legacy
 * engine.ts for now because it pulls on too many engine internals
 * (pullBatch, snapshotIngest, runReplicationCycle, getTableSpec).
 */
export class ScopeRegistry {
  private readonly activeScopes = new Map<string, ActiveScope>();
  private readonly teardownTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly resolvedScopes = new Set<string>();
  private readonly resolveListeners = new Map<string, Set<() => void>>();
  private epoch = 0;

  /** Read-only accessor for code that needs to iterate active scopes. */
  scopes(): ReadonlyMap<string, ActiveScope> {
    return this.activeScopes;
  }

  set(scopeKey: string, scope: ActiveScope): void {
    this.activeScopes.set(scopeKey, scope);
  }
  get(scopeKey: string): ActiveScope | undefined {
    return this.activeScopes.get(scopeKey);
  }
  delete(scopeKey: string): boolean {
    return this.activeScopes.delete(scopeKey);
  }

  hasActiveSubscriptions(): boolean {
    return this.activeScopes.size > 0;
  }

  /** Teardown-timer accessors used by debounced scope deactivation. */
  setTeardownTimer(
    scopeKey: string,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    this.teardownTimers.set(scopeKey, timer);
  }
  getTeardownTimer(
    scopeKey: string,
  ): ReturnType<typeof setTimeout> | undefined {
    return this.teardownTimers.get(scopeKey);
  }
  deleteTeardownTimer(scopeKey: string): boolean {
    return this.teardownTimers.delete(scopeKey);
  }
  clearTeardownTimer(scopeKey: string): void {
    const timer = this.teardownTimers.get(scopeKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.teardownTimers.delete(scopeKey);
    }
  }

  /** Activation epoch — bump on stopRemoteSubscriptions, read in
   * activateScope to detect concurrent teardown. */
  getEpoch(): number {
    return this.epoch;
  }
  bumpEpoch(): number {
    this.epoch += 1;
    return this.epoch;
  }

  isResolved(scopeKey: string): boolean {
    return this.resolvedScopes.has(scopeKey);
  }

  clearResolved(scopeKey: string): void {
    this.resolvedScopes.delete(scopeKey);
  }

  markResolved(scopeKey: string): void {
    if (this.resolvedScopes.has(scopeKey)) return;
    this.resolvedScopes.add(scopeKey);
    const ls = this.resolveListeners.get(scopeKey);
    if (ls) {
      // A listener may unsubscribe itself here; deleting the current entry
      // during a Set for-of is safe.
      for (const cb of ls) {
        try {
          cb();
        } catch (err) {
          log.warn("sync: scope-resolved listener failed", err);
        }
      }
    }
  }

  /**
   * Subscribe to the first resolve of a scope. Fires the callback once
   * (immediately if the scope is already resolved); returns an
   * unsubscribe handle.
   */
  onResolved(scopeKey: string, cb: () => void): () => void {
    let set = this.resolveListeners.get(scopeKey);
    if (!set) {
      set = new Set();
      this.resolveListeners.set(scopeKey, set);
    }
    set.add(cb);
    if (this.resolvedScopes.has(scopeKey)) {
      try {
        cb();
      } catch (err) {
        log.warn("sync: scope-resolved listener failed", err);
      }
    }
    return () => {
      const current = this.resolveListeners.get(scopeKey);
      current?.delete(cb);
      if (current && current.size === 0) {
        this.resolveListeners.delete(scopeKey);
      }
    };
  }

  /** Drop resolve gating + listeners. Called on stop() / reloadIdentity(). */
  resetResolved(): void {
    this.resolvedScopes.clear();
    this.resolveListeners.clear();
  }
}
