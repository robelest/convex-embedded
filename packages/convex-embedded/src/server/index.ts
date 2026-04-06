/**
 * Server-side entry point for `@robelest/convex-embedded/server`.
 *
 * Import in your `convex/` functions:
 *
 *   import { embeddedTable, setup } from "@robelest/convex-embedded/server";
 *
 * @packageDocumentation
 */

// Core API — embeddedTable + setup
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

// Schema system — CRDT field types + versioning
export {
  schema,
  define,
  prose,
  register as registerField,
  counter,
  set,
  omit,
  createConflict,
  isCrdtField,
  getCrdtType,
} from "@/server/fields";
export type {
  DefineOptions,
  Definition,
  RegisterOptions,
} from "@/server/schema";

// Views — query scoping utilities
export { view } from "@/server/view";
export type { ViewFilter } from "@/server/view";

// Migration — local schema versioning
export { migration, runMigrations } from "@/server/migration";
export type {
  MigrationConfig,
  LocalMigrationAdapter,
  LocalTableMigrationStep,
  LocalTableMigrationContext,
  LocalTableDocsApi,
} from "@/server/migration";

// Re-export shared types for convenience
export type {
  Conflict,
  ConflictEntry,
  SchemaDefinition,
  CrdtFieldDescriptor,
  MigrationErrorHandler,
  RecoveryAction,
  RecoveryContext,
} from "@/shared/types";
export { CrdtType } from "@/shared/types";
