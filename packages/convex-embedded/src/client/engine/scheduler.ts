import { runDetached } from "@/utils/detached";

/**
 * Owns the engine's in-flight cycle promise + abort controller and the
 * processor-heartbeat interval timer.
 *
 * The `runReplicationCycle` orchestration itself stays in legacy
 * engine.ts because it threads through every other subsystem (replay,
 * scope, pullBatch, snapshot, crdt). This class just consolidates the
 * three pieces of timer/lifecycle state and the heartbeat
 * setInterval/clearInterval pair.
 */
export class CycleScheduler {
  private cyclePromise: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** The currently in-flight replication cycle, if any. */
  inFlight(): Promise<void> | null {
    return this.cyclePromise;
  }
  setInFlight(promise: Promise<void> | null): void {
    this.cyclePromise = promise;
  }

  /** The abort signal for the in-flight cycle, if any. */
  currentSignal(): AbortSignal | undefined {
    return this.abort?.signal;
  }
  /** Create a fresh AbortController for the next cycle and return it. */
  newAbortController(): AbortController {
    this.abort = new AbortController();
    return this.abort;
  }
  abortCurrent(): void {
    this.abort?.abort();
    this.abort = null;
  }

  startHeartbeat(intervalMs: number, run: () => Promise<unknown>): void {
    runDetached(run, "[sync] processor heartbeat:");
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      runDetached(run, "[sync] processor heartbeat:");
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
