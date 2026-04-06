/**
 * Schema validation for Convex documents.
 *
 * Ported from convex-test. Validates documents against the exported
 * ValidatorJSON shape that `SchemaDefinition.export()` produces.
 */
import type { JSONValue, Value } from "convex/values";
import { convexToJson } from "convex/values";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ObjectFieldType = {
  fieldType: ValidatorJSON;
  optional: boolean;
};

export type ValidatorJSON =
  | { type: "null" }
  | { type: "number" }
  | { type: "bigint" }
  | { type: "boolean" }
  | { type: "string" }
  | { type: "bytes" }
  | { type: "any" }
  | { type: "literal"; value: JSONValue }
  | { type: "id"; tableName: string }
  | { type: "array"; value: ValidatorJSON }
  | { type: "object"; value: Record<string, ObjectFieldType> }
  | { type: "union"; value: ValidatorJSON[] };

export type IndexDefinition = {
  indexDescriptor: string;
  fields: string[];
};

export type VectorIndexDefinition = {
  indexDescriptor: string;
  vectorField: string;
  dimensions: number;
  filterFields: string[];
};

export type SearchIndexDefinition = {
  indexDescriptor: string;
  searchField: string;
  filterFields: string[];
};

export type TableSchema = {
  indexes: IndexDefinition[];
  vectorIndexes: VectorIndexDefinition[];
  searchIndexes?: SearchIndexDefinition[];
  documentType: ValidatorJSON;
};

export type ParsedSchema = {
  schemaValidation: boolean;
  tables: Map<string, TableSchema>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up the table name for a given document ID.
 *
 * Accepts an optional `lookup` function backed by `Database._idTableMap`.
 * When no lookup is provided, returns `null` (the ID cannot be resolved
 * without the runtime map).
 */
export function tableNameFromId(
  id: string,
  lookup?: (id: string) => string | undefined,
): string | null {
  if (lookup) {
    return lookup(id) ?? null;
  }
  return null;
}

function isSimpleObject(value: unknown): boolean {
  const isObject = typeof value === "object";
  const prototype = Object.getPrototypeOf(value);
  const isSimple =
    prototype === null ||
    prototype === Object.prototype ||
    prototype?.constructor?.name === "Object";
  return isObject && isSimple;
}

function formatValueForError(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value instanceof ArrayBuffer) {
    return `ArrayBuffer(${value.byteLength})`;
  }
  try {
    return JSON.stringify(convexToJson(value as Value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Check whether a string is a valid Convex identifier (table/field/index name). */
export function isValidIdentifier(name: string): boolean {
  return /(^_(id|creationTime)$)|^[a-zA-Z][a-zA-Z0-9_]*$/.test(name);
}

function validateFieldPath(fieldPath: string, errorPrefix: string): void {
  if (!fieldPath.includes(".") && !isValidIdentifier(fieldPath)) {
    throw new Error(
      `${errorPrefix} must be valid identifiers, got "${fieldPath}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a document value against a ValidatorJSON tree.
 *
 * @param idLookup  Optional function that maps a UUID string to its table
 *                  name. Required for `v.id("tableName")` validation when
 *                  using UUID-based IDs.
 */
export function validateValidator(
  validator: ValidatorJSON,
  value: Value,
  idLookup?: (id: string) => string | undefined,
): void {
  switch (validator.type) {
    case "null":
      if (value !== null) {
        throw new Error(
          `Validator error: Expected \`null\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "number":
      if (typeof value !== "number") {
        throw new Error(
          `Validator error: Expected \`number\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "bigint":
      if (typeof value !== "bigint") {
        throw new Error(
          `Validator error: Expected \`bigint\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(
          `Validator error: Expected \`boolean\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "string":
      if (typeof value !== "string") {
        throw new Error(
          `Validator error: Expected \`string\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "bytes":
      if (!(value instanceof ArrayBuffer)) {
        throw new Error(
          `Validator error: Expected \`ArrayBuffer\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "any":
      return;

    case "literal":
      if (value !== validator.value) {
        throw new Error(
          `Validator error: Expected \`${formatValueForError(validator.value)}\`, got \`${formatValueForError(value)}\``,
        );
      }
      return;

    case "id":
      if (typeof value !== "string") {
        throw new Error(
          `Validator error: Expected \`string\`, got \`${formatValueForError(value)}\``,
        );
      }
      if (tableNameFromId(value, idLookup) !== validator.tableName) {
        throw new Error(
          `Validator error: Expected ID for table "${validator.tableName}", got \`${value}\``,
        );
      }
      return;

    case "array":
      if (!Array.isArray(value)) {
        throw new Error(
          `Validator error: Expected \`Array\`, got \`${formatValueForError(value)}\``,
        );
      }
      for (const v of value) {
        validateValidator(validator.value, v, idLookup);
      }
      return;

    case "union": {
      let isValid = false;
      for (const v of validator.value) {
        try {
          validateValidator(v, value, idLookup);
          isValid = true;
          break;
        } catch {
          // try next variant
        }
      }
      if (!isValid) {
        throw new Error(
          `Validator error: Expected one of ${validator.value.map((v) => v.type).join(", ")}, got \`${JSON.stringify(convexToJson(value))}\``,
        );
      }
      return;
    }

    case "object":
      if (typeof value !== "object") {
        throw new Error(
          `Validator error: Expected \`object\`, got \`${formatValueForError(value)}\``,
        );
      }
      if (!isSimpleObject(value)) {
        throw new Error(
          `Validator error: Expected a plain old JavaScript \`object\`, got \`${formatValueForError(value)}\``,
        );
      }
      {
        const obj = value as Record<string, Value | undefined>;
        for (const [k, { fieldType, optional }] of Object.entries(
          validator.value,
        )) {
          if (obj[k] === undefined) {
            if (!optional) {
              throw new Error(
                `Validator error: Missing required field \`${k}\` in object`,
              );
            }
          } else {
            validateValidator(fieldType, obj[k]!, idLookup);
          }
        }
        for (const k of Object.keys(obj)) {
          if (validator.value[k] === undefined) {
            throw new Error(
              `Validator error: Unexpected field \`${k}\` in object`,
            );
          }
        }
      }
      return;
  }
}

/** Validate field names within a validator tree (must be valid identifiers). */
export function validateFieldNames(validator: ValidatorJSON): void {
  if (validator.type === "object") {
    for (const fieldName of Object.keys(validator.value)) {
      if (!isValidIdentifier(fieldName)) {
        throw new Error(
          `Field names must be valid identifiers, got "${fieldName}"`,
        );
      }
    }
  }
  if (validator.type === "union") {
    validator.value.forEach(validateFieldNames);
  }
}

/**
 * Parse a SchemaDefinition export into our internal ParsedSchema.
 *
 * `schema` is expected to be the default export from a Convex `schema.ts`
 * file. We call the private `.export()` on each table definition, matching
 * what `convex-test` does.
 */
/** Shape of the object returned by a Convex SchemaDefinition's internal export. */
export interface SchemaExport {
  schemaValidation: boolean;
  tables: Record<string, { export(): TableSchema }>;
}

export function parseSchema(schema: SchemaExport): ParsedSchema {
  return {
    schemaValidation: schema.schemaValidation,
    tables: new Map(
      Object.entries(schema.tables).map(
        ([name, tableSchema]: [string, { export(): TableSchema }]) => [
          name,
          tableSchema.export(),
        ],
      ),
    ),
  };
}

/** Validate a full schema (table names, field names, index names). */
export function validateSchemaDefinition(schema: ParsedSchema): void {
  schema.tables.forEach((table, tableName) => {
    if (!isValidIdentifier(tableName)) {
      throw new Error(
        `Table names must be valid identifiers, got "${tableName}"`,
      );
    }
    validateFieldNames(table.documentType);
    table.indexes.forEach(({ indexDescriptor }) => {
      if (!isValidIdentifier(indexDescriptor)) {
        throw new Error(
          `Index names must be valid identifiers, got "${indexDescriptor}"`,
        );
      }
    });
    if (table.vectorIndexes.length > 4) {
      throw new Error(
        `Tables can have at most 4 vector indexes, got ${table.vectorIndexes.length}`,
      );
    }
    table.vectorIndexes.forEach(
      ({ indexDescriptor, vectorField, dimensions, filterFields }) => {
        if (!isValidIdentifier(indexDescriptor)) {
          throw new Error(
            `Vector index names must be valid identifiers, got "${indexDescriptor}"`,
          );
        }
        validateFieldPath(vectorField, "Vector field names");
        if (
          !Number.isInteger(dimensions) ||
          dimensions < 2 ||
          dimensions > 4096
        ) {
          throw new Error(
            `Vector index dimensions must be an integer between 2 and 4096, got ${dimensions}`,
          );
        }
        if (filterFields.length > 16) {
          throw new Error(
            `Vector indexes support at most 16 filter fields, got ${filterFields.length}`,
          );
        }
        for (const fieldPath of filterFields) {
          validateFieldPath(fieldPath, "Vector filter field names");
        }
      },
    );
    table.searchIndexes?.forEach(
      ({ indexDescriptor, searchField, filterFields }) => {
        if (!isValidIdentifier(indexDescriptor)) {
          throw new Error(
            `Search index names must be valid identifiers, got "${indexDescriptor}"`,
          );
        }
        validateFieldPath(searchField, "Search field names");
        for (const fieldPath of filterFields) {
          validateFieldPath(fieldPath, "Search filter field names");
        }
      },
    );
  });
}
