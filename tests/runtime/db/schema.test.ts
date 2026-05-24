import {
  isValidIdentifier,
  parseSchema,
  tableNameFromId,
  validateFieldNames,
  validateSchemaDefinition,
  validateValidator,
  type ParsedSchema,
  type SchemaExport,
  type TableSchema,
  type ValidatorJSON,
} from "@embedded/runtime/db/schema";
import { describe, expect, it } from "@tests/testkit";
import type { Value } from "convex/values";

function objectValidator(
  fields: Record<string, { fieldType: ValidatorJSON; optional: boolean }>,
): ValidatorJSON {
  return { type: "object", value: fields };
}

function tableSchema(table: Partial<TableSchema> = {}): TableSchema {
  return {
    indexes: [],
    vectorIndexes: [],
    searchIndexes: [],
    documentType: { type: "any" },
    ...table,
  };
}

describe.concurrent("validateValidator", () => {
  describe("scalar validators", () => {
    const accepts: ReadonlyArray<{
      label: string;
      validator: ValidatorJSON;
      value: Value;
    }> = [
      { label: "null accepts null", validator: { type: "null" }, value: null },
      { label: "number accepts 42", validator: { type: "number" }, value: 42 },
      { label: "number accepts 0", validator: { type: "number" }, value: 0 },
      {
        label: "number accepts negatives",
        validator: { type: "number" },
        value: -3.14,
      },
      { label: "bigint accepts 1n", validator: { type: "bigint" }, value: 1n },
      { label: "bigint accepts 0n", validator: { type: "bigint" }, value: 0n },
      {
        label: "boolean accepts true",
        validator: { type: "boolean" },
        value: true,
      },
      {
        label: "boolean accepts false",
        validator: { type: "boolean" },
        value: false,
      },
      {
        label: 'string accepts "hello"',
        validator: { type: "string" },
        value: "hello",
      },
      {
        label: "string accepts empty",
        validator: { type: "string" },
        value: "",
      },
      {
        label: "bytes accepts ArrayBuffer",
        validator: { type: "bytes" },
        value: new ArrayBuffer(8),
      },
    ];

    it.for(accepts)("$label", ({ validator, value }) => {
      expect(() => validateValidator(validator, value)).not.toThrow();
    });

    const rejects: ReadonlyArray<{
      label: string;
      validator: ValidatorJSON;
      value: Value;
      message: RegExp;
    }> = [
      {
        label: "null rejects a number",
        validator: { type: "null" },
        value: 42,
        message: /null/,
      },
      {
        label: "null rejects a string",
        validator: { type: "null" },
        value: "hello",
        message: /null/,
      },
      {
        label: "number rejects a string",
        validator: { type: "number" },
        value: "42",
        message: /number/,
      },
      {
        label: "bigint rejects a number",
        validator: { type: "bigint" },
        value: 1,
        message: /bigint/,
      },
      {
        label: "boolean rejects a number",
        validator: { type: "boolean" },
        value: 1,
        message: /boolean/,
      },
      {
        label: "string rejects a number",
        validator: { type: "string" },
        value: 99,
        message: /string/,
      },
      {
        label: "bytes rejects a string",
        validator: { type: "bytes" },
        value: "bytes",
        message: /ArrayBuffer/,
      },
    ];

    it.for(rejects)("$label", ({ validator, value, message }) => {
      expect(() => validateValidator(validator, value)).toThrow(message);
    });
  });

  describe("any validator", () => {
    const validator: ValidatorJSON = { type: "any" };
    const values: ReadonlyArray<{ label: string; value: Value }> = [
      { label: "null", value: null },
      { label: "number", value: 42 },
      { label: "string", value: "hello" },
      { label: "object", value: { x: 1 } },
      { label: "array", value: [1, 2] },
    ];

    it.for(values)("accepts $label", ({ value }) => {
      expect(() => validateValidator(validator, value)).not.toThrow();
    });
  });

  describe("literal validator", () => {
    it("accepts the exact matching string", () => {
      expect(() =>
        validateValidator({ type: "literal", value: "active" }, "active"),
      ).not.toThrow();
    });

    it("rejects a non-matching string", () => {
      expect(() =>
        validateValidator({ type: "literal", value: "active" }, "inactive"),
      ).toThrow(/Expected/);
    });

    it("accepts the exact matching number", () => {
      expect(() =>
        validateValidator({ type: "literal", value: 42 }, 42),
      ).not.toThrow();
    });

    it("rejects a different number", () => {
      expect(() =>
        validateValidator({ type: "literal", value: 42 }, 43),
      ).toThrow(/Expected/);
    });

    it("accepts the exact matching boolean", () => {
      expect(() =>
        validateValidator({ type: "literal", value: true }, true),
      ).not.toThrow();
    });

    it("rejects false when the literal is true", () => {
      expect(() =>
        validateValidator({ type: "literal", value: true }, false),
      ).toThrow(/Expected/);
    });
  });

  describe("id validator", () => {
    const validator: ValidatorJSON = { type: "id", tableName: "messages" };

    it("accepts an id whose lookup resolves to the matching table", () => {
      const lookup = (id: string) =>
        id === "test-uuid" ? "messages" : undefined;

      expect(() =>
        validateValidator(validator, "test-uuid", lookup),
      ).not.toThrow();
    });

    it("rejects an id that resolves to a different table", () => {
      const lookup = (id: string) => (id === "test-uuid" ? "users" : undefined);

      expect(() => validateValidator(validator, "test-uuid", lookup)).toThrow(
        /Expected ID for table/,
      );
    });

    it("rejects a non-string value", () => {
      expect(() => validateValidator(validator, 10000)).toThrow(/string/);
    });

    it("rejects a string with no lookup match", () => {
      expect(() =>
        validateValidator(validator, "abc", () => undefined),
      ).toThrow(/Expected ID for table/);
    });
  });

  describe("array validator", () => {
    const validator: ValidatorJSON = {
      type: "array",
      value: { type: "number" },
    };

    it("accepts an array of the element type", () => {
      expect(() => validateValidator(validator, [1, 2, 3])).not.toThrow();
    });

    it("accepts an empty array", () => {
      expect(() => validateValidator(validator, [])).not.toThrow();
    });

    it("rejects a non-array", () => {
      expect(() => validateValidator(validator, "not an array")).toThrow(
        /Array/,
      );
    });

    it("rejects wrong element types", () => {
      expect(() => validateValidator(validator, [1, "two", 3])).toThrow(
        /number/,
      );
    });
  });

  describe("union validator", () => {
    const validator: ValidatorJSON = {
      type: "union",
      value: [{ type: "string" }, { type: "number" }],
    };

    it("accepts the first variant", () => {
      expect(() => validateValidator(validator, "hello")).not.toThrow();
    });

    it("accepts the second variant", () => {
      expect(() => validateValidator(validator, 42)).not.toThrow();
    });

    it("rejects a value matching no variant", () => {
      expect(() => validateValidator(validator, true)).toThrow(
        /Expected one of/,
      );
    });
  });

  describe("object validator", () => {
    const validator = objectValidator({
      name: { fieldType: { type: "string" }, optional: false },
      age: { fieldType: { type: "number" }, optional: false },
    });

    it("accepts a matching object", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", age: 30 }),
      ).not.toThrow();
    });

    it("rejects a missing required field", () => {
      expect(() => validateValidator(validator, { name: "alice" })).toThrow(
        /Missing required field.*age/,
      );
    });

    it("rejects extra fields", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", age: 30, extra: true }),
      ).toThrow(/Unexpected field.*extra/);
    });

    it("rejects a wrong field type", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", age: "thirty" }),
      ).toThrow(/number/);
    });

    it("rejects a non-object", () => {
      expect(() => validateValidator(validator, "not an object")).toThrow(
        /object/,
      );
    });
  });

  describe("object validator with optional fields", () => {
    const validator = objectValidator({
      name: { fieldType: { type: "string" }, optional: false },
      nickname: { fieldType: { type: "string" }, optional: true },
    });

    it("accepts the optional field when present", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", nickname: "al" }),
      ).not.toThrow();
    });

    it("accepts the optional field when missing", () => {
      expect(() =>
        validateValidator(validator, { name: "alice" }),
      ).not.toThrow();
    });

    it("rejects the optional field with a wrong type", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", nickname: 123 }),
      ).toThrow(/string/);
    });
  });
});

describe.concurrent("isValidIdentifier", () => {
  const cases: ReadonlyArray<{ name: string; valid: boolean; why: string }> = [
    { name: "_id", valid: true, why: "_id reserved field" },
    { name: "_creationTime", valid: true, why: "_creationTime reserved field" },
    { name: "validName", valid: true, why: "plain identifier" },
    { name: "name123", valid: true, why: "trailing digits" },
    { name: "myField_name", valid: true, why: "underscores in body" },
    { name: "123invalid", valid: false, why: "leading digit" },
    { name: "no-dashes", valid: false, why: "contains dash" },
    { name: "", valid: false, why: "empty string" },
    { name: "has spaces", valid: false, why: "contains space" },
    { name: "_other", valid: false, why: "leading underscore not reserved" },
  ];

  it.for(cases)("$why: $name -> $valid", ({ name, valid }) => {
    expect(isValidIdentifier(name)).toBe(valid);
  });
});

describe.concurrent("tableNameFromId", () => {
  const lookup = (id: string): string | undefined =>
    ({ "uuid-1": "messages", "uuid-2": "users" })[id];

  it("returns the table name when the lookup matches", () => {
    expect(tableNameFromId("uuid-1", lookup)).toBe("messages");
  });

  it("returns null when no lookup is provided", () => {
    expect(tableNameFromId("anything")).toBeNull();
  });

  it("returns null when the lookup returns undefined", () => {
    expect(tableNameFromId("unknown-id", lookup)).toBeNull();
  });

  it("resolves different IDs to their tables", () => {
    expect(tableNameFromId("uuid-2", lookup)).toBe("users");
  });
});

describe.concurrent("validateFieldNames", () => {
  it("passes valid field names in an object validator", () => {
    const validator = objectValidator({
      name: { fieldType: { type: "string" }, optional: false },
      age: { fieldType: { type: "number" }, optional: false },
    });

    expect(() => validateFieldNames(validator)).not.toThrow();
  });

  it("throws for invalid field names in an object validator", () => {
    const validator = objectValidator({
      "invalid-name": { fieldType: { type: "string" }, optional: false },
    });

    expect(() => validateFieldNames(validator)).toThrow(/valid identifiers/);
  });

  it("recurses into union variants", () => {
    const validator: ValidatorJSON = {
      type: "union",
      value: [
        objectValidator({
          name: { fieldType: { type: "string" }, optional: false },
        }),
        objectValidator({
          "bad-field": { fieldType: { type: "number" }, optional: false },
        }),
      ],
    };

    expect(() => validateFieldNames(validator)).toThrow(/valid identifiers/);
  });

  it("does not throw for non-object validators", () => {
    expect(() => validateFieldNames({ type: "string" })).not.toThrow();
  });

  it("allows _id and _creationTime as field names", () => {
    const validator = objectValidator({
      _id: { fieldType: { type: "string" }, optional: false },
      _creationTime: { fieldType: { type: "number" }, optional: false },
    });

    expect(() => validateFieldNames(validator)).not.toThrow();
  });
});

describe.concurrent("parseSchema", () => {
  it("parses a schema by calling .export() on each table", () => {
    const fakeSchema: SchemaExport = {
      schemaValidation: true,
      tables: {
        messages: {
          export: () => ({
            indexes: [],
            vectorIndexes: [],
            documentType: { type: "object", value: {} },
          }),
        },
      },
    };

    const parsed = parseSchema(fakeSchema);

    expect(parsed.schemaValidation).toBe(true);
    expect(parsed.tables).toBeInstanceOf(Map);
    expect(parsed.tables.get("messages")?.indexes).toEqual([]);
  });

  it("parses multiple tables", () => {
    const fakeSchema: SchemaExport = {
      schemaValidation: false,
      tables: {
        messages: {
          export: () => ({
            indexes: [],
            vectorIndexes: [],
            documentType: { type: "any" },
          }),
        },
        users: {
          export: () => ({
            indexes: [{ indexDescriptor: "by_email", fields: ["email"] }],
            vectorIndexes: [],
            documentType: { type: "any" },
          }),
        },
      },
    };

    const parsed = parseSchema(fakeSchema);

    expect(parsed.schemaValidation).toBe(false);
    expect(parsed.tables.size).toBe(2);
    expect(parsed.tables.get("users")?.indexes).toHaveLength(1);
  });
});

describe.concurrent("validateSchemaDefinition", () => {
  const withVectorIndex = (
    vectorIndex: TableSchema["vectorIndexes"][number],
  ): ParsedSchema => ({
    schemaValidation: false,
    tables: new Map([["tasks", tableSchema({ vectorIndexes: [vectorIndex] })]]),
  });

  it("accepts a valid vector index definition", () => {
    expect(() =>
      validateSchemaDefinition(
        withVectorIndex({
          indexDescriptor: "by_embedding",
          vectorField: "embedding",
          dimensions: 128,
          filterFields: ["status", "properties.kind"],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects vector index dimensions out of range", () => {
    expect(() =>
      validateSchemaDefinition(
        withVectorIndex({
          indexDescriptor: "by_embedding",
          vectorField: "embedding",
          dimensions: 1,
          filterFields: [],
        }),
      ),
    ).toThrow(/between 2 and 4096/);
  });

  it("rejects invalid vector filter field names", () => {
    expect(() =>
      validateSchemaDefinition(
        withVectorIndex({
          indexDescriptor: "by_embedding",
          vectorField: "embedding",
          dimensions: 2,
          filterFields: ["bad-field"],
        }),
      ),
    ).toThrow(/Vector filter field names/);
  });
});
