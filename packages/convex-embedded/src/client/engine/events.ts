/**
 * Typed event payloads emitted on the engine's internal `EventBus`.
 *
 * Events are the explicit wiring between subsystems. A subsystem `X`
 * never reaches into subsystem `Y`'s state — instead `X` listens for the
 * event `Y` emits, or `Y` listens for `X`'s. The Engine constructor wires
 * the topology by calling `bus.on(...)` for each cross-subsystem edge.
 */
export interface EngineEvents {
  /** A new pending mutation was just enqueued. */
  pendingEnqueued: { table: string };
  /** The pending queue finished a drain pass; carries the dead-letter set. */
  pendingDrained: { deadLetteredTables: Set<string> };
  /** Connectivity transitioned to online. */
  online: void;
  /** Connectivity transitioned to offline. */
  offline: void;
  /** A live binding produced a fresh snapshot of remote rows. */
  snapshotReceived: { table: string; docCount: number };
  /** Local → remote ID mapping was just installed. */
  mappingAdded: { localId: string; remoteId: string; table: string };
  /** A scope completed its first resolve. */
  scopeResolved: {
    table: string;
    scopeArgs?: Record<string, unknown>;
  };
  /** A pending mutation exceeded its retry budget. */
  replayDeadLetter: { table: string };
  /** The active identity rotated; subsystems should reload identity-scoped state. */
  identityChanged: void;
}
