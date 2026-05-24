import { compareValues } from "@embedded/runtime/db/compare";
import { describe, expect, it } from "@tests/testkit";
import type { Value } from "convex/values";

/** Create an ArrayBuffer from a list of byte values. */
function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe.concurrent("compareValues", () => {
  describe("cross-type ordering", () => {
    // undefined < null < bigint < number < boolean < string < bytes < array < object
    const ordered: ReadonlyArray<{ label: string; value: Value | undefined }> =
      [
        { label: "undefined", value: undefined },
        { label: "null", value: null },
        { label: "bigint(1n)", value: 1n },
        { label: "number(1)", value: 1 },
        { label: "boolean(true)", value: true },
        { label: 'string("a")', value: "a" },
        { label: "bytes", value: bytes(0x01) },
        { label: "array([])", value: [] },
        { label: "object({})", value: {} },
      ];

    const pairs = ordered.flatMap((lhs, i) =>
      ordered.slice(i + 1).map((rhs) => ({ lhs, rhs })),
    );

    it.for(pairs)("$lhs.label < $rhs.label", ({ lhs, rhs }) => {
      expect(compareValues(lhs.value, rhs.value)).toBeLessThan(0);
    });
  });

  describe("null", () => {
    it("treats null as equal to null", () => {
      expect(compareValues(null, null)).toBe(0);
    });
  });

  describe("numbers", () => {
    it("orders 1 before 2", () => {
      expect(compareValues(1, 2)).toBeLessThan(0);
    });

    it("orders -1 before 0", () => {
      expect(compareValues(-1, 0)).toBeLessThan(0);
    });

    it("treats equal numbers as equal", () => {
      expect(compareValues(42, 42)).toBe(0);
    });

    it("treats NaN as equal to NaN", () => {
      expect(compareValues(NaN, NaN)).toBe(0);
    });

    it("orders NaN after all finite numbers", () => {
      expect(compareValues(Number.MAX_VALUE, NaN)).toBeLessThan(0);
      expect(compareValues(NaN, Number.MAX_VALUE)).toBeGreaterThan(0);
    });

    it("orders NaN after negative infinity", () => {
      expect(compareValues(-Infinity, NaN)).toBeLessThan(0);
    });

    it("orders NaN after zero", () => {
      expect(compareValues(0, NaN)).toBeLessThan(0);
    });

    it("orders negative before positive", () => {
      expect(compareValues(-5, 5)).toBeLessThan(0);
    });
  });

  describe("bigints", () => {
    it("orders 1n before 2n", () => {
      expect(compareValues(1n, 2n)).toBeLessThan(0);
    });

    it("orders -1n before 0n", () => {
      expect(compareValues(-1n, 0n)).toBeLessThan(0);
    });

    it("treats equal bigints as equal", () => {
      expect(compareValues(100n, 100n)).toBe(0);
    });
  });

  describe("booleans", () => {
    it("orders false before true", () => {
      expect(compareValues(false, true)).toBeLessThan(0);
    });

    it("orders true after false", () => {
      expect(compareValues(true, false)).toBeGreaterThan(0);
    });

    it("treats equal booleans as equal", () => {
      expect(compareValues(true, true)).toBe(0);
      expect(compareValues(false, false)).toBe(0);
    });
  });

  describe("strings", () => {
    it("orders by code point", () => {
      expect(compareValues("a", "b")).toBeLessThan(0);
      expect(compareValues("z", "a")).toBeGreaterThan(0);
    });

    it("orders the empty string first", () => {
      expect(compareValues("", "a")).toBeLessThan(0);
    });

    it("orders by the first differing character", () => {
      expect(compareValues("abc", "abd")).toBeLessThan(0);
    });

    it("treats equal strings as equal", () => {
      expect(compareValues("hello", "hello")).toBe(0);
    });
  });

  describe("bytes (ArrayBuffer)", () => {
    it("treats byte-identical buffers as equal", () => {
      expect(compareValues(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(0);
    });

    it("orders by the first differing byte", () => {
      expect(compareValues(bytes(1, 2, 3), bytes(2, 2, 3))).toBeLessThan(0);
    });

    it("orders a shorter buffer before a longer one with the same prefix", () => {
      expect(compareValues(bytes(1, 2), bytes(1, 2, 3))).toBeLessThan(0);
    });

    it("orders an empty buffer before a non-empty one", () => {
      expect(compareValues(bytes(), bytes(1))).toBeLessThan(0);
    });

    it("treats empty buffers as equal", () => {
      expect(compareValues(bytes(), bytes())).toBe(0);
    });
  });

  describe("arrays", () => {
    it("compares element-wise", () => {
      expect(compareValues([1, 2], [2, 1])).toBeLessThan(0);
    });

    it("orders a shorter array before a longer one with the same prefix", () => {
      expect(compareValues([1, 2], [1, 2, 3])).toBeLessThan(0);
    });

    it("treats equal arrays as equal", () => {
      expect(compareValues([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    it("treats empty arrays as equal", () => {
      expect(compareValues([], [])).toBe(0);
    });

    it("orders an empty array before a non-empty one", () => {
      expect(compareValues([], [1])).toBeLessThan(0);
    });

    it("compares nested arrays recursively", () => {
      expect(compareValues([[1]], [[2]])).toBeLessThan(0);
    });
  });

  describe("objects", () => {
    it("treats equal objects as equal", () => {
      expect(compareValues({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(0);
    });

    it("orders by keys first", () => {
      expect(compareValues({ a: 1 }, { b: 1 })).toBeLessThan(0);
    });

    it("orders by value when keys match", () => {
      expect(compareValues({ a: 1 }, { a: 2 })).toBeLessThan(0);
    });

    it("orders fewer keys before more keys with the same prefix", () => {
      expect(compareValues({ a: 1 }, { a: 1, b: 2 })).toBeLessThan(0);
    });

    it("treats empty objects as equal", () => {
      expect(compareValues({}, {})).toBe(0);
    });

    it("ignores source key order (sorts internally)", () => {
      expect(compareValues({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(0);
    });
  });

  describe("symmetry", () => {
    const pairs: ReadonlyArray<{ label: string; a: Value; b: Value }> = [
      { label: "numbers", a: 1, b: 2 },
      { label: "strings", a: "a", b: "b" },
      { label: "booleans", a: false, b: true },
      { label: "bigints", a: 1n, b: 2n },
      { label: "arrays", a: [1], b: [2] },
      { label: "objects", a: { a: 1 }, b: { a: 2 } },
      { label: "cross-type null/number", a: null, b: 1 },
      { label: "cross-type string/array", a: "z", b: [] },
    ];

    it.for(pairs)(
      "$label: compare(a,b) and compare(b,a) have opposite signs",
      ({ a, b }) => {
        expect(Math.sign(compareValues(b, a))).toBe(
          -Math.sign(compareValues(a, b)),
        );
      },
    );
  });

  describe("reflexivity", () => {
    const values: ReadonlyArray<{ label: string; value: Value | undefined }> = [
      { label: "undefined", value: undefined },
      { label: "null", value: null },
      { label: "number 0", value: 0 },
      { label: "number 42", value: 42 },
      { label: "NaN", value: NaN },
      { label: "bigint 0n", value: 0n },
      { label: "bigint 99n", value: 99n },
      { label: "boolean true", value: true },
      { label: "boolean false", value: false },
      { label: 'string "hello"', value: "hello" },
      { label: 'string ""', value: "" },
      { label: "empty array", value: [] },
      { label: "array [1,2,3]", value: [1, 2, 3] },
      { label: "empty object", value: {} },
      { label: "object {a:1}", value: { a: 1 } },
    ];

    it.for(values)("compare($label, $label) === 0", ({ value }) => {
      expect(compareValues(value, value)).toBe(0);
    });
  });
});
