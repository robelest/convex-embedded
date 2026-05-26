import {
  createQueryCacheStorage,
  type QueryCacheStorage,
  type SqliteCacheRow,
} from "@embedded/runtime/sqlite/cache";
import type {
  SqliteDriver,
  SqliteStatement,
} from "@embedded/storage/sqlite/driver";
import { describe, expect, it, type TestFixtures } from "@tests/testkit";
import Database from "better-sqlite3";

type MemoryDriver = SqliteDriver & { close: () => Promise<void> };

function createMemoryDriver(): MemoryDriver {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      return db.prepare(sql).all(...(params ?? [])) as T[];
    },
    async execute(sql: string, params?: readonly unknown[]): Promise<void> {
      db.prepare(sql).run(...(params ?? []));
    },
    async executeBatch(statements: readonly SqliteStatement[]): Promise<void> {
      db.transaction(() => {
        for (const statement of statements) {
          db.prepare(statement.sql).run(...(statement.params ?? []));
        }
      })();
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

function setup(track: TestFixtures["track"]): {
  driver: MemoryDriver;
  cache: QueryCacheStorage;
} {
  const driver = track(createMemoryDriver());
  return { driver, cache: createQueryCacheStorage(driver) };
}

function makeRow(overrides: Partial<SqliteCacheRow> = {}): SqliteCacheRow {
  return {
    refName: "ref:foo",
    argsHash: "hash:1",
    argsJson: JSON.stringify({ a: 1 }),
    valueJson: JSON.stringify({ value: 42 }),
    receivedAt: 1_000,
    ts: null,
    paginationCursor: null,
    paginationIsDone: null,
    ...overrides,
  };
}

describe("query cache sqlite storage", () => {
  describe("initSchema", () => {
    it("creates the cache table", async ({ track }) => {
      const { driver, cache } = setup(track);
      await cache.initSchema();

      const tables = await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["_embedded_query_cache"],
      );
      expect(tables).toHaveLength(1);
    });

    it("creates the received_at index", async ({ track }) => {
      const { driver, cache } = setup(track);
      await cache.initSchema();

      const indexes = await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        ["_embedded_query_cache_received_at"],
      );
      expect(indexes).toHaveLength(1);
    });

    it("is idempotent across repeated calls", async ({ track }) => {
      const { driver, cache } = setup(track);
      await cache.initSchema();
      await cache.initSchema();
      await cache.initSchema();

      const tables = await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["_embedded_query_cache"],
      );
      expect(tables).toHaveLength(1);
    });

    it("auto-initializes on first write without an explicit call", async ({
      track,
    }) => {
      const { cache } = setup(track);
      const row = makeRow({ refName: "ref:auto", argsHash: "h:auto" });
      await cache.write(row);

      const loaded = await cache.load(row.refName, row.argsHash);
      expect(loaded?.refName).toBe("ref:auto");
    });
  });

  describe("upsert and load", () => {
    it("inserts a new row that load returns verbatim", async ({ track }) => {
      const { cache } = setup(track);
      const row = makeRow();
      await cache.write(row);

      await expect(cache.load(row.refName, row.argsHash)).resolves.toEqual(row);
    });

    it("overwrites an existing row at the same primary key", async ({
      track,
    }) => {
      const { cache } = setup(track);
      await cache.write(makeRow({ valueJson: JSON.stringify({ v: 1 }) }));

      const updated = makeRow({
        valueJson: JSON.stringify({ v: 2 }),
        receivedAt: 5_000,
        ts: 7_000,
        paginationCursor: "cursor-1",
        paginationIsDone: 1,
      });
      await cache.write(updated);

      await expect(
        cache.load(updated.refName, updated.argsHash),
      ).resolves.toEqual(updated);
      await expect(cache.loadAll()).resolves.toHaveLength(1);
    });

    it("returns null for a missing key", async ({ track }) => {
      const { cache } = setup(track);
      await cache.initSchema();

      await expect(cache.load("missing", "missing")).resolves.toBeNull();
    });

    it("supports a composite primary key on (refName, argsHash)", async ({
      track,
    }) => {
      const { cache } = setup(track);
      await cache.write(makeRow({ refName: "ref:x", argsHash: "h:1" }));
      await cache.write(makeRow({ refName: "ref:x", argsHash: "h:2" }));
      await cache.write(makeRow({ refName: "ref:x", argsHash: "h:3" }));

      await expect(cache.loadAll()).resolves.toHaveLength(3);

      await cache.delete("ref:x", "h:2");
      const remaining = await cache.loadAll();
      expect(remaining.map((r) => r.argsHash).sort()).toEqual(["h:1", "h:3"]);
    });

    it("normalizes truthy paginationIsDone values to 1", async ({ track }) => {
      const { cache } = setup(track);
      const row = makeRow({ paginationIsDone: 7 as unknown as number });
      await cache.write(row);

      const loaded = await cache.load(row.refName, row.argsHash);
      expect(loaded?.paginationIsDone).toBe(1);
    });

    it("preserves null pagination fields when unset", async ({ track }) => {
      const { cache } = setup(track);
      const row = makeRow({ paginationCursor: null, paginationIsDone: null });
      await cache.write(row);

      const loaded = await cache.load(row.refName, row.argsHash);
      expect(loaded?.paginationCursor).toBeNull();
      expect(loaded?.paginationIsDone).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes only the specified row", async ({ track }) => {
      const { cache } = setup(track);
      const a = makeRow({ refName: "ref:a", argsHash: "h:a" });
      const b = makeRow({ refName: "ref:b", argsHash: "h:b" });
      await cache.write(a);
      await cache.write(b);

      await cache.delete(a.refName, a.argsHash);

      await expect(cache.load(a.refName, a.argsHash)).resolves.toBeNull();
      await expect(cache.load(b.refName, b.argsHash)).resolves.not.toBeNull();
    });

    it("is a no-op on a missing row", async ({ track }) => {
      const { cache } = setup(track);
      await cache.initSchema();

      await cache.delete("nope", "nope");
      await expect(cache.loadAll()).resolves.toHaveLength(0);
    });
  });

  describe("loadAll", () => {
    it("returns every row", async ({ track }) => {
      const { cache } = setup(track);
      await cache.write(makeRow({ refName: "ref:a", argsHash: "h:a" }));
      await cache.write(makeRow({ refName: "ref:b", argsHash: "h:b" }));
      await cache.write(makeRow({ refName: "ref:c", argsHash: "h:c" }));

      const rows = await cache.loadAll();
      const refs = rows.map((r) => `${r.refName}:${r.argsHash}`).sort();
      expect(refs).toEqual(["ref:a:h:a", "ref:b:h:b", "ref:c:h:c"]);
    });
  });

  describe("clear", () => {
    it("removes all rows but keeps the schema usable", async ({ track }) => {
      const { cache } = setup(track);
      await cache.write(makeRow({ refName: "ref:a", argsHash: "h:a" }));
      await cache.write(makeRow({ refName: "ref:b", argsHash: "h:b" }));

      await cache.clear();
      await expect(cache.loadAll()).resolves.toHaveLength(0);

      await cache.write(makeRow({ refName: "ref:c", argsHash: "h:c" }));
      await expect(cache.loadAll()).resolves.toHaveLength(1);
    });
  });

  describe("pruneOlderThan", () => {
    it("removes rows below the cutoff and returns the count", async ({
      track,
    }) => {
      const { cache } = setup(track);
      await cache.write(
        makeRow({ refName: "ref:a", argsHash: "h:a", receivedAt: 100 }),
      );
      await cache.write(
        makeRow({ refName: "ref:b", argsHash: "h:b", receivedAt: 500 }),
      );
      await cache.write(
        makeRow({ refName: "ref:c", argsHash: "h:c", receivedAt: 1_000 }),
      );

      await expect(cache.pruneOlderThan(750)).resolves.toBe(2);

      const remaining = await cache.loadAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.refName).toBe("ref:c");
    });

    it("returns 0 when nothing matches", async ({ track }) => {
      const { cache } = setup(track);
      await cache.write(
        makeRow({ refName: "ref:a", argsHash: "h:a", receivedAt: 100 }),
      );

      await expect(cache.pruneOlderThan(50)).resolves.toBe(0);
      await expect(cache.loadAll()).resolves.toHaveLength(1);
    });
  });
});
