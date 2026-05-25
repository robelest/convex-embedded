import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import { Database } from "@embedded/runtime/db/database";
import { parseSchema, type SchemaExport } from "@embedded/runtime/db/schema";
import type { SerializedQuery } from "@embedded/runtime/db/types";
import { buildUserTableSpecs } from "@embedded/storage/sqlite/factory";
import { temporaryDatabasePath, uniqueSuffix } from "@tests/helpers/storage";
import { describe, expect, it } from "@tests/testkit";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  tasks: defineTable({
    status: v.string(),
    order: v.number(),
    tiebreak: v.number(),
  })
    .index("by_status_and_order", ["status", "order"])
    .index("by_status_and_order_and_tiebreak", ["status", "order", "tiebreak"]),
});

const parsed = parseSchema(schema as unknown as SchemaExport);
const specs = buildUserTableSpecs(parsed);

async function drain(db: Database, query: SerializedQuery): Promise<string[]> {
  const id = db.startQueryAsync(query);
  const out: string[] = [];
  for (;;) {
    const next = await db.queryNextAsync(id);
    if (next.done) break;
    out.push(next.value!._id as string);
  }
  db.queryCleanup(id);
  return out;
}

async function walk(
  db: Database,
  query: SerializedQuery,
  pageSize: number,
): Promise<string[]> {
  let cursor: string | null = null;
  const ids: string[] = [];
  for (;;) {
    const result = await db.paginateAsync({ query, cursor, pageSize });
    for (const doc of result.page) ids.push(doc._id as string);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return ids;
}

async function walkPinned(
  db: Database,
  query: SerializedQuery,
  pageSize: number,
): Promise<string[]> {
  const cursors: Array<string | null> = [null];
  const ids: string[] = [];
  for (;;) {
    const cursor = cursors[cursors.length - 1]!;
    const probe = await db.paginateAsync({ query, cursor, pageSize });
    if (probe.isDone) {
      const pinned = await db.paginateAsync({
        query,
        cursor,
        endCursor: "_end_cursor",
        pageSize,
      });
      for (const doc of pinned.page) ids.push(doc._id as string);
      break;
    }
    const pinned = await db.paginateAsync({
      query,
      cursor,
      endCursor: probe.continueCursor,
      pageSize,
    });
    for (const doc of pinned.page) ids.push(doc._id as string);
    cursors.push(probe.continueCursor);
  }
  return ids;
}

const indexRange = (order: "asc" | "desc"): SerializedQuery => ({
  source: {
    type: "IndexRange",
    indexName: "tasks.by_status_and_order",
    range: [{ type: "Eq", fieldPath: "status", value: "active" }],
    order,
  },
  operators: [],
});

const multi: SerializedQuery = {
  source: {
    type: "IndexRange",
    indexName: "tasks.by_status_and_order_and_tiebreak",
    range: [{ type: "Eq", fieldPath: "status", value: "active" }],
    order: "asc",
  },
  operators: [],
};

const full: SerializedQuery = {
  source: { type: "FullTableScan", tableName: "tasks", order: "asc" },
  operators: [],
};

describe("SQLite pagination seek parity", () => {
  it("matches a full drain across page sizes, ties, desc, multi-field, full scan", async ({
    track,
  }) => {
    const file = temporaryDatabasePath(uniqueSuffix("seek-sqlite"));
    const storage = track(
      await openNodeStorage({ filename: file, userTableSpecs: specs }),
    );
    const db = new Database(parsed);
    db.setStorage(storage);
    await db.hydrate();

    db.startTransaction();
    for (let index = 0; index < 50; index += 1) {
      db.insert("tasks", {
        status: "active",
        order: index < 30 ? 1 : Math.floor(index / 5),
        tiebreak: index,
      });
    }
    db.insert("tasks", { status: "blocked", order: 0, tiebreak: 0 });
    await db.commitAsync();
    await db.waitForPersistence();

    for (const [query, pageSize] of [
      [indexRange("asc"), 5],
      [indexRange("asc"), 7],
      [indexRange("desc"), 5],
      [multi, 4],
      [full, 6],
    ] as const) {
      const reference = await drain(db, query);
      const walked = await walk(db, query, pageSize);
      expect(walked).toEqual(reference);
      expect(new Set(walked).size).toBe(walked.length);

      const pinnedWalked = await walkPinned(db, query, pageSize);
      expect(pinnedWalked).toEqual(reference);
      expect(new Set(pinnedWalked).size).toBe(pinnedWalked.length);
    }
    await db.waitForPersistence();
  });
});
