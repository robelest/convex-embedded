import type { Validator } from "convex/values";

// ---------------------------------------------------------------------------
// CRDT types
// ---------------------------------------------------------------------------

export const CrdtType = {
  Prose: "prose",
  Register: "register",
  Counter: "counter",
  Set: "set",
  Plain: "plain",
  Omitted: "omitted",
} as const;

export type CrdtTypeValue = (typeof CrdtType)[keyof typeof CrdtType];

export interface ConflictEntry<T> {
  value: T;
  clientId: string;
  timestamp: number;
}

export interface Conflict<T> {
  values: T[];
  entries: ConflictEntry<T>[];
  latest(): T;
  byClient(id: string): T | undefined;
}

export interface CrdtFieldDescriptor {
  type: CrdtTypeValue;
  validator: unknown;
  resolve?: (conflict: Conflict<unknown>) => unknown;
}

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

export type ProseFieldDescriptor = TypedFieldDescriptor<typeof CrdtType.Prose>;

export type RegisterFieldDescriptor<T> = TypedFieldDescriptor<
  typeof CrdtType.Register,
  Validator<T, any, any>,
  (conflict: Conflict<T>) => T
>;

export type CounterFieldDescriptor = TypedFieldDescriptor<
  typeof CrdtType.Counter
>;

export type SetFieldDescriptor<T> = TypedFieldDescriptor<
  typeof CrdtType.Set,
  Validator<T, any, any>
>;

export type OmittedFieldDescriptor<T> = TypedFieldDescriptor<
  typeof CrdtType.Omitted,
  Validator<T, any, any>
>;

// ---------------------------------------------------------------------------
// Field detection
// ---------------------------------------------------------------------------

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

export function isCrdtField(
  value: unknown,
): value is CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    CRDT_FIELD in value &&
    (value as any)[CRDT_FIELD] === true
  );
}

export function getCrdtType(field: unknown): CrdtTypeValue | null {
  return isCrdtField(field) ? field.type : null;
}

export { CRDT_FIELD };

// ---------------------------------------------------------------------------
// Definition builder
// ---------------------------------------------------------------------------

export type LocalTableMigrationStep = (ctx: {
  table: string;
  fromVersion: number;
  toVersion: number;
  targetVersion: number;
  schema: Definition;
  docs: {
    all(): Promise<Array<Record<string, unknown>>>;
    patchMissing(fields: Record<string, unknown>): Promise<number>;
    patch(id: unknown, fields: Record<string, unknown>): Promise<void>;
    replace(id: unknown, fields: Record<string, unknown>): Promise<void>;
    delete(id: unknown): Promise<void>;
    modify(
      transform: (
        doc: Record<string, unknown>,
      ) =>
        | Record<string, unknown>
        | null
        | void
        | Promise<Record<string, unknown> | null | void>,
    ): Promise<number>;
  };
}) => Promise<void> | void;

export interface DefineOptions {
  version: number;
  shape: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  migrate?: Record<number, LocalTableMigrationStep>;
}

export interface Definition {
  version: number;
  shape: Record<string, unknown>;
  defaults: Record<string, unknown>;
  migrate: Record<number, LocalTableMigrationStep>;
  getShape(): Record<string, unknown>;
  getCrdtFields(): Map<string, CrdtFieldDescriptor>;
  getOmittedFields(): string[];
}

export function define(options: DefineOptions): Definition {
  const { version, shape, defaults = {}, migrate = {} } = options;
  return {
    version,
    shape,
    defaults,
    migrate,
    getShape() {
      return shape;
    },
    getCrdtFields() {
      const fields = new Map<string, CrdtFieldDescriptor>();
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value)) {
          fields.set(key, value);
        }
      }
      return fields;
    },
    getOmittedFields() {
      const omitted: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value) && value.type === CrdtType.Omitted) {
          omitted.push(key);
        }
      }
      return omitted;
    },
  };
}

// ---------------------------------------------------------------------------
// Field value inference
// ---------------------------------------------------------------------------

export type FieldKindForDescriptor<Field> = Field extends ProseFieldDescriptor
  ? "prose"
  : Field extends RegisterFieldDescriptor<any>
    ? "register"
    : Field extends SetFieldDescriptor<any>
      ? "set"
      : Field extends CounterFieldDescriptor
        ? "counter"
        : string;

export type FieldValueForDescriptor<Field> = Field extends ProseFieldDescriptor
  ? ProseJson
  : Field extends RegisterFieldDescriptor<infer T>
    ? T | undefined
    : Field extends SetFieldDescriptor<infer T>
      ? T[]
      : Field extends CounterFieldDescriptor
        ? number
        : unknown;
