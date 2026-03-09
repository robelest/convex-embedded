/**
 * convex-resolve/server
 *
 * Server-side entry point. Import in your convex/ functions:
 *
 *   import { register, builders, schema, view, migration } from 'convex-resolve/server';
 */

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
} from "./schema.js";
export type { DefineOptions, Definition, RegisterOptions } from "./schema.js";

// Builders — mutation/query wrappers with remote: key
export { builders } from "./builders.js";
export type { BuildersResult } from "./builders.js";

// Register — generates resolve query + delta recording
export { register } from "./register.js";
export type { RegisterConfig, RegisterResult } from "./register.js";

// Views — query scoping utilities
export { view } from "./view.js";
export type { ViewFilter } from "./view.js";

// Migration — local schema versioning
export { migration, runMigrations } from "./migration.js";
export type { MigrationConfig } from "./migration.js";

// Re-export shared types for convenience
export type {
  Conflict,
  ConflictEntry,
  SchemaDefinition,
  CrdtFieldDescriptor,
  MigrationErrorHandler,
  RecoveryAction,
  RecoveryContext,
} from "../shared/types.js";
export { CrdtType } from "../shared/types.js";
