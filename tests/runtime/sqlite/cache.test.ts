import {
  createQueryCacheStorage,
  type QueryCacheStorage,
  type SqliteCacheRow,
} from "@embedded/runtime/sqlite/cache";
import type {
  SqliteDriver,
  SqliteStatement,
} from "@embedded/storage/sqlite/driver";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";

function createMemoryDriver(): SqliteDriver & { close: () => Promise<void> } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = MEMORY");

  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    },
    async execute(sql: string, params?: readonly unknown[]): Promise<void> {
      db.prepare(sql).run(...(params ?? []));
    },
    async executeBatch(statements: readonly SqliteStatement[]): Promise<void> {
      const txn = db.transaction(() => {
        for (const statement of statements) {
          db.prepare(statement.sql).run(...(statement.params ?? []));
        }
      });
      txn();
    },
    async close(): Promise<void> {
      db.close();
    },
  };
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
  let driver: SqliteDriver & { close: () => Promise<void> };
  let cache: QueryCacheStorage;

  beforeEach(() => {
    driver = createMemoryDriver();
    cache = createQueryCacheStorage(driver);
  });

  afterEach(async () => {
    await driver.close();
  });

  it("creates the cache table and index on initSchema", async () => {
    await cache.initSchema();
    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["_embedded_query_cache"],
    );
    expect(tables).toHaveLength(1);

    const indexes = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ["_embedded_query_cache_received_at"],
    );
    expect(indexes).toHaveLength(1);
  });

  it("initSchema is idempotent across repeated calls", async () => {
    await cache.initSchema();
    await cache.initSchema();
    await cache.initSchema();

    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["_embedded_query_cache"],
    );
    expect(tables).toHaveLength(1);
  });

  it("upsert inserts a new row and load returns it", async () => {
    const row = makeRow();
    await cache.upsert(row);

    const loaded = await cache.load(row.refName, row.argsHash);
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(row);
  });

  it("upsert overwrites existing row at the same primary key", async () => {
    const original = makeRow({ valueJson: JSON.stringify({ v: 1 }) });
    await cache.upsert(original);

    const updated = makeRow({
      valueJson: JSON.stringify({ v: 2 }),
      receivedAt: 5_000,
      ts: 7_000,
      paginationCursor: "cursor-1",
      paginationIsDone: 1,
    });
    await cache.upsert(updated);

    const loaded = await cache.load(updated.refName, updated.argsHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.valueJson).toBe(JSON.stringify({ v: 2 }));
    expect(loaded?.receivedAt).toBe(5_000);
    expect(loaded?.ts).toBe(7_000);
    expect(loaded?.paginationCursor).toBe("cursor-1");
    expect(loaded?.paginationIsDone).toBe(1);

    const all = await cache.loadAll();
    expect(all).toHaveLength(1);
  });

  it("load returns null for a missing key", async () => {
    await cache.initSchema();
    const loaded = await cache.load("missing", "missing");
    expect(loaded).toBeNull();
  });

  it("delete removes only the specified row", async () => {
    const a = makeRow({ refName: "ref:a", argsHash: "h:a" });
    const b = makeRow({ refName: "ref:b", argsHash: "h:b" });
    await cache.upsert(a);
    await cache.upsert(b);

    await cache.delete(a.refName, a.argsHash);

    expect(await cache.load(a.refName, a.argsHash)).toBeNull();
    expect(await cache.load(b.refName, b.argsHash)).not.toBeNull();
  });

  it("delete on a missing row is a no-op", async () => {
    await cache.initSchema();
    await cache.delete("nope", "nope");
    expect(await cache.loadAll()).toHaveLength(0);
  });

  it("loadAll returns every row", async () => {
    await cache.upsert(makeRow({ refName: "ref:a", argsHash: "h:a" }));
    await cache.upsert(makeRow({ refName: "ref:b", argsHash: "h:b" }));
    await cache.upsert(makeRow({ refName: "ref:c", argsHash: "h:c" }));

    const rows = await cache.loadAll();
    expect(rows).toHaveLength(3);
    const refs = rows.map((r) => `${r.refName}:${r.argsHash}`).sort();
    expect(refs).toEqual(["ref:a:h:a", "ref:b:h:b", "ref:c:h:c"]);
  });

  it("clear removes all rows but preserves the schema", async () => {
    await cache.upsert(makeRow({ refName: "ref:a", argsHash: "h:a" }));
    await cache.upsert(makeRow({ refName: "ref:b", argsHash: "h:b" }));
    expect(await cache.loadAll()).toHaveLength(2);

    await cache.clear();
    expect(await cache.loadAll()).toHaveLength(0);

    await cache.upsert(makeRow({ refName: "ref:c", argsHash: "h:c" }));
    expect(await cache.loadAll()).toHaveLength(1);
  });

  it("pruneOlderThan removes rows below the cutoff and returns the count", async () => {
    await cache.upsert(
      makeRow({ refName: "ref:a", argsHash: "h:a", receivedAt: 100 }),
    );
    await cache.upsert(
      makeRow({ refName: "ref:b", argsHash: "h:b", receivedAt: 500 }),
    );
    await cache.upsert(
      makeRow({ refName: "ref:c", argsHash: "h:c", receivedAt: 1_000 }),
    );

    const deleted = await cache.pruneOlderThan(750);
    expect(deleted).toBe(2);

    const remaining = await cache.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.refName).toBe("ref:c");
  });

  it("pruneOlderThan returns 0 when nothing matches", async () => {
    await cache.upsert(
      makeRow({ refName: "ref:a", argsHash: "h:a", receivedAt: 100 }),
    );
    const deleted = await cache.pruneOlderThan(50);
    expect(deleted).toBe(0);
    expect(await cache.loadAll()).toHaveLength(1);
  });

  it("normalizes truthy paginationIsDone values to 1", async () => {
    const row = makeRow({
      paginationIsDone: 7 as unknown as number,
    });
    await cache.upsert(row);

    const loaded = await cache.load(row.refName, row.argsHash);
    expect(loaded?.paginationIsDone).toBe(1);
  });

  it("preserves null pagination fields when unset", async () => {
    const row = makeRow({
      paginationCursor: null,
      paginationIsDone: null,
    });
    await cache.upsert(row);

    const loaded = await cache.load(row.refName, row.argsHash);
    expect(loaded?.paginationCursor).toBeNull();
    expect(loaded?.paginationIsDone).toBeNull();
  });

  it("auto-initializes schema on first write without an explicit initSchema call", async () => {
    const row = makeRow({ refName: "ref:auto", argsHash: "h:auto" });
    await cache.upsert(row);

    const loaded = await cache.load(row.refName, row.argsHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.refName).toBe("ref:auto");
  });

  it("supports composite primary key — same refName, different argsHash", async () => {
    await cache.upsert(makeRow({ refName: "ref:x", argsHash: "h:1" }));
    await cache.upsert(makeRow({ refName: "ref:x", argsHash: "h:2" }));
    await cache.upsert(makeRow({ refName: "ref:x", argsHash: "h:3" }));

    const all = await cache.loadAll();
    expect(all).toHaveLength(3);

    await cache.delete("ref:x", "h:2");
    const remaining = await cache.loadAll();
    expect(remaining.map((r) => r.argsHash).sort()).toEqual(["h:1", "h:3"]);
  });
});
