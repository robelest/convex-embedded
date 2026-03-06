/**
 * convex-resolve/client
 *
 * Client-side entry point. Import in your app code:
 *
 *   import { runtime, monitor, clientSchema } from 'convex-resolve/client';
 */

// Runtime — creates ConvexClient over Concave transport
export { runtime } from "./runtime.js";
export type { ConcaveTransport, RuntimeInstance } from "./runtime.js";

// Monitor — orchestrates resolve on connect/reconnect
export { monitor } from "./monitor.js";
export type { MonitorConfig, MonitorInstance, TableConfig } from "./monitor.js";

// Schema — client-side CRDT field helpers
export { clientSchema } from "./schema.js";
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
} from "./schema.js";

// Re-export shared types
export type {
  Conflict,
  ConflictEntry,
  MonitorStatus,
  ResolveProgress,
  ResolveRequest,
  ResolveDocumentRequest,
  ResolveResponse,
  ResolveDocumentResponse,
  PushRequest,
  PushDocumentRequest,
} from "../shared/types.js";
