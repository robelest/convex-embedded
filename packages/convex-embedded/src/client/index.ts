/**
 * convex-resolve/client
 *
 * Client-side entry point for remote internals.
 *
 * Most users should use `createConvexClient()` from
 * `@robelest/convex-embedded/browser` instead of importing
 * from this module directly.
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

// Backwards-compat re-export (deprecated)
/** @internal @deprecated Use engine instead. */
export { monitor } from "@/client/monitor";
/** @internal @deprecated */
export type { MonitorConfig, MonitorInstance } from "@/client/monitor";

// Runtime — creates ConvexClient over embedded transport
/** @internal */
export { runtime } from "@/client/runtime";
/** @internal */
export type { EmbeddedTransport, RuntimeInstance } from "@/client/runtime";

// ID Map — local UUID ↔ remote Convex ID translation
/** @internal */
export { IdMap } from "@/client/id-map";

// Pending Queue — persistent mutation queue
/** @internal */
export { PendingQueue } from "@/client/pending-queue";
/** @internal */
export type { PendingEntry } from "@/client/pending-queue";

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
