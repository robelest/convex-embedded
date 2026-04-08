/**
 * Server-side entry point for `@robelest/convex-embedded/server`.
 *
 * Import in your `convex/` functions:
 *
 *   import { bindTable, embeddedTable } from "@robelest/convex-embedded/server";
 *
 * @packageDocumentation
 */

// Core API — embeddedTable + explicit remote binding
//
// Public server exports are grouped here intentionally so Convex apps can
// consume a small stable surface without importing deep implementation files.
export {
  embeddedTable,
  bindTable,
  localOnly,
  remoteOnly,
  storageUploadUrl,
  getTableRegistry,
  _resetRegistry,
  REMOTE_META,
  PENDING_REPLAY_META,
  STORAGE_UPLOAD_URL_META,
} from "@/server/setup";
export type {
  EmbeddedTableHandle,
  RemoteMeta,
  RouteMode,
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
  StorageUploadUrlMeta,
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
