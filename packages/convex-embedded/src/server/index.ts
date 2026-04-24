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
/**
 * Embedded table builders, runtime binding, and routing metadata.
 */
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
} from "@/server/table";
export type {
  EmbeddedTableHandle,
  RemoteMeta,
  RouteMode,
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
  StorageUploadUrlMeta,
} from "@/server/table";

// Schema system — CRDT field types + versioning
/**
 * Server-side CRDT schema constructors and helpers.
 */
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
/**
 * Query scoping helper for deriving bound views from embedded tables.
 */
export { view } from "@/server/view";
export type { ViewFilter } from "@/server/view";

// Migration — local schema versioning
/**
 * Local schema migration helpers for embedded tables.
 */
export { migration, runMigrations } from "@/server/migration";
export type {
  MigrationConfig,
  LocalMigrationAdapter,
  LocalTableMigrationStep,
  LocalTableMigrationContext,
  LocalTableDocsApi,
} from "@/server/migration";

// Re-export shared types for convenience
/**
 * Shared conflict and recovery types used by server-side helpers.
 */
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
