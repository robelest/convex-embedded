import { convexToJson } from "convex/values";

export function stableValueKey(value: unknown): string {
  if (value === undefined) {
    return JSON.stringify({ $undefined: true });
  }

  try {
    return JSON.stringify(convexToJson(value as never));
  } catch {
    return JSON.stringify(value);
  }
}
