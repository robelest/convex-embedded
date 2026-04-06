/**
 * Conflict constructor — builds a Conflict<T> from raw entries.
 *
 * Lives in shared/ so both server/ and client/ can import it
 * without cross-boundary dependencies.
 */
import type { Conflict, ConflictEntry } from "@/shared/types";

/**
 * Create a Conflict<T> from an array of ConflictEntry<T>.
 * Provides `latest()` (highest timestamp wins) and `byClient(id)`.
 */
export function createConflict<T>(entries: ConflictEntry<T>[]): Conflict<T> {
  return {
    values: entries.map((e) => e.value),
    entries,
    latest(): T {
      if (entries.length === 0) {
        throw new Error("convex-embedded: Cannot resolve empty conflict");
      }
      let best = entries[0]!;
      for (let i = 1; i < entries.length; i++) {
        if (entries[i]!.timestamp > best.timestamp) {
          best = entries[i]!;
        }
      }
      return best.value;
    },
    byClient(id: string): T | undefined {
      return entries.find((e) => e.clientId === id)?.value;
    },
  };
}
