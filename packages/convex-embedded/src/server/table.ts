export {
  embeddedTable,
  bindTable,
  setup,
  localOnly,
  remoteOnly,
  getTableRegistry,
  _resetRegistry,
  REMOTE_META,
  PENDING_REPLAY_META,
} from "@/server/setup";

export type {
  SetupConfig,
  EmbeddedTableHandle,
  RemoteMeta,
  RouteMode,
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
} from "@/server/setup";
