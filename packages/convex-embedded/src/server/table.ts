/**
 * Table-focused server entry point for `@robelest/convex-embedded/server/table`.
 *
 * Use this narrower surface when you only need embedded table builders and
 * routing metadata, not the broader server helper set from `server/index.ts`.
 *
 * @packageDocumentation
 */

/**
 * Embedded table builders and registry helpers.
 */
export {
  embeddedTable,
  getTableRegistry,
  _resetRegistry,
} from "@/server/schema";
/**
 * Attach the packaged resolve runtime to an embedded table handle.
 */
export { bindTable } from "@/server/runtime";
/**
 * Route markers used to force local-only, remote-only, or upload-url behavior.
 */
export { localOnly, remoteOnly, storageUploadUrl } from "@/server/markers";
/**
 * Metadata symbols exported for advanced marker-driven integrations.
 */
export {
  PENDING_REPLAY_META,
  REMOTE_META,
  STORAGE_UPLOAD_URL_META,
} from "@/shared/symbols";

export type { EmbeddedTableHandle } from "@/server/schema";
export type {
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
  RemoteMeta,
  RouteMode,
  StorageUploadUrlMeta,
} from "@/shared/symbols";
