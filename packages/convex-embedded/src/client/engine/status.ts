import { createLogger } from "@/shared/logger";
import type { EngineStatus } from "@/shared/types";
import { recordCounter } from "@/tracing/metrics";

const log = createLogger("resolve");

export type ChangeListener = (status: EngineStatus) => void;

/**
 * Owns the engine's current `EngineStatus` and the set of subscribers
 * that want to be notified on every transition. A `resolved` transition
 * also increments the `sync.cycle` counter.
 *
 * Decoupled from the rest of the engine so subsystems can call
 * `status.emit(...)` without holding a reference to the Engine
 * instance.
 */
export class EngineStatusEmitter {
  private currentStatus: EngineStatus = { status: "idle" };
  private readonly listeners = new Set<ChangeListener>();

  get(): EngineStatus {
    return this.currentStatus;
  }

  emit(next: EngineStatus): void {
    if (
      next.status === "resolved" &&
      this.currentStatus.status !== "resolved"
    ) {
      recordCounter("sync.cycle");
    }
    this.currentStatus = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        log.error("sync: listener threw", err);
      }
    }
  }

  on(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}
