import { describe, it, expect } from "vitest";
import { createConflict } from "#resolve/shared/conflict";
import type { ConflictEntry } from "#resolve/shared/types";

describe("createConflict", () => {
  it("constructs a Conflict with values array", () => {
    const entries: ConflictEntry<string>[] = [
      { value: "a", clientId: "c1", timestamp: 100 },
      { value: "b", clientId: "c2", timestamp: 200 },
    ];
    const conflict = createConflict(entries);

    expect(conflict.values).toEqual(["a", "b"]);
    expect(conflict.entries).toHaveLength(2);
  });

  it("latest() returns value with highest timestamp", () => {
    const entries: ConflictEntry<string>[] = [
      { value: "early", clientId: "c1", timestamp: 100 },
      { value: "late", clientId: "c2", timestamp: 300 },
      { value: "middle", clientId: "c3", timestamp: 200 },
    ];
    const conflict = createConflict(entries);

    expect(conflict.latest()).toBe("late");
  });

  it("latest() throws on empty entries", () => {
    const conflict = createConflict<string>([]);
    expect(() => conflict.latest()).toThrow("Cannot resolve empty conflict");
  });

  it("byClient() returns value for matching client", () => {
    const entries: ConflictEntry<number>[] = [
      { value: 10, clientId: "alice", timestamp: 100 },
      { value: 20, clientId: "bob", timestamp: 200 },
    ];
    const conflict = createConflict(entries);

    expect(conflict.byClient("alice")).toBe(10);
    expect(conflict.byClient("bob")).toBe(20);
  });

  it("byClient() returns undefined for unknown client", () => {
    const entries: ConflictEntry<number>[] = [
      { value: 10, clientId: "alice", timestamp: 100 },
    ];
    const conflict = createConflict(entries);

    expect(conflict.byClient("unknown")).toBeUndefined();
  });

  it("latest() handles single entry", () => {
    const entries: ConflictEntry<string>[] = [
      { value: "only", clientId: "c1", timestamp: 100 },
    ];
    const conflict = createConflict(entries);

    expect(conflict.latest()).toBe("only");
  });

  it("latest() handles equal timestamps deterministically", () => {
    const entries: ConflictEntry<string>[] = [
      { value: "first", clientId: "c1", timestamp: 100 },
      { value: "second", clientId: "c2", timestamp: 100 },
    ];
    const conflict = createConflict(entries);

    // With equal timestamps, first entry wins (no > comparison succeeds)
    expect(conflict.latest()).toBe("first");
  });
});
