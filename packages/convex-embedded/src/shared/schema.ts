import type { MigrationsMap, MigrationStep } from "@/shared/migrations/types";
import { targetVersionFromMigrations } from "@/shared/migrations/types";
import type { CrdtFieldDescriptor } from "@/shared/types";
import { CrdtType } from "@/shared/types";

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

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

export function getCrdtType(field: unknown): CrdtType | null {
  if (isCrdtField(field)) return field.type;
  return null;
}

/** @deprecated Re-exported for transitional uses; prefer `MigrationStep`. */
export type LocalTableMigrationStep = MigrationStep;

export interface DefineOptions {
  shape: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  migrations?: MigrationsMap;
}

export interface Definition {
  version: number;
  shape: Record<string, unknown>;
  defaults: Record<string, unknown>;
  migrations: MigrationsMap;
  getShape(): Record<string, unknown>;
  getCrdtFields(): Map<string, CrdtFieldDescriptor>;
  getOmittedFields(): string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function hasTables(
  value: unknown,
): value is { tables: Record<string, unknown> } {
  const record = asRecord(value);
  return Boolean(record?.tables && typeof record.tables === "object");
}

function readEmbeddedDefinition(value: unknown): Definition | null {
  const schema = asRecord(value)?.schema;
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const candidate = schema as Partial<Definition>;
  return typeof candidate.version === "number" && candidate.shape
    ? (schema as Definition)
    : null;
}

export function extractConvexSchemaExport(schemaInput: unknown): unknown {
  if (hasTables(schemaInput)) {
    return schemaInput;
  }
  const defaultExport = asRecord(schemaInput)?.default;
  return hasTables(defaultExport) ? defaultExport : null;
}

export function extractEmbeddedTableDefinitions(
  schemaInput: unknown,
): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  const moduleRecord = asRecord(schemaInput);
  const convexSchema = asRecord(extractConvexSchemaExport(schemaInput));
  const tables = asRecord(convexSchema?.tables);

  if (tables) {
    for (const [tableName, tableDef] of Object.entries(tables)) {
      const definition =
        readEmbeddedDefinition(tableDef) ??
        readEmbeddedDefinition(moduleRecord?.[tableName]);
      if (definition) {
        definitions.set(tableName, definition);
      }
    }
  }

  if (moduleRecord) {
    for (const value of Object.values(moduleRecord)) {
      const tableName = asRecord(value)?.table;
      if (typeof tableName !== "string" || definitions.has(tableName)) {
        continue;
      }
      const definition = readEmbeddedDefinition(value);
      if (definition) {
        definitions.set(tableName, definition);
      }
    }
  }

  return definitions;
}

export function define(options: DefineOptions): Definition {
  const { shape, defaults = {}, migrations = {} } = options;
  const version = targetVersionFromMigrations(migrations);

  let cachedCrdtFields: Map<string, CrdtFieldDescriptor> | null = null;
  let cachedOmittedFields: string[] | null = null;

  return {
    version,
    shape,
    defaults,
    migrations,
    getShape() {
      return shape;
    },
    getCrdtFields() {
      if (cachedCrdtFields) return cachedCrdtFields;
      const fields = new Map<string, CrdtFieldDescriptor>();
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value)) {
          fields.set(key, value);
        }
      }
      cachedCrdtFields = fields;
      return fields;
    },
    getOmittedFields() {
      if (cachedOmittedFields) return cachedOmittedFields;
      const omitted: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value) && value.type === CrdtType.Omitted) {
          omitted.push(key);
        }
      }
      cachedOmittedFields = omitted;
      return omitted;
    },
  };
}
