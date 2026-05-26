/**
 * Convex value ordering.
 *
 * Ported from convex-test/compare.ts. Implements the total ordering
 * over Convex `Value` that the real Convex backend uses for index
 * range scans and sorting.
 *
 * Ordering (ascending): undefined < null < bigint < number (NaN after
 * all numbers) < boolean < string < bytes < array < object.
 */
import type { Value } from "convex/values";

/** Compare two Convex values. Returns -1, 0, or 1. */
export function compareValues(
  k1: Value | undefined,
  k2: Value | undefined,
): number {
  return compareAsTuples(toComparable(k1), toComparable(k2));
}

function compareAsTuples<T>(a: [number, T], b: [number, T]): number {
  if (a[0] === b[0]) {
    return compareSameTypeValues(a[1], b[1]);
  }
  return a[0] < b[0] ? -1 : 1;
}

function compareSameTypeValues<T>(v1: T, v2: T): number {
  if (v1 === undefined || v1 === null) {
    return 0;
  }
  if (
    typeof v1 === "bigint" ||
    typeof v1 === "number" ||
    typeof v1 === "boolean" ||
    typeof v1 === "string"
  ) {
    return v1 < v2 ? -1 : v1 === v2 ? 0 : 1;
  }
  if (!Array.isArray(v1) || !Array.isArray(v2)) {
    throw new Error(`Unexpected type ${String(v1)}`);
  }
  for (let i = 0; i < v1.length && i < v2.length; i++) {
    const cmp = compareAsTuples(v1[i], v2[i]);
    if (cmp !== 0) {
      return cmp;
    }
  }
  if (v1.length < v2.length) return -1;
  if (v1.length > v2.length) return 1;
  return 0;
}

/**
 * Map a Convex value to a `[typeTag, comparable]` tuple so that
 * cross-type ordering works correctly.
 */
function toComparable(v: Value | undefined): [number, unknown] {
  if (v === undefined) return [0, undefined];
  if (v === null) return [1, null];
  if (typeof v === "bigint") return [2, v];
  if (typeof v === "number") {
    if (isNaN(v)) return [3.5, 0];
    return [3, v];
  }
  if (typeof v === "boolean") return [4, v];
  if (typeof v === "string") return [5, v];
  if (v instanceof ArrayBuffer) {
    return [6, Array.from(new Uint8Array(v)).map(toComparable)];
  }
  if (Array.isArray(v)) {
    return [7, v.map(toComparable)];
  }
  const keys = Object.keys(v).sort();
  const pojo: Value[] = keys.map((k) => [k, v[k]!]);
  return [8, pojo.map(toComparable)];
}
