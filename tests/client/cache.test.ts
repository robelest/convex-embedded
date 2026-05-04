import { EmbeddedQueryCache } from "@resolve/client/cache";
import type { CachedEntry } from "@resolve/client/cache";
import { describe, expect, it } from "@tests/testkit";

function makeEntry(value: unknown, overrides: Partial<CachedEntry> = {}): CachedEntry {
  return {
    value,
    receivedAtMs: 0,
    ...overrides,
  };
}

describe("EmbeddedQueryCache", () => {
  it("get returns undefined for unknown keys", () => {
    const cache = new EmbeddedQueryCache();
    expect(cache.get("queries:list", { user: "u1" })).toBeUndefined();
  });

  it("get/set basics: stores and retrieves entries", () => {
    const cache = new EmbeddedQueryCache();
    const entry = makeEntry([1, 2, 3], { receivedAtMs: 100, ts: 5 });

    expect(cache.set("queries:list", { user: "u1" }, entry)).toBe(true);
    expect(cache.size()).toBe(1);

    const found = cache.get("queries:list", { user: "u1" });
    expect(found).toEqual(entry);
  });

  it("delete removes entries", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:list", { user: "u1" }, makeEntry("v1"));
    cache.set("queries:list", { user: "u2" }, makeEntry("v2"));

    cache.delete("queries:list", { user: "u1" });
    expect(cache.get("queries:list", { user: "u1" })).toBeUndefined();
    expect(cache.get("queries:list", { user: "u2" })).toEqual(makeEntry("v2"));
    expect(cache.size()).toBe(1);
  });

  it("delete is a no-op for unknown keys", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:list", { user: "u1" }, makeEntry("v1"));
    cache.delete("queries:list", { user: "missing" });
    expect(cache.size()).toBe(1);
  });

  it("uses canonical args (key ordering doesn't matter)", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:list", { a: 1, b: 2 }, makeEntry("v"));

    expect(cache.get("queries:list", { b: 2, a: 1 })).toEqual(makeEntry("v"));
    expect(cache.get("queries:list", { a: 1, b: 2 })).toEqual(makeEntry("v"));

    expect(cache.set("queries:list", { b: 2, a: 1 }, makeEntry("v"))).toBe(false);
    expect(cache.size()).toBe(1);
  });

  it("treats different refNames as distinct keys", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av"));
    cache.set("queries:b", { x: 1 }, makeEntry("bv"));

    expect(cache.get("queries:a", { x: 1 })).toEqual(makeEntry("av"));
    expect(cache.get("queries:b", { x: 1 })).toEqual(makeEntry("bv"));
    expect(cache.size()).toBe(2);
  });

  it("set returns false when value is structurally equal", () => {
    const cache = new EmbeddedQueryCache();
    cache.set(
      "queries:list",
      { user: "u1" },
      makeEntry({ items: [1, 2, 3], page: { cursor: null } }),
    );

    const result = cache.set(
      "queries:list",
      { user: "u1" },
      makeEntry({ items: [1, 2, 3], page: { cursor: null } }),
    );
    expect(result).toBe(false);
  });

  it("set returns true when value differs", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:list", { user: "u1" }, makeEntry([1, 2]));
    expect(cache.set("queries:list", { user: "u1" }, makeEntry([1, 2, 3]))).toBe(
      true,
    );
    expect(cache.get("queries:list", { user: "u1" })?.value).toEqual([1, 2, 3]);
  });

  it("set returns true when ts differs even if value matches", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:list", { user: "u1" }, makeEntry("v", { ts: 1 }));
    expect(
      cache.set("queries:list", { user: "u1" }, makeEntry("v", { ts: 2 })),
    ).toBe(true);
  });

  it("set returns true when pagination cursor differs", () => {
    const cache = new EmbeddedQueryCache();
    cache.set(
      "queries:list",
      { user: "u1" },
      makeEntry([1], { paginationCursor: "abc", paginationIsDone: false }),
    );
    expect(
      cache.set(
        "queries:list",
        { user: "u1" },
        makeEntry([1], { paginationCursor: "def", paginationIsDone: false }),
      ),
    ).toBe(true);
  });

  it("set returns false when pagination metadata matches", () => {
    const cache = new EmbeddedQueryCache();
    cache.set(
      "queries:list",
      { user: "u1" },
      makeEntry([1], { paginationCursor: "abc", paginationIsDone: false }),
    );
    expect(
      cache.set(
        "queries:list",
        { user: "u1" },
        makeEntry([1], { paginationCursor: "abc", paginationIsDone: false }),
      ),
    ).toBe(false);
  });

  it("clear empties the cache", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:list", { user: "u1" }, makeEntry("v1"));
    cache.set("queries:list", { user: "u2" }, makeEntry("v2"));
    cache.setTablesRead("queries:list", { user: "u1" }, new Set(["users"]));

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("queries:list", { user: "u1" })).toBeUndefined();
    expect(cache.entriesByTable("users")).toEqual([]);
  });

  it("applyTransition writes all entries and reports changed list", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av1", { ts: 1 }));
    cache.set("queries:b", { x: 2 }, makeEntry("bv1", { ts: 1 }));
    cache.set("queries:c", { x: 3 }, makeEntry("cv1", { ts: 1 }));

    const result = cache.applyTransition([
      {
        refName: "queries:a",
        args: { x: 1 },
        entry: makeEntry("av2", { ts: 2 }),
      },
      {
        refName: "queries:b",
        args: { x: 2 },
        entry: makeEntry("bv1", { ts: 1 }),
      },
      {
        refName: "queries:c",
        args: { x: 3 },
        entry: makeEntry("cv2", { ts: 2 }),
      },
    ]);

    expect(result.changed).toHaveLength(2);
    const changedNames = result.changed.map((c) => c.refName).sort();
    expect(changedNames).toEqual(["queries:a", "queries:c"]);

    expect(cache.get("queries:a", { x: 1 })?.value).toBe("av2");
    expect(cache.get("queries:b", { x: 2 })?.value).toBe("bv1");
    expect(cache.get("queries:c", { x: 3 })?.value).toBe("cv2");
  });

  it("applyTransition is atomic: writes all entries before returning", () => {
    const cache = new EmbeddedQueryCache();

    const updates: Array<{ refName: string; args: unknown; entry: CachedEntry }> = [];
    for (let i = 0; i < 50; i += 1) {
      updates.push({
        refName: `queries:item`,
        args: { id: i },
        entry: makeEntry(`v${i}`, { ts: 7 }),
      });
    }

    const { changed } = cache.applyTransition(updates);
    expect(changed).toHaveLength(50);
    expect(cache.size()).toBe(50);

    for (let i = 0; i < 50; i += 1) {
      expect(cache.get("queries:item", { id: i })?.value).toBe(`v${i}`);
      expect(cache.get("queries:item", { id: i })?.ts).toBe(7);
    }
  });

  it("applyTransition deduplicates same key, last write wins", () => {
    const cache = new EmbeddedQueryCache();

    const { changed } = cache.applyTransition([
      {
        refName: "queries:a",
        args: { x: 1 },
        entry: makeEntry("first"),
      },
      {
        refName: "queries:a",
        args: { x: 1 },
        entry: makeEntry("second"),
      },
    ]);

    expect(changed).toHaveLength(1);
    expect(cache.get("queries:a", { x: 1 })?.value).toBe("second");
  });

  it("applyTransition with no actual changes returns empty changed list", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("v"));

    const { changed } = cache.applyTransition([
      {
        refName: "queries:a",
        args: { x: 1 },
        entry: makeEntry("v"),
      },
    ]);

    expect(changed).toEqual([]);
  });

  it("entriesByTable returns dependents", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av"));
    cache.set("queries:b", { x: 2 }, makeEntry("bv"));
    cache.set("queries:c", { x: 3 }, makeEntry("cv"));

    cache.setTablesRead("queries:a", { x: 1 }, new Set(["users", "posts"]));
    cache.setTablesRead("queries:b", { x: 2 }, new Set(["posts"]));
    cache.setTablesRead("queries:c", { x: 3 }, new Set(["comments"]));

    const usersDeps = cache.entriesByTable("users");
    expect(usersDeps).toHaveLength(1);
    expect(usersDeps[0].refName).toBe("queries:a");

    const postsDeps = cache
      .entriesByTable("posts")
      .map((d) => d.refName)
      .sort();
    expect(postsDeps).toEqual(["queries:a", "queries:b"]);

    const commentsDeps = cache.entriesByTable("comments");
    expect(commentsDeps).toHaveLength(1);
    expect(commentsDeps[0].refName).toBe("queries:c");

    expect(cache.entriesByTable("nonexistent")).toEqual([]);
  });

  it("setTablesRead replaces previous table dependencies", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av"));

    cache.setTablesRead("queries:a", { x: 1 }, new Set(["users"]));
    expect(cache.entriesByTable("users")).toHaveLength(1);

    cache.setTablesRead("queries:a", { x: 1 }, new Set(["posts"]));
    expect(cache.entriesByTable("users")).toEqual([]);
    expect(cache.entriesByTable("posts")).toHaveLength(1);
  });

  it("getTablesRead returns the registered tables", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av"));
    cache.setTablesRead("queries:a", { x: 1 }, new Set(["users", "posts"]));

    const tables = cache.getTablesRead("queries:a", { x: 1 });
    expect(tables).toBeDefined();
    expect(new Set(tables)).toEqual(new Set(["users", "posts"]));

    expect(cache.getTablesRead("queries:b", { x: 1 })).toBeUndefined();
  });

  it("setTablesRead is a no-op when entry is missing", () => {
    const cache = new EmbeddedQueryCache();
    cache.setTablesRead("queries:a", { x: 1 }, new Set(["users"]));
    expect(cache.entriesByTable("users")).toEqual([]);
  });

  it("delete clears table dependency tracking", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av"));
    cache.setTablesRead("queries:a", { x: 1 }, new Set(["users"]));

    expect(cache.entriesByTable("users")).toHaveLength(1);
    cache.delete("queries:a", { x: 1 });
    expect(cache.entriesByTable("users")).toEqual([]);
  });

  it("entries() yields all cached records", () => {
    const cache = new EmbeddedQueryCache();
    cache.set("queries:a", { x: 1 }, makeEntry("av"));
    cache.set("queries:b", { x: 2 }, makeEntry("bv"));

    const all = Array.from(cache.entries());
    expect(all).toHaveLength(2);
    const names = all.map((e) => e.refName).sort();
    expect(names).toEqual(["queries:a", "queries:b"]);
  });

  it("size reflects current entry count", () => {
    const cache = new EmbeddedQueryCache();
    expect(cache.size()).toBe(0);
    cache.set("queries:a", { x: 1 }, makeEntry("av"));
    expect(cache.size()).toBe(1);
    cache.set("queries:b", { x: 2 }, makeEntry("bv"));
    expect(cache.size()).toBe(2);
    cache.delete("queries:a", { x: 1 });
    expect(cache.size()).toBe(1);
  });
});
