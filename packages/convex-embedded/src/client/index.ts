/**
 * convex-embedded/client
 *
 * Advanced client entry point for embedded sync and startup helpers.
 *
 * Most users should use `createConvexClient()` from
 * `@robelest/convex-embedded/browser` instead of importing from this module
 * directly. Import from `@robelest/convex-embedded/client` when you need
 * advanced bootstrap helpers such as replica creation.
 *
 * @packageDocumentation
 */

// Engine — internal orchestrator (used by convex-embedded/browser)
/** @internal */
export { engine } from "@/client/engine";
/** @internal */
export type {
  EngineConfig,
  EngineInstance,
  TableConfig,
  EmbeddedClientLike,
} from "@/client/engine";

// Runtime — creates ConvexClient over embedded transport
/** @internal */
export { runtime } from "@/client/runtime";
/** @internal */
export type { EmbeddedTransport, RuntimeInstance } from "@/client/runtime";

/**
 * Build a remote-backed replica for SSR/bootstrap flows.
 *
 * See {@link CreateReplicaOptions} for configuration and {@link Replica} for
 * the returned artifact shape.
 *
 * @see CreateReplicaOptions
 * @see Replica
 * @category Factory
 */
export { createReplica } from "@/client/replica";

/**
 * Serializable replica artifact and creation options used by
 * `createReplica(...)`.
 *
 * @see createReplica
 * @category Type
 */
export type { CreateReplicaOptions, Replica } from "@/client/replica";

// ID Map — local UUID ↔ remote Convex ID translation
/** @internal */
export { IdMap } from "@/client/ids";

// Pending Queue — persistent mutation queue
/** @internal */
export { PendingQueue } from "@/client/pending";
/** @internal */
export type { PendingEntry } from "@/client/pending";

// Schema — client-side CRDT field helpers
/** @internal */
export { clientSchema } from "@/client/schema";
/** @internal */
export {
  extractProseText,
  createEmptyDoc,
  getRegisterConflict,
  resolveRegister,
  getCounterValue,
  getSetMembers,
  encodeStateVector,
  applyUpdate,
  encodeState,
  materializeYjsDoc,
} from "@/client/schema";

// Re-export shared types (some are still useful publicly)
export type {
  Conflict,
  ConflictEntry,
  EngineStatus,
  ResolveProgress,
  ResolveRequest,
  ResolveDocumentRequest,
  ResolveResponse,
  ResolveDocumentResponse,
  PushRequest,
  PushDocumentRequest,
} from "@/shared/types";
