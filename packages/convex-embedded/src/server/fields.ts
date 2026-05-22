/**
 * Field-constructor entry point for `@robelest/convex-embedded/server/fields`.
 *
 * This module exposes CRDT field builders and schema helpers without the rest
 * of the server runtime surface.
 *
 * @packageDocumentation
 */

import type { OptionalProperty, Validator } from "convex/values";
import { v } from "convex/values";

import { createConflict } from "@/shared/conflict";
import { define, getCrdtType, isCrdtField } from "@/shared/schema";
import type { Conflict, CrdtFieldDescriptor } from "@/shared/types";
import { CrdtType } from "@/shared/types";

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

/**
 * Conflict-resolution options for register fields.
 *
 * @typeParam T - Plain value type stored in the register.
 */
export interface RegisterOptions<T> {
  /**
   * Optional custom resolver used when multiple register values conflict.
   * When omitted, the newest timestamp wins.
   */
  resolve?: (conflict: Conflict<T>) => T;
}

/**
 * Declare a prose CRDT field.
 *
 * @returns A field descriptor suitable for `embeddedTable({...})`.
 *
 * @example
 * ```ts
 * const posts = embeddedTable("posts", {
 *   body: prose(),
 * });
 * ```
 */
export function prose(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Prose,
    validator: v.any(),
  };
}

/**
 * Declare a last-write-wins register CRDT field.
 *
 * @typeParam T - Plain value type accepted by the validator.
 * @param validator - Convex validator for the stored register value.
 * @param options - Optional conflict resolution behavior.
 * @returns A field descriptor suitable for `embeddedTable({...})`.
 */
export function register<T>(
  validator: Validator<T, OptionalProperty, string>,
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
 * Declare a numeric counter CRDT field.
 *
 * @returns A field descriptor suitable for `embeddedTable({...})`.
 */
export function counter(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Counter,
    validator: v.number(),
  };
}

/**
 * Declare a set CRDT field.
 *
 * @typeParam T - Member value type accepted by the validator.
 * @param validator - Convex validator for each set member.
 * @returns A field descriptor suitable for `embeddedTable({...})`.
 */
export function set<T>(
  validator: Validator<T, OptionalProperty, string>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Set,
    validator,
  };
}

/**
 * Declare an omitted field.
 *
 * Omitted fields are validated remotely but excluded from local CRDT
 * materialization.
 *
 * @typeParam T - Value type accepted by the validator.
 * @param validator - Convex validator for the omitted field.
 * @returns A field descriptor suitable for `embeddedTable({...})`.
 */
export function omit<T>(
  validator: Validator<T, OptionalProperty, string>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Omitted,
    validator,
  };
}

/**
 * Namespace-style schema helper collection for server-side table definitions.
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
  define,
  prose,
  register,
  counter,
  set,
  omit,
  createConflict,
  isCrdtField,
  getCrdtType,
};

export { createConflict, define, getCrdtType, isCrdtField };
