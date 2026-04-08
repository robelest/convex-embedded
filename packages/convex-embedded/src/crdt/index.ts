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
} from "@/crdt/prose";

export const prose = {
  open: openProse,
  empty: createEmptyProseContent,
  normalize: normalizeProseContent,
  text: proseContentToPlainText,
} as const;

export const register = {
  open: openRegister,
} as const;

export const set = {
  open: openSet,
} as const;

export const counter = {
  open: openCounter,
} as const;

export type { ProseContent } from "@/crdt/prose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  Conflict,
  ConflictEntry,
  CrdtFieldDescriptor,
} from "@/shared/types";
export { CrdtType } from "@/shared/types";
