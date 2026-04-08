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
export { createConflict } from "./schema/conflict.js";
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
export {
  PENDING_REPLAY_META,
  REMOTE_META,
  RESOLVE_QUERY_META,
  type ComponentBinding,
  type PendingReplayMeta,
  type PendingReplayMigrationContext,
  type PendingReplayMigrationResult,
  type PendingReplayMigrationStep,
  type RemoteMeta,
  type ResolveQueryMeta,
} from "./schema/meta.js";
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
