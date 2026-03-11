/**
 * convex-resolve/server
 *
 * Server-side entry point. Import in your convex/ functions:
 *
 *   import { setup, schema, view, migration } from 'convex-resolve/server';
 */

// Setup — unified entry point for synced tables
export { setup, SYNC_META } from "@/server/setup";
export type { SetupConfig, TableDescriptor, SyncMeta } from "@/server/setup";

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
  initYjsDoc,
  encodeDocumentState,
  computeDiff,
  mergeUpdate,
  isDiffEmpty,
} from "@/server/schema";
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
export type { MigrationConfig } from "@/server/migration";

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
