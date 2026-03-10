import { describe, it, expect } from "vitest";

import {
  validateValidator,
  isValidIdentifier,
  tableNameFromId,
  validateFieldNames,
  parseSchema,
} from "#embedded/core/schema";
import type { ValidatorJSON } from "#embedded/core/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand for building an object validator. */
function objectValidator(
  fields: Record<string, { fieldType: ValidatorJSON; optional: boolean }>,
): ValidatorJSON {
  return { type: "object", value: fields };
}

describe("validateValidator", () => {
  // -----------------------------------------------------------------------
  // null validator
  // -----------------------------------------------------------------------

  describe("null validator", () => {
    const validator: ValidatorJSON = { type: "null" };

    it("accepts null", () => {
      expect(() => validateValidator(validator, null)).not.toThrow();
    });

    it("rejects a number", () => {
      expect(() => validateValidator(validator, 42)).toThrow(/null/);
    });

    it("rejects a string", () => {
      expect(() => validateValidator(validator, "hello")).toThrow(/null/);
    });
  });

  // -----------------------------------------------------------------------
  // number validator
  // -----------------------------------------------------------------------

  describe("number validator", () => {
    const validator: ValidatorJSON = { type: "number" };

    it("accepts 42", () => {
      expect(() => validateValidator(validator, 42)).not.toThrow();
    });

    it("accepts 0", () => {
      expect(() => validateValidator(validator, 0)).not.toThrow();
    });

    it("accepts negative numbers", () => {
      expect(() => validateValidator(validator, -3.14)).not.toThrow();
    });

    it("rejects a string", () => {
      expect(() => validateValidator(validator, "42")).toThrow(/number/);
    });
  });

  // -----------------------------------------------------------------------
  // bigint validator
  // -----------------------------------------------------------------------

  describe("bigint validator", () => {
    const validator: ValidatorJSON = { type: "bigint" };

    it("accepts 1n", () => {
      expect(() => validateValidator(validator, 1n)).not.toThrow();
    });

    it("accepts 0n", () => {
      expect(() => validateValidator(validator, 0n)).not.toThrow();
    });

    it("rejects a number", () => {
      expect(() => validateValidator(validator, 1)).toThrow(/bigint/);
    });
  });

  // -----------------------------------------------------------------------
  // boolean validator
  // -----------------------------------------------------------------------

  describe("boolean validator", () => {
    const validator: ValidatorJSON = { type: "boolean" };

    it("accepts true", () => {
      expect(() => validateValidator(validator, true)).not.toThrow();
    });

    it("accepts false", () => {
      expect(() => validateValidator(validator, false)).not.toThrow();
    });

    it("rejects a number", () => {
      expect(() => validateValidator(validator, 1)).toThrow(/boolean/);
    });
  });

  // -----------------------------------------------------------------------
  // string validator
  // -----------------------------------------------------------------------

  describe("string validator", () => {
    const validator: ValidatorJSON = { type: "string" };

    it('accepts "hello"', () => {
      expect(() => validateValidator(validator, "hello")).not.toThrow();
    });

    it("accepts empty string", () => {
      expect(() => validateValidator(validator, "")).not.toThrow();
    });

    it("rejects a number", () => {
      expect(() => validateValidator(validator, 99)).toThrow(/string/);
    });
  });

  // -----------------------------------------------------------------------
  // bytes validator
  // -----------------------------------------------------------------------

  describe("bytes validator", () => {
    const validator: ValidatorJSON = { type: "bytes" };

    it("accepts ArrayBuffer", () => {
      expect(() =>
        validateValidator(validator, new ArrayBuffer(8)),
      ).not.toThrow();
    });

    it("rejects a string", () => {
      expect(() => validateValidator(validator, "bytes")).toThrow(
        /ArrayBuffer/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // any validator
  // -----------------------------------------------------------------------

  describe("any validator", () => {
    const validator: ValidatorJSON = { type: "any" };

    it("accepts null", () => {
      expect(() => validateValidator(validator, null)).not.toThrow();
    });

    it("accepts a number", () => {
      expect(() => validateValidator(validator, 42)).not.toThrow();
    });

    it("accepts a string", () => {
      expect(() => validateValidator(validator, "hello")).not.toThrow();
    });

    it("accepts an object", () => {
      expect(() => validateValidator(validator, { x: 1 })).not.toThrow();
    });

    it("accepts an array", () => {
      expect(() => validateValidator(validator, [1, 2])).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // literal validator
  // -----------------------------------------------------------------------

  describe("literal validator", () => {
    it("accepts the exact matching value (string)", () => {
      const validator: ValidatorJSON = { type: "literal", value: "active" };
      expect(() => validateValidator(validator, "active")).not.toThrow();
    });

    it("rejects a non-matching string", () => {
      const validator: ValidatorJSON = { type: "literal", value: "active" };
      expect(() => validateValidator(validator, "inactive")).toThrow(
        /Expected/,
      );
    });

    it("accepts the exact matching value (number)", () => {
      const validator: ValidatorJSON = { type: "literal", value: 42 };
      expect(() => validateValidator(validator, 42)).not.toThrow();
    });

    it("rejects a different number", () => {
      const validator: ValidatorJSON = { type: "literal", value: 42 };
      expect(() => validateValidator(validator, 43)).toThrow(/Expected/);
    });

    it("accepts the exact matching value (boolean)", () => {
      const validator: ValidatorJSON = { type: "literal", value: true };
      expect(() => validateValidator(validator, true)).not.toThrow();
    });

    it("rejects false when literal is true", () => {
      const validator: ValidatorJSON = { type: "literal", value: true };
      expect(() => validateValidator(validator, false)).toThrow(/Expected/);
    });
  });

  // -----------------------------------------------------------------------
  // id validator
  // -----------------------------------------------------------------------

  describe("id validator", () => {
    const validator: ValidatorJSON = { type: "id", tableName: "messages" };

    it('accepts a valid id string like "10000;messages"', () => {
      expect(() =>
        validateValidator(validator, "10000;messages"),
      ).not.toThrow();
    });

    it("rejects an id for the wrong table", () => {
      expect(() => validateValidator(validator, "10000;users")).toThrow(
        /Expected ID for table/,
      );
    });

    it("rejects a non-string value", () => {
      expect(() => validateValidator(validator, 10000)).toThrow(/string/);
    });

    it("rejects a string without semicolon", () => {
      expect(() => validateValidator(validator, "abc")).toThrow(
        /Expected ID for table/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // array validator
  // -----------------------------------------------------------------------

  describe("array validator", () => {
    const validator: ValidatorJSON = {
      type: "array",
      value: { type: "number" },
    };

    it("accepts an array of matching type", () => {
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

    it("rejects an array with wrong element types", () => {
      expect(() => validateValidator(validator, [1, "two", 3])).toThrow(
        /number/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // union validator
  // -----------------------------------------------------------------------

  describe("union validator", () => {
    const validator: ValidatorJSON = {
      type: "union",
      value: [{ type: "string" }, { type: "number" }],
    };

    it("accepts a string (first variant)", () => {
      expect(() => validateValidator(validator, "hello")).not.toThrow();
    });

    it("accepts a number (second variant)", () => {
      expect(() => validateValidator(validator, 42)).not.toThrow();
    });

    it("rejects a value matching no variant", () => {
      expect(() => validateValidator(validator, true)).toThrow(
        /Expected one of/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // object validator
  // -----------------------------------------------------------------------

  describe("object validator", () => {
    const validator: ValidatorJSON = objectValidator({
      name: { fieldType: { type: "string" }, optional: false },
      age: { fieldType: { type: "number" }, optional: false },
    });

    it("accepts a matching object", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", age: 30 }),
      ).not.toThrow();
    });

    it("rejects missing required field", () => {
      expect(() => validateValidator(validator, { name: "alice" })).toThrow(
        /Missing required field.*age/,
      );
    });

    it("rejects extra fields", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", age: 30, extra: true }),
      ).toThrow(/Unexpected field.*extra/);
    });

    it("rejects wrong field type", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", age: "thirty" }),
      ).toThrow(/number/);
    });

    it("rejects non-object", () => {
      expect(() => validateValidator(validator, "not an object")).toThrow(
        /object/,
      );
    });
  });

  describe("object validator with optional fields", () => {
    const validator: ValidatorJSON = objectValidator({
      name: { fieldType: { type: "string" }, optional: false },
      nickname: { fieldType: { type: "string" }, optional: true },
    });

    it("accepts an object with the optional field present", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", nickname: "al" }),
      ).not.toThrow();
    });

    it("accepts an object with the optional field missing", () => {
      expect(() =>
        validateValidator(validator, { name: "alice" }),
      ).not.toThrow();
    });

    it("rejects if optional field has wrong type", () => {
      expect(() =>
        validateValidator(validator, { name: "alice", nickname: 123 }),
      ).toThrow(/string/);
    });
  });
});

// ---------------------------------------------------------------------------
// isValidIdentifier
// ---------------------------------------------------------------------------

describe("isValidIdentifier", () => {
  it('"_id" is valid', () => {
    expect(isValidIdentifier("_id")).toBe(true);
  });

  it('"_creationTime" is valid', () => {
    expect(isValidIdentifier("_creationTime")).toBe(true);
  });

  it('"validName" is valid', () => {
    expect(isValidIdentifier("validName")).toBe(true);
  });

  it('"name123" is valid', () => {
    expect(isValidIdentifier("name123")).toBe(true);
  });

  it('"myField_name" is valid (underscores allowed in body)', () => {
    expect(isValidIdentifier("myField_name")).toBe(true);
  });

  it('"123invalid" is invalid (starts with digit)', () => {
    expect(isValidIdentifier("123invalid")).toBe(false);
  });

  it('"no-dashes" is invalid (contains dash)', () => {
    expect(isValidIdentifier("no-dashes")).toBe(false);
  });

  it('"" is invalid (empty string)', () => {
    expect(isValidIdentifier("")).toBe(false);
  });

  it('"has spaces" is invalid', () => {
    expect(isValidIdentifier("has spaces")).toBe(false);
  });

  it('"_other" is invalid (leading underscore but not _id or _creationTime)', () => {
    expect(isValidIdentifier("_other")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tableNameFromId
// ---------------------------------------------------------------------------

describe("tableNameFromId", () => {
  it('"10000;messages" → "messages"', () => {
    expect(tableNameFromId("10000;messages")).toBe("messages");
  });

  it('"abc" → null (no semicolon)', () => {
    expect(tableNameFromId("abc")).toBe(null);
  });

  it('";" → "" (empty table name)', () => {
    expect(tableNameFromId(";")).toBe("");
  });

  it('"99;users" → "users"', () => {
    expect(tableNameFromId("99;users")).toBe("users");
  });

  it('"a;b;c" → null (multiple semicolons)', () => {
    expect(tableNameFromId("a;b;c")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// validateFieldNames
// ---------------------------------------------------------------------------

describe("validateFieldNames", () => {
  it("validates field names in an object validator — valid names pass", () => {
    const validator: ValidatorJSON = objectValidator({
      name: { fieldType: { type: "string" }, optional: false },
      age: { fieldType: { type: "number" }, optional: false },
    });
    expect(() => validateFieldNames(validator)).not.toThrow();
  });

  it("throws for invalid field names in an object validator", () => {
    const validator: ValidatorJSON = objectValidator({
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
    const validator: ValidatorJSON = { type: "string" };
    expect(() => validateFieldNames(validator)).not.toThrow();
  });

  it("allows _id and _creationTime as field names", () => {
    const validator: ValidatorJSON = objectValidator({
      _id: { fieldType: { type: "string" }, optional: false },
      _creationTime: { fieldType: { type: "number" }, optional: false },
    });
    expect(() => validateFieldNames(validator)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseSchema
// ---------------------------------------------------------------------------

describe("parseSchema", () => {
  it("parses a schema object with .export() on table definitions", () => {
    const fakeSchema = {
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
    expect(parsed.tables.has("messages")).toBe(true);
    expect(parsed.tables.get("messages")!.indexes).toEqual([]);
  });

  it("handles multiple tables", () => {
    const fakeSchema = {
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
    expect(parsed.tables.get("users")!.indexes).toHaveLength(1);
  });
});
