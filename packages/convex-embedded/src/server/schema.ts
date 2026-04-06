import type { Validator } from "convex/values";
import { v } from "convex/values";
/**
 * Schema utilities for convex-embedded.
 *
 * Provides CRDT field type wrappers that map to Yjs data structures:
 *   - schema.prose()     → Y.XmlFragment  (character-level merge)
 *   - schema.register(v) → Y.Map          (multi-value register)
 *   - schema.counter()   → Y.Array        (append-only increments)
 *   - schema.set(v)      → Y.Map          (add-wins set)
 *   - schema.omit(v)     → remote-only    (stripped from local sync)
 *
 * Also provides schema.define() for versioned schema definitions
 * with local migration metadata.
 */

import type { Conflict, CrdtFieldDescriptor } from "@/shared/types";
import { CrdtType } from "@/shared/types";

// Re-export everything from shared/schema-utils
export {
  isCrdtField,
  getCrdtType,
  define,
  initYjsDoc,
  encodeDocumentState,
  computeDiff,
  mergeUpdate,
  isDiffEmpty,
} from "@/shared/schema";
export type { DefineOptions, Definition } from "@/shared/schema";

// ---------------------------------------------------------------------------
// Field type constructors (these use convex/values so stay in server/)
// ---------------------------------------------------------------------------

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

export interface RegisterOptions<T> {
  /** Custom conflict resolver. If not provided, latest-timestamp wins. */
  resolve?: (conflict: Conflict<T>) => T;
}

/**
 * Rich text field — maps to Y.XmlFragment for character-level CRDT merge.
 * Use with ProseMirror or TipTap bindings.
 *
 * @returns A CRDT field descriptor suitable for `embeddedTable()` schemas.
 */
export function prose(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Prose,
    validator: v.any(),
  };
}

/**
 * Multi-value register — maps to Y.Map<{ value, timestamp }>.
 * Concurrent writes produce a conflict. Custom resolver can pick the winner.
 *
 * @param validator - Convex validator describing the field's stored value.
 * @param options - Optional register-specific conflict handling.
 * @returns A CRDT field descriptor suitable for `embeddedTable()` schemas.
 *
 * @example
 * ```ts
 * title: schema.register(v.string())
 * ```
 */
export function register<T>(
  validator: Validator<T, any, any>,
  options?: RegisterOptions<T>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Register,
    validator,
    resolve: options?.resolve as
      | ((conflict: Conflict<unknown>) => unknown)
      | undefined,
  };
}

/**
 * Counter — maps to Y.Array<{ client, delta, timestamp }>.
 * Append-only array of increments. Materialized value = sum of all deltas.
 *
 * @returns A CRDT field descriptor for additive numeric state.
 */
export function counter(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Counter,
    validator: v.number(),
  };
}

/**
 * Add-wins set — maps to Y.Map<{ addedBy, addedAt }>.
 * Key presence = membership. Delete key = remove. Yjs add-wins semantics.
 *
 * @param validator - Convex validator describing each member value.
 * @returns A CRDT field descriptor for set-like membership.
 */
export function set<T>(
  validator: Validator<T, any, any>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Set,
    validator,
  };
}

/**
 * Marks a field as remote-only. It exists on the remote Convex backend
 * but is stripped from every payload sent to local embedded runtime.
 *
 * Only needed on registered (synced) tables. Tables without register()
 * are never synced — they stay on remote by default.
 *
 * @param validator - Convex validator describing the remote-only field.
 * @returns A CRDT field descriptor that is omitted from local state.
 */
export function omit<T>(
  validator: Validator<T, any, any>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Omitted,
    validator,
  };
}

// Import and re-export createConflict from shared (defined there to avoid
// cross-boundary imports when client/ needs it)
import { createConflict } from "@/shared/conflict";
export { createConflict };

// ---------------------------------------------------------------------------
// Re-export the schema namespace as a single object
// ---------------------------------------------------------------------------

import {
  isCrdtField as _isCrdtField,
  getCrdtType as _getCrdtType,
  define as _define,
  initYjsDoc as _initYjsDoc,
  encodeDocumentState as _encodeDocumentState,
  computeDiff as _computeDiff,
  mergeUpdate as _mergeUpdate,
  isDiffEmpty as _isDiffEmpty,
} from "@/shared/schema";

/**
 * Convenience namespace for CRDT field constructors and sync helpers.
 *
 * @example
 * ```ts
 * const tasks = embeddedTable("tasks", {
 *   title: schema.register(v.string()),
 *   body: schema.prose(),
 * });
 * ```
 */
export const schema = {
  define: _define,
  prose,
  register,
  counter,
  set,
  omit,
  createConflict,
  isCrdtField: _isCrdtField,
  getCrdtType: _getCrdtType,
  initYjsDoc: _initYjsDoc,
  encodeDocumentState: _encodeDocumentState,
  computeDiff: _computeDiff,
  mergeUpdate: _mergeUpdate,
  isDiffEmpty: _isDiffEmpty,
};
