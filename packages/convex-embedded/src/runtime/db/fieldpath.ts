import type { JSONValue, Value } from "convex/values";
import { jsonToConvex } from "convex/values";

import type { GenericDocument } from "@/runtime/db/types";

export function isSimpleObject(value: unknown): boolean {
  const isObject = value !== null && typeof value === "object";
  if (!isObject) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  const isSimple =
    prototype === null ||
    prototype === Object.prototype ||
    prototype?.constructor?.name === "Object";
  return isSimple;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isSimpleObject(value) ? (value as Record<string, unknown>) : null;
}

export function isUndefinedMarker(value: JSONValue): boolean {
  const record = asRecord(value);
  return record !== null && "$undefined" in record;
}

const FIELD_PATH_PARTS_CACHE = new Map<string, string[]>();
const FIELD_PATH_PARTS_CACHE_MAX_SIZE = 1_000;

export function getFieldPathParts(fieldPath: string): string[] {
  let cached = FIELD_PATH_PARTS_CACHE.get(fieldPath);
  if (!cached) {
    if (FIELD_PATH_PARTS_CACHE.size >= FIELD_PATH_PARTS_CACHE_MAX_SIZE) {
      FIELD_PATH_PARTS_CACHE.clear();
    }
    cached = fieldPath.split(".");
    FIELD_PATH_PARTS_CACHE.set(fieldPath, cached);
  }
  return cached;
}

export function evaluateFieldPath(
  fieldPath: string,
  document: GenericDocument,
): Value | undefined {
  const pathParts = getFieldPathParts(fieldPath);
  return pathParts.reduce<Value | undefined>(
    (result, part) =>
      result !== undefined && result !== null && isSimpleObject(result)
        ? (result as Record<string, Value | undefined>)[part]
        : undefined,
    document as Value,
  );
}

export function evaluateValue(value: JSONValue): Value | undefined {
  return isUndefinedMarker(value) ? undefined : jsonToConvex(value);
}
