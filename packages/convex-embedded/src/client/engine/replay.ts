const REPLAY_GRACE_MS = 3_000;

/**
 * Tracks IDs of documents that the engine just replayed to the remote
 * within the last `REPLAY_GRACE_MS`. The pull pipeline consults this set
 * via `projectRemoteSnapshot` to suppress immediate echoes of our own
 * just-pushed writes from clobbering still-newer local state.
 *
 * The rest of the replay subsystem (the 230-LOC processQueue loop,
 * processUploadQueue, ensureRemoteStorageMappings, route dispatch, lease
 * heartbeat, classify-and-retry) remains in legacy engine.ts because it
 * has ~15 deeply-bound dependencies on every other subsystem. Extracting
 * it cleanly is a multi-commit task on its own.
 */
export class ReplayGracePeriod {
  private readonly ids = new Map<string, number>();

  private sweep(now: number): void {
    for (const [id, timestamp] of this.ids) {
      if (now - timestamp >= REPLAY_GRACE_MS) {
        this.ids.delete(id);
      }
    }
  }

  add(id: string): void {
    const now = Date.now();
    this.sweep(now);
    this.ids.set(id, now);
  }

  snapshot(): ReadonlySet<string> {
    const now = Date.now();
    this.sweep(now);
    const active = new Set<string>();
    for (const [id, timestamp] of this.ids) {
      if (now - timestamp < REPLAY_GRACE_MS) {
        active.add(id);
      }
    }
    return active;
  }
}
