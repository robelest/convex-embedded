import type { Conflict, ConflictEntry } from "./core.js";

export function createConflict<T>(entries: ConflictEntry<T>[]): Conflict<T> {
  return {
    values: entries.map((entry) => entry.value),
    entries,
    latest() {
      if (entries.length === 0) {
        throw new Error("convex-embedded: Cannot resolve empty conflict");
      }
      let best = entries[0]!;
      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index]!.timestamp > best.timestamp) {
          best = entries[index]!;
        }
      }
      return best.value;
    },
    byClient(id: string) {
      return entries.find((entry) => entry.clientId === id)?.value;
    },
  };
}
