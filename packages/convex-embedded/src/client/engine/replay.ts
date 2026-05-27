import type { PendingEntry } from "@/client/pending/queue";

const REPLAY_GRACE_MS = 3_000;

/**
 * Owns the state for the engine's pending-mutation replay loop. Holds:
 *
 * - `inFlight` — the singleton in-flight `processQueue` promise (gates
 *   re-entry so two concurrent enqueues collapse onto one drain)
 * - `requestedWhileActive` — flag set when an enqueue arrives mid-loop;
 *   the outer loop re-checks it before returning so the new entry isn't
 *   stranded
 * - `activeEntry` — the entry the loop currently holds a lease on
 *   (kept so `Engine.stop()` can release it cleanly)
 * - `recentlyReplayedIds` — id → push-timestamp Map; the pull pipeline
 *   consults this set (via `projectRemoteSnapshot`) to suppress
 *   immediate echoes of our own just-pushed writes from clobbering
 *   still-newer local state.
 *
 * The actual processQueue / processUploadQueue / ensureRemoteStorageMappings
 * implementations stay in legacy engine.ts because they have ~15 deeply-
 * bound dependencies on every other subsystem. Extracting them is a
 * future commit; today this class just owns the four pieces of replay
 * loop state that the engine factory previously held as closure `let`s.
 */
export class ReplayLoopState {
  private _inFlight: Promise<Set<string>> | null = null;
  private _requestedWhileActive = false;
  private _activeEntry: PendingEntry | null = null;
  private readonly recentlyReplayedIds = new Map<string, number>();

  // ---- in-flight promise -----------------------------------------------

  inFlight(): Promise<Set<string>> | null {
    return this._inFlight;
  }
  setInFlight(promise: Promise<Set<string>> | null): void {
    this._inFlight = promise;
  }

  // ---- re-entry flag --------------------------------------------------

  requestedWhileActive(): boolean {
    return this._requestedWhileActive;
  }
  setRequestedWhileActive(requested: boolean): void {
    this._requestedWhileActive = requested;
  }

  // ---- active entry ---------------------------------------------------

  activeEntry(): PendingEntry | null {
    return this._activeEntry;
  }
  setActiveEntry(entry: PendingEntry | null): void {
    this._activeEntry = entry;
  }

  // ---- recently-replayed grace period ---------------------------------

  private sweepRecent(now: number): void {
    for (const [id, timestamp] of this.recentlyReplayedIds) {
      if (now - timestamp >= REPLAY_GRACE_MS) {
        this.recentlyReplayedIds.delete(id);
      }
    }
  }

  addRecentlyReplayed(id: string): void {
    const now = Date.now();
    this.sweepRecent(now);
    this.recentlyReplayedIds.set(id, now);
  }

  recentlyReplayedIdSet(): ReadonlySet<string> {
    const now = Date.now();
    this.sweepRecent(now);
    const active = new Set<string>();
    for (const [id, timestamp] of this.recentlyReplayedIds) {
      if (now - timestamp < REPLAY_GRACE_MS) {
        active.add(id);
      }
    }
    return active;
  }
}
