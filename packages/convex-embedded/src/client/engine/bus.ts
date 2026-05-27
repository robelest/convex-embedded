/**
 * Typed in-process event bus used by Engine subsystems to coordinate
 * without holding direct references to each other.
 *
 * Subsystems own their state and listen for cross-cutting events on the
 * bus (online/offline, snapshot received, pending enqueued, etc.). The
 * Engine wires the topology at construction time by registering one
 * `bus.on(...)` per subsystem-pair interaction.
 */
export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<
    keyof Events,
    Set<(payload: never) => void>
  >();

  on<K extends keyof Events>(
    event: K,
    listener: (payload: Events[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const erased = listener as (payload: never) => void;
    set.add(erased);
    return () => {
      const current = this.listeners.get(event);
      if (!current) return;
      current.delete(erased);
      if (current.size === 0) this.listeners.delete(event);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      (listener as (payload: Events[K]) => void)(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
