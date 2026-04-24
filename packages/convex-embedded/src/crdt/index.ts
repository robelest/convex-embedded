/**
 * CRDT field constructors and runtime access.
 *
 * Schema constructors for `embeddedTable()` definitions:
 *
 *   import { schema } from "@robelest/convex-embedded/crdt";
 *
 *   export const tasks = embeddedTable("tasks", {
 *     title: schema.register(v.string()),
 *     body:  schema.prose(),
 *     votes: schema.counter(),
 *     tags:  schema.set(v.string()),
 *   });
 *
 * Runtime field access for reading/subscribing to CRDT fields:
 *
 *   import { prose, register } from "@robelest/convex-embedded/crdt";
 *
 *   const handle = await prose.open(client, tasks.field(id, "body"));
 *   const text = handle.text();
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Schema constructors
// ---------------------------------------------------------------------------

export { schema, omit, createConflict } from "@/server/schema";
export type { RegisterOptions } from "@/server/schema";

// ---------------------------------------------------------------------------
// Field runtime access
// ---------------------------------------------------------------------------

export type { FieldRef } from "@/shared/types";
export type {
  ProseHandle,
  RegisterHandle,
  SetHandle,
  CounterHandle,
} from "@/crdt/fields";

import { openCounter, openProse, openRegister, openSet } from "@/crdt/fields";
import {
  createEmptyProseContent,
  normalizeProseContent,
  proseContentToPlainText,
} from "@/crdt/prose/content";

/**
 * Prose field helpers for reading and shaping rich-text CRDT content.
 *
 * @example
 * ```ts
 * const handle = await prose.open(client, tasks.field(taskId, "body"));
 * const text = handle.text();
 * ```
 */
export const prose = {
  /** Open a live prose handle for a field reference. */
  open: openProse,
  /** Create an empty ProseMirror-compatible document. */
  empty: createEmptyProseContent,
  /** Normalize unknown prose input into the canonical content shape. */
  normalize: normalizeProseContent,
  /** Extract plain text from prose content. */
  text: proseContentToPlainText,
} as const;

/**
 * Register field helpers for opening last-write-wins CRDT values.
 */
export const register = {
  /** Open a live register handle for a field reference. */
  open: openRegister,
} as const;

/**
 * Set field helpers for opening CRDT-backed member sets.
 */
export const set = {
  /** Open a live set handle for a field reference. */
  open: openSet,
} as const;

/**
 * Counter field helpers for opening CRDT-backed numeric counters.
 */
export const counter = {
  /** Open a live counter handle for a field reference. */
  open: openCounter,
} as const;

export type { ProseContent } from "@/crdt/prose/content";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  Conflict,
  ConflictEntry,
  CrdtFieldDescriptor,
} from "@/shared/types";
export { CrdtType } from "@/shared/types";
