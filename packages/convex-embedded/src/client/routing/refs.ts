import { resolveFunctionPath, type FunctionPath } from "@/kernel/modules";
import { getFunctionName } from "@/shared/refs";

export function asError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }

  if (typeof err === "string") {
    return new Error(err);
  }

  if (typeof err === "number" || typeof err === "boolean") {
    return new Error(`${err}`);
  }

  if (err === null || err === undefined) {
    return new Error("unknown error");
  }

  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error("unknown error");
  }
}

export function getFunctionRefName(ref: unknown): string {
  if (typeof ref !== "string" && typeof ref !== "object") {
    return "";
  }
  if (ref === null) {
    return "";
  }
  try {
    return getFunctionName(ref as any);
  } catch {
    return "";
  }
}

export function getFunctionRefPath(ref: unknown): FunctionPath | null {
  if (typeof ref === "string") {
    return resolveFunctionPath({ name: ref });
  }

  if (ref === null || typeof ref !== "object") {
    return null;
  }

  const candidate = ref as {
    name?: string;
    reference?: string;
    functionHandle?: string;
  };

  if (
    candidate.name === undefined &&
    candidate.reference === undefined &&
    candidate.functionHandle === undefined
  ) {
    try {
      return resolveFunctionPath({ name: getFunctionName(ref as any) });
    } catch {
      return null;
    }
  }

  try {
    return resolveFunctionPath(candidate);
  } catch {
    return null;
  }
}

export function matchTag<
  T extends Record<K, string>,
  K extends keyof T & string,
  Handlers extends {
    [V in T[K] & string]: (value: Extract<T, Record<K, V>>) => unknown;
  },
>(value: T, key: K, handlers: Handlers): ReturnType<Handlers[T[K] & string]> {
  const handler = handlers[value[key] as T[K] & string] as unknown as (
    current: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}
