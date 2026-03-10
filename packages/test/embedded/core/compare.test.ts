import { describe, it, expect } from "vitest";

import { compareValues } from "#embedded/core/compare";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an ArrayBuffer from a list of byte values. */
function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("compareValues", () => {
  // -----------------------------------------------------------------------
  // Cross-type ordering
  // -----------------------------------------------------------------------

  describe("cross-type ordering", () => {
    // The total order is:
    // undefined < null < bigint < number < boolean < string < bytes < array < object
    const ordered: Array<{ label: string; value: any }> = [
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

    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        it(`${ordered[i].label} < ${ordered[j].label}`, () => {
          expect(
            compareValues(ordered[i].value, ordered[j].value),
          ).toBeLessThan(0);
        });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Same-type comparisons
  // -----------------------------------------------------------------------

  describe("null", () => {
    it("null === null → 0", () => {
      expect(compareValues(null, null)).toBe(0);
    });
  });

  describe("numbers", () => {
    it("1 < 2", () => {
      expect(compareValues(1, 2)).toBeLessThan(0);
    });

    it("-1 < 0", () => {
      expect(compareValues(-1, 0)).toBeLessThan(0);
    });

    it("0 === 0", () => {
      expect(compareValues(0, 0)).toBe(0);
    });

    it("NaN === NaN", () => {
      expect(compareValues(NaN, NaN)).toBe(0);
    });

    it("NaN comes after all finite numbers", () => {
      expect(compareValues(Number.MAX_VALUE, NaN)).toBeLessThan(0);
      expect(compareValues(NaN, Number.MAX_VALUE)).toBeGreaterThan(0);
    });

    it("NaN comes after negative numbers", () => {
      expect(compareValues(-Infinity, NaN)).toBeLessThan(0);
    });

    it("NaN comes after 0", () => {
      expect(compareValues(0, NaN)).toBeLessThan(0);
    });

    it("negative < positive", () => {
      expect(compareValues(-5, 5)).toBeLessThan(0);
    });

    it("equal numbers return 0", () => {
      expect(compareValues(42, 42)).toBe(0);
    });
  });

  describe("bigints", () => {
    it("1n < 2n", () => {
      expect(compareValues(1n, 2n)).toBeLessThan(0);
    });

    it("-1n < 0n", () => {
      expect(compareValues(-1n, 0n)).toBeLessThan(0);
    });

    it("0n === 0n", () => {
      expect(compareValues(0n, 0n)).toBe(0);
    });

    it("equal bigints return 0", () => {
      expect(compareValues(100n, 100n)).toBe(0);
    });
  });

  describe("booleans", () => {
    it("false < true", () => {
      expect(compareValues(false, true)).toBeLessThan(0);
    });

    it("true > false", () => {
      expect(compareValues(true, false)).toBeGreaterThan(0);
    });

    it("true === true", () => {
      expect(compareValues(true, true)).toBe(0);
    });

    it("false === false", () => {
      expect(compareValues(false, false)).toBe(0);
    });
  });

  describe("strings", () => {
    it('"a" < "b"', () => {
      expect(compareValues("a", "b")).toBeLessThan(0);
    });

    it('"" < "a"', () => {
      expect(compareValues("", "a")).toBeLessThan(0);
    });

    it('"abc" < "abd"', () => {
      expect(compareValues("abc", "abd")).toBeLessThan(0);
    });

    it("equal strings return 0", () => {
      expect(compareValues("hello", "hello")).toBe(0);
    });

    it('"z" > "a"', () => {
      expect(compareValues("z", "a")).toBeGreaterThan(0);
    });
  });

  describe("bytes (ArrayBuffer)", () => {
    it("compares by content — equal buffers", () => {
      expect(compareValues(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(0);
    });

    it("compares by content — first byte differs", () => {
      expect(compareValues(bytes(1, 2, 3), bytes(2, 2, 3))).toBeLessThan(0);
    });

    it("shorter buffer < longer with same prefix", () => {
      expect(compareValues(bytes(1, 2), bytes(1, 2, 3))).toBeLessThan(0);
    });

    it("empty buffer < non-empty", () => {
      expect(compareValues(bytes(), bytes(1))).toBeLessThan(0);
    });

    it("empty buffers are equal", () => {
      expect(compareValues(bytes(), bytes())).toBe(0);
    });
  });

  describe("arrays", () => {
    it("element-wise comparison — first element differs", () => {
      expect(compareValues([1, 2], [2, 1])).toBeLessThan(0);
    });

    it("shorter array < longer array with same prefix", () => {
      expect(compareValues([1, 2], [1, 2, 3])).toBeLessThan(0);
    });

    it("equal arrays return 0", () => {
      expect(compareValues([1, 2, 3], [1, 2, 3])).toBe(0);
    });

    it("empty arrays are equal", () => {
      expect(compareValues([], [])).toBe(0);
    });

    it("empty array < non-empty array", () => {
      expect(compareValues([], [1])).toBeLessThan(0);
    });

    it("nested arrays compare recursively", () => {
      expect(compareValues([[1]], [[2]])).toBeLessThan(0);
    });
  });

  describe("objects", () => {
    it("equal objects return 0", () => {
      expect(compareValues({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(0);
    });

    it("objects sorted by keys first", () => {
      // { a: 1 } vs { b: 1 } — key "a" < key "b"
      expect(compareValues({ a: 1 }, { b: 1 })).toBeLessThan(0);
    });

    it("same keys, different values", () => {
      expect(compareValues({ a: 1 }, { a: 2 })).toBeLessThan(0);
    });

    it("fewer keys < more keys with same prefix", () => {
      expect(compareValues({ a: 1 }, { a: 1, b: 2 })).toBeLessThan(0);
    });

    it("empty objects are equal", () => {
      expect(compareValues({}, {})).toBe(0);
    });

    it("key order in source doesn't matter (sorted internally)", () => {
      expect(compareValues({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Symmetry
  // -----------------------------------------------------------------------

  describe("symmetry", () => {
    const pairs: Array<[string, any, any]> = [
      ["numbers", 1, 2],
      ["strings", "a", "b"],
      ["booleans", false, true],
      ["bigints", 1n, 2n],
      ["arrays", [1], [2]],
      ["objects", { a: 1 }, { a: 2 }],
      ["cross-type null/number", null, 1],
      ["cross-type string/array", "z", []],
    ];

    for (const [label, a, b] of pairs) {
      it(`${label}: compare(a,b) > 0 ⟹ compare(b,a) < 0`, () => {
        const ab = compareValues(a, b);
        const ba = compareValues(b, a);
        if (ab > 0) {
          expect(ba).toBeLessThan(0);
        } else if (ab < 0) {
          expect(ba).toBeGreaterThan(0);
        } else {
          expect(ba).toBe(0);
        }
      });
    }
  });

  // -----------------------------------------------------------------------
  // Equality (reflexive)
  // -----------------------------------------------------------------------

  describe("equality (reflexive)", () => {
    const values: Array<[string, any]> = [
      ["undefined", undefined],
      ["null", null],
      ["number 0", 0],
      ["number 42", 42],
      ["NaN", NaN],
      ["bigint 0n", 0n],
      ["bigint 99n", 99n],
      ["boolean true", true],
      ["boolean false", false],
      ['string "hello"', "hello"],
      ['string ""', ""],
      ["empty array", []],
      ["array [1,2,3]", [1, 2, 3]],
      ["empty object", {}],
      ["object {a:1}", { a: 1 }],
    ];

    for (const [label, v] of values) {
      it(`compare(${label}, ${label}) === 0`, () => {
        expect(compareValues(v, v)).toBe(0);
      });
    }
  });
});
