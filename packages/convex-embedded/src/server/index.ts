/**
 * Server-side entry point for `@robelest/convex-embedded/server`.
 *
 * Import in your `convex/` functions:
 *
 *   import { bindTable, embeddedTable } from "@robelest/convex-embedded/server";
 *
 * @packageDocumentation
 */

/**
 * Embedded table builders, runtime binding, and routing metadata.
 */
export {
  embeddedTable,
  typedTable,
  bindTable,
  localOnly,
  remoteOnly,
  storageUploadUrl,
  getTableRegistry,
  /** @internal — test-only registry reset; not part of the public API */
  _resetRegistry,
  REMOTE_META,
  PENDING_REPLAY_META,
  STORAGE_UPLOAD_URL_META,
} from "@/server/table";
export type {
  EmbeddedTableHandle,
  TypedEmbeddedTable,
  RemoteMeta,
  RouteMode,
  PendingReplayMeta,
  PendingReplayMigrationContext,
  PendingReplayMigrationResult,
  PendingReplayMigrationStep,
  StorageUploadUrlMeta,
} from "@/server/table";

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

/**
 * Query scoping helper for deriving bound views from embedded tables.
 */
export { view } from "@/server/view";
export type { ViewFilter } from "@/server/view";

/**
 * Local schema migration helpers for embedded tables.
 */
export { migration, runMigrations } from "@/server/migration";
export type {
  MigrationContext,
  MigrationDb,
  MigrationLogger,
  MigrationRuntimeAdapter,
  MigrationSchema,
  MigrationStep,
  MigrationSystem,
  MigrationSystemTable,
  MigrationsMap,
  RunMigrationsOptions,
} from "@/server/migration";

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
