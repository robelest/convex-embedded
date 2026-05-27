/**
 * Tracks the engine's view of network connectivity:
 *
 * - `isOnline` — current state, observed via the platform adapter.
 * - `offlineTransitionsSinceBoot` — count of real online→offline cycles
 *   since the engine started; gates whether a resolve is needed after
 *   coming back online (a startup `online` event with zero prior
 *   offlines is treated as "boot, not reconnect").
 * - `cameOnlineAfterOfflinePeriod` — edge flag distinguishing the
 *   initial boot transition from a true reconnect.
 *
 * The legacy `createEngine` factory previously held these as three
 * `let` variables in its closure. Moving them onto a tiny class makes
 * ownership explicit; the platform-adapter wiring and replication-cycle
 * triggers stay in the engine factory because they pull on too many
 * other subsystems to extract here.
 */
export class ConnectivityState {
  private _isOnline = false;
  private _offlineTransitionsSinceBoot = 0;
  private _cameOnlineAfterOfflinePeriod = false;

  isOnline(): boolean {
    return this._isOnline;
  }

  offlineTransitionsSinceBoot(): number {
    return this._offlineTransitionsSinceBoot;
  }

  /**
   * Record an online transition. Returns whether this was a real
   * reconnect (true) vs. the initial boot transition (false). Increments
   * the offlineTransitionsSinceBoot counter on a real reconnect.
   */
  markOnline(): boolean {
    const wasReconnect = this._cameOnlineAfterOfflinePeriod;
    if (wasReconnect) {
      this._offlineTransitionsSinceBoot += 1;
      this._cameOnlineAfterOfflinePeriod = false;
    }
    this._isOnline = true;
    return wasReconnect;
  }

  /**
   * Record an offline transition. If we were previously online, this is
   * a real offline event (sets the edge flag); otherwise it's the
   * initial-state declaration.
   */
  markOffline(): void {
    if (this._isOnline) {
      this._cameOnlineAfterOfflinePeriod = true;
    }
    this._isOnline = false;
  }
}
