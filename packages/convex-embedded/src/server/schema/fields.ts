import type {
  GenericValidator,
  OptionalProperty,
  Validator,
} from "convex/values";
import { v } from "convex/values";

import { createConflict } from "./conflict.js";
import {
  CRDT_FIELD,
  CrdtType,
  type Conflict,
  type CounterFieldDescriptor,
  define,
  getCrdtType,
  isCrdtField,
  type OmittedFieldDescriptor,
  type ProseFieldDescriptor,
  type RegisterFieldDescriptor,
  type SetFieldDescriptor,
} from "./core.js";

/**
 * Options for {@link register} fields.
 *
 * @typeParam T - Register value type.
 */
export interface RegisterOptions<T> {
  /**
   * Optional custom conflict resolver invoked when multiple register values are
   * present for the same field.
   */
  resolve?: (conflict: Conflict<T>) => T;
}

/**
 * Extract the Convex validator that should be used for a field shape entry.
 *
 * @param value - Plain validator or embedded CRDT field descriptor.
 * @returns The validator that should be fed into `defineTable(...)`.
 * @internal
 */
export function extractValidator(value: unknown): GenericValidator {
  if (isCrdtField(value)) {
    switch (getCrdtType(value)) {
      case CrdtType.Prose:
        return v.any();
      case CrdtType.Register:
        return value.validator as GenericValidator;
      case CrdtType.Counter:
        return v.number();
      case CrdtType.Set:
        return v.array(value.validator as GenericValidator);
      case CrdtType.Omitted:
      case CrdtType.Plain:
      default:
        return value.validator as GenericValidator;
    }
  }
  return value as GenericValidator;
}

/**
 * Create a prose CRDT field descriptor.
 *
 * @returns A descriptor for rich-text fields backed by Yjs prose state.
 */
export function prose(): ProseFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Prose,
    validator: v.any(),
  };
}

/**
 * Create a register CRDT field descriptor.
 *
 * @typeParam T - Register value type.
 * @param validator - Convex validator for the stored value.
 * @param options - Optional conflict-resolution behavior.
 * @returns A descriptor for a last-write-wins register field.
 */
export function register<T>(
  validator: Validator<T, OptionalProperty, string>,
  options?: RegisterOptions<T>,
): RegisterFieldDescriptor<T> & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Register,
    validator,
    resolve: options?.resolve,
  };
}

/**
 * Create a counter CRDT field descriptor.
 *
 * @returns A descriptor for numeric counters merged by summing deltas.
 */
export function counter(): CounterFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Counter,
    validator: v.number(),
  };
}

/**
 * Create a set CRDT field descriptor.
 *
 * @typeParam T - Set member type.
 * @param validator - Convex validator for each set member.
 * @returns A descriptor for an add-wins set field.
 */
export function set<T>(
  validator: Validator<T, OptionalProperty, string>,
): SetFieldDescriptor<T> & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Set,
    validator,
  };
}

/**
 * Create an omitted field descriptor.
 *
 * Omitted fields are validated remotely but excluded from local embedded CRDT
 * materialization.
 *
 * @typeParam T - Omitted value type.
 * @param validator - Convex validator for the omitted field.
 * @returns A descriptor for a remote-only field.
 */
export function omit<T>(
  validator: Validator<T, OptionalProperty, string>,
): OmittedFieldDescriptor<T> & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Omitted,
    validator,
  };
}

/**
 * Namespace-style schema helper collection.
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
