/**
 * Schema validation for Convex documents.
 *
 * Ported from convex-test. Validates documents against the exported
 * ValidatorJSON shape that `SchemaDefinition.export()` produces.
 */
import type { JSONValue, Value } from "convex/values";
import { convexToJson, jsonToConvex } from "convex/values";

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

/** Extract table name from our `"<number>;<tableName>"` ID format. */
export function tableNameFromId(id: string): string | null {
  const parts = id.split(";");
  if (parts.length !== 2) return null;
  return parts[1];
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

/** Check whether a string is a valid Convex identifier (table/field/index name). */
export function isValidIdentifier(name: string): boolean {
  return /(^_(id|creationTime)$)|^[a-zA-Z][a-zA-Z0-9_]*$/.test(name);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a document value against a ValidatorJSON tree. */
export function validateValidator(validator: ValidatorJSON, value: any): void {
  switch (validator.type) {
    case "null":
      if (value !== null) {
        throw new Error(`Validator error: Expected \`null\`, got \`${value}\``);
      }
      return;

    case "number":
      if (typeof value !== "number") {
        throw new Error(
          `Validator error: Expected \`number\`, got \`${value}\``,
        );
      }
      return;

    case "bigint":
      if (typeof value !== "bigint") {
        throw new Error(
          `Validator error: Expected \`bigint\`, got \`${value}\``,
        );
      }
      return;

    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(
          `Validator error: Expected \`boolean\`, got \`${value}\``,
        );
      }
      return;

    case "string":
      if (typeof value !== "string") {
        throw new Error(
          `Validator error: Expected \`string\`, got \`${value}\``,
        );
      }
      return;

    case "bytes":
      if (!(value instanceof ArrayBuffer)) {
        throw new Error(
          `Validator error: Expected \`ArrayBuffer\`, got \`${value}\``,
        );
      }
      return;

    case "any":
      return;

    case "literal":
      if (value !== validator.value) {
        throw new Error(
          `Validator error: Expected \`${validator.value as any}\`, got \`${value}\``,
        );
      }
      return;

    case "id":
      if (typeof value !== "string") {
        throw new Error(
          `Validator error: Expected \`string\`, got \`${value}\``,
        );
      }
      if (tableNameFromId(value) !== validator.tableName) {
        throw new Error(
          `Validator error: Expected ID for table "${validator.tableName}", got \`${value}\``,
        );
      }
      return;

    case "array":
      if (!Array.isArray(value)) {
        throw new Error(
          `Validator error: Expected \`Array\`, got \`${value}\``,
        );
      }
      for (const v of value) {
        validateValidator(validator.value, v);
      }
      return;

    case "union": {
      let isValid = false;
      for (const v of validator.value) {
        try {
          validateValidator(v, value);
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
          `Validator error: Expected \`object\`, got \`${value}\``,
        );
      }
      if (!isSimpleObject(value)) {
        throw new Error(
          `Validator error: Expected a plain old JavaScript \`object\`, got \`${value}\``,
        );
      }
      for (const [k, { fieldType, optional }] of Object.entries(
        validator.value,
      )) {
        if (value[k] === undefined) {
          if (!optional) {
            throw new Error(
              `Validator error: Missing required field \`${k}\` in object`,
            );
          }
        } else {
          validateValidator(fieldType, value[k]);
        }
      }
      for (const k of Object.keys(value)) {
        if (validator.value[k] === undefined) {
          throw new Error(
            `Validator error: Unexpected field \`${k}\` in object`,
          );
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
export function parseSchema(schema: any): ParsedSchema {
  return {
    schemaValidation: schema.schemaValidation,
    tables: new Map(
      Object.entries(schema.tables).map(([name, tableSchema]: [string, any]) => [
        name,
        tableSchema.export(),
      ]),
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
  });
}
