/**
 * CRDT field constructors and runtime read helpers.
 *
 * Use field constructors inside `embeddedTable()` shape definitions:
 *
 *   import { schema } from "@robelest/convex-embedded/crdt";
 *
 *   export const tasks = embeddedTable("tasks", {
 *     title: schema.register(v.string()),
 *     body:  schema.prose(),
 *     votes: schema.counter(),
 *     tags:  schema.set(v.string()),
 *     secret: schema.omit(v.string()),
 *   });
 *
 * Use runtime helpers to read CRDT state from Yjs documents:
 *
 *   import { getConflict, getCounterValue, getSetMembers } from "@robelest/convex-embedded/crdt";
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Field constructors (schema.* namespace)
// ---------------------------------------------------------------------------

export {
  schema,
  prose,
  register,
  counter,
  set,
  omit,
  define,
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

// ---------------------------------------------------------------------------
// Runtime read helpers
// ---------------------------------------------------------------------------

export {
  getRegisterConflict as getConflict,
  getCounterValue,
  getSetMembers,
  resolveRegister,
  extractProseText,
  createEmptyDoc,
  encodeStateVector,
  applyUpdate,
  encodeState,
  materializeYjsDoc,
} from "@/client/schema";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  Conflict,
  ConflictEntry,
  CrdtFieldDescriptor,
} from "@/shared/types";
export { CrdtType } from "@/shared/types";
