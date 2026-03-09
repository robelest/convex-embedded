/**
 * convex-resolve/client
 *
 * Client-side entry point. Import in your app code:
 *
 *   import { runtime, monitor, clientSchema } from 'convex-resolve/client';
 */

// Runtime — creates ConvexClient over embedded transport
export { runtime } from "$/client/runtime";
export type { EmbeddedTransport, RuntimeInstance } from "$/client/runtime";

// Monitor — orchestrates resolve on connect/reconnect
export { monitor } from "$/client/monitor";
export type { MonitorConfig, MonitorInstance, TableConfig } from "$/client/monitor";

// Schema — client-side CRDT field helpers
export { clientSchema } from "$/client/schema";
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
} from "$/client/schema";

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
} from "$/shared/types";
