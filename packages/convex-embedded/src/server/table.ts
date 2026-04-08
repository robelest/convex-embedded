/**
 * Table-focused server entry point for `@robelest/convex-embedded/server/table`.
 *
 * Use this narrower surface when you only need embedded table builders and
 * routing metadata, not the broader server helper set from `server/index.ts`.
 *
 * @packageDocumentation
 */

export {
  embeddedTable,
  bindTable,
  localOnly,
  remoteOnly,
  getTableRegistry,
  _resetRegistry,
  REMOTE_META,
  PENDING_REPLAY_META,
} from "@/server/setup";

export type {
  EmbeddedTableHandle,
  RemoteMeta,
  RouteMode,
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
} from "@/server/setup";
