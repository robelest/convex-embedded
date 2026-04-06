import type { Validator } from "convex/values";
import { v } from "convex/values";

import { createConflict } from "@/shared/conflict";
import { define, getCrdtType, isCrdtField } from "@/shared/schema";
import type { Conflict, CrdtFieldDescriptor } from "@/shared/types";
import { CrdtType } from "@/shared/types";

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

export interface RegisterOptions<T> {
  resolve?: (conflict: Conflict<T>) => T;
}

export function prose(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Prose,
    validator: v.any(),
  };
}

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

export function counter(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Counter,
    validator: v.number(),
  };
}

export function set<T>(
  validator: Validator<T, any, any>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Set,
    validator,
  };
}

export function omit<T>(
  validator: Validator<T, any, any>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Omitted,
    validator,
  };
}

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
