import type { Validator } from "convex/values";
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

export interface RegisterOptions<T> {
  resolve?: (conflict: Conflict<T>) => T;
}

export function extractValidator(value: unknown): any {
  if (isCrdtField(value)) {
    switch (getCrdtType(value)) {
      case CrdtType.Prose:
        return v.any();
      case CrdtType.Register:
        return value.validator;
      case CrdtType.Counter:
        return v.number();
      case CrdtType.Set:
        return v.array(value.validator as Validator<any, any, any>);
      case CrdtType.Omitted:
      case CrdtType.Plain:
      default:
        return value.validator;
    }
  }
  return value;
}

export function prose(): ProseFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Prose,
    validator: v.any(),
  };
}

export function register<T>(
  validator: Validator<T, any, any>,
  options?: RegisterOptions<T>,
): RegisterFieldDescriptor<T> & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Register,
    validator,
    resolve: options?.resolve,
  };
}

export function counter(): CounterFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Counter,
    validator: v.number(),
  };
}

export function set<T>(
  validator: Validator<T, any, any>,
): SetFieldDescriptor<T> & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Set,
    validator,
  };
}

export function omit<T>(
  validator: Validator<T, any, any>,
): OmittedFieldDescriptor<T> & { [CRDT_FIELD]: true } {
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
