/**
 * Schema-safe entry point — `@robelest/convex-embedded/server/schema`.
 *
 * Convex's schema evaluator only allows imports from `convex/server` and
 * `convex/values`. The `server/schema` build bundles the modules re-exported
 * here into a single file so consuming apps still get a zero-chunk schema-safe
 * artifact.
 *
 * Component-dependent features (resolve diffing, delta recording) are
 * attached lazily by `bindTable()` / `bindTableRuntime()`.
 *
 * @packageDocumentation
 */

/**
 * Core schema types and helpers shared by embedded table definitions.
 */
export {
  CrdtType,
  define,
  getCrdtType,
  isCrdtField,
  type Conflict,
  type ConflictEntry,
  type CounterFieldDescriptor,
  type CrdtFieldDescriptor,
  type CrdtTypeValue,
  type DefineOptions,
  type Definition,
  type FieldKindForDescriptor,
  type FieldValueForDescriptor,
  type LocalTableMigrationStep,
  type OmittedFieldDescriptor,
  type ProseFieldDescriptor,
  type ProseJson,
  type RegisterFieldDescriptor,
  type SetFieldDescriptor,
  type TypedFieldDescriptor,
} from "./schema/core.js";
/**
 * Create explicit register conflict resolvers for schema fields.
 */
export { createConflict } from "./schema/conflict.js";
/**
 * CRDT field constructors and the namespace-style `schema` helper.
 */
export {
  counter,
  extractValidator,
  omit,
  prose,
  register,
  schema,
  set,
} from "./schema/fields.js";
export type { RegisterOptions } from "./schema/fields.js";
/**
 * Remote-routing metadata constants used by bound tables and generated queries.
 */
export {
  PENDING_REPLAY_META,
  REMOTE_META,
  type ComponentBinding,
  type PendingReplayMeta,
  type PendingReplayMigrationContext,
  type PendingReplayMigrationResult,
  type PendingReplayMigrationStep,
  type RemoteMeta,
} from "./schema/meta.js";
/**
 * Embedded table builders, runtime hooks, and registry helpers.
 */
export {
  _resetRegistry,
  embeddedTable,
  getTableRegistry,
  type EmbeddedMutationBuilder,
  type EmbeddedQueryBuilder,
  type EmbeddedTable,
  type EmbeddedTableHandle,
  type EmbeddedTableRuntimeHandle,
  type RuntimeHooks,
} from "./schema/table.js";
