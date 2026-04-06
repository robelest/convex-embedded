/**
 * Lightweight `getFunctionName` and `makeFunctionReference` using the
 * same `Symbol.for("functionName")` convention as the Convex SDK.
 */

const functionName = Symbol.for("functionName");

export function getFunctionName(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (ref !== null && typeof ref === "object") {
    const name = (ref as Record<symbol, unknown>)[functionName];
    if (typeof name === "string") return name;
  }
  throw new Error(`${String(ref)} is not a functionReference`);
}

export function makeFunctionReference<T = unknown>(name: string): T {
  return { [functionName]: name } as T;
}
