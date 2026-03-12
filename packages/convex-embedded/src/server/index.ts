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
  setup,
  getTableRegistry,
  _resetRegistry,
  SYNC_META,
} from "@/server/setup";
export type {
  SetupConfig,
  EmbeddedTableHandle,
  TableDescriptor,
  SyncMeta,
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
