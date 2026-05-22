import type { OptionalProperty, Validator } from "convex/values";

/**
 * Internal CRDT field kind constants used by schema descriptors.
 */
export const CrdtType = {
  Prose: "prose",
  Register: "register",
  Counter: "counter",
  Set: "set",
  Plain: "plain",
  Omitted: "omitted",
} as const;

/**
 * Union of schema descriptor CRDT kinds.
 */
export type CrdtTypeValue = (typeof CrdtType)[keyof typeof CrdtType];

/**
 * Metadata for one conflicting register write.
 *
 * @typeParam T - Register value type.
 */
export interface ConflictEntry<T> {
  value: T;
  clientId: string;
  timestamp: number;
}

/**
 * Conflict information passed into custom register resolvers.
 *
 * @typeParam T - Register value type.
 */
export interface Conflict<T> {
  values: T[];
  entries: ConflictEntry<T>[];
  latest(): T;
  byClient(id: string): T | undefined;
}

/**
 * Shared descriptor shape implemented by all embedded CRDT fields.
 */
export interface CrdtFieldDescriptor {
  type: CrdtTypeValue;
  validator: unknown;
  resolve?: (conflict: Conflict<unknown>) => unknown;
}

/**
 * JSON representation for prose/rich-text fields.
 */
export interface ProseJson {
  type: string;
  content?: ProseJson[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  [key: string]: unknown;
}

export type TypedFieldDescriptor<
  Type extends CrdtTypeValue,
  ValidatorType = unknown,
  ResolveType = unknown,
> = Omit<CrdtFieldDescriptor, "type" | "validator" | "resolve"> & {
  type: Type;
  validator: ValidatorType;
  resolve?: ResolveType;
};

/** Prose CRDT field descriptor. */
export type ProseFieldDescriptor = TypedFieldDescriptor<typeof CrdtType.Prose>;

/** Register CRDT field descriptor. */
export type RegisterFieldDescriptor<T> = TypedFieldDescriptor<
  typeof CrdtType.Register,
  Validator<T, OptionalProperty, string>,
  (conflict: Conflict<T>) => T
>;

/** Counter CRDT field descriptor. */
export type CounterFieldDescriptor = TypedFieldDescriptor<
  typeof CrdtType.Counter
>;

/** Set CRDT field descriptor. */
export type SetFieldDescriptor<T> = TypedFieldDescriptor<
  typeof CrdtType.Set,
  Validator<T, OptionalProperty, string>
>;

/** Omitted-field descriptor. */
export type OmittedFieldDescriptor<T> = TypedFieldDescriptor<
  typeof CrdtType.Omitted,
  Validator<T, OptionalProperty, string>
>;

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

/**
 * Check whether an arbitrary value is an embedded CRDT field descriptor.
 *
 * @param value - Value to inspect.
 * @returns `true` when the value is a CRDT field descriptor produced by the
 * embedded schema helpers.
 */
export function isCrdtField(
  value: unknown,
): value is CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    CRDT_FIELD in value &&
    (value as Record<PropertyKey, unknown>)[CRDT_FIELD] === true
  );
}

/**
 * Read the CRDT field kind from a descriptor-like value.
 *
 * @param field - Candidate CRDT field value.
 * @returns The CRDT kind, or `null` when the value is not a descriptor.
 */
export function getCrdtType(field: unknown): CrdtTypeValue | null {
  return isCrdtField(field) ? field.type : null;
}

/** @internal Symbol used to tag embedded CRDT field descriptors. */
export { CRDT_FIELD };

// Definition + define() are owned by `@/shared/schema`. Re-export here so
// existing `from "@/server/schema/core"` imports keep working.
export { define, type DefineOptions, type Definition } from "@/shared/schema";

/**
 * Infer the runtime CRDT kind string for a field descriptor.
 */
export type FieldKindForDescriptor<Field> = Field extends {
  type: typeof CrdtType.Prose;
}
  ? "prose"
  : Field extends { type: typeof CrdtType.Register }
    ? "register"
    : Field extends { type: typeof CrdtType.Set }
      ? "set"
      : Field extends { type: typeof CrdtType.Counter }
        ? "counter"
        : string;

/**
 * Infer the materialized runtime value type for a field descriptor.
 */
export type FieldValueForDescriptor<Field> = Field extends ProseFieldDescriptor
  ? ProseJson
  : Field extends RegisterFieldDescriptor<infer T>
    ? T | undefined
    : Field extends SetFieldDescriptor<infer T>
      ? T[]
      : Field extends CounterFieldDescriptor
        ? number
        : unknown;
