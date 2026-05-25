import { registerEmbeddedClientEntry } from "@embedded/client/entry";
import { createEmbeddedDevtoolsSource } from "@embedded/devtools/core/source";
import type { EmbeddedDevtoolsSource } from "@embedded/devtools/core/types";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";
import {
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import { v } from "convex/values";

type MutationCtx = GenericMutationCtx<GenericDataModel>;
type QueryCtx = GenericQueryCtx<GenericDataModel>;

const notesSchema = defineSchema({
  notes: defineTable({
    title: v.string(),
    body: v.string(),
  }).index("by_title", ["title"]),
});

const insertNote = mutationGeneric({
  handler: async (ctx: MutationCtx, args: { title: string; body: string }) =>
    ctx.db.insert("notes", args),
});

const listNotes = queryGeneric({
  handler: async (ctx: QueryCtx) => ctx.db.query("notes").collect(),
});

const NOTE_MODULES = {
  notes: () =>
    Promise.resolve({
      insert: insertNote,
      list: listNotes,
    }),
  "_generated/api": () => Promise.resolve({}),
};

function makeClient(runtime: EmbeddedRuntime): ConvexClient {
  const client = {} as ConvexClient;
  registerEmbeddedClientEntry(client, {
    runtime,
    tableDefinitions: new Map(),
    fieldHandles: new Map(),
  });
  return client;
}

describe("createEmbeddedDevtoolsSource", () => {
  let runtime: EmbeddedRuntime;
  let source: EmbeddedDevtoolsSource;

  beforeEach(async () => {
    runtime = new EmbeddedRuntime({
      convex: { modules: NOTE_MODULES },
      schema: notesSchema,
    });
    await runtime.hydrate();
    source = createEmbeddedDevtoolsSource(makeClient(runtime));
  });

  afterEach(() => {
    source.dispose();
    runtime.shutdown();
  });

  it("captures executeLocal mutations and queries in the operations view", async () => {
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "first", body: "hello" },
    });
    await source.runFunction({
      kind: "query",
      path: "notes:list",
      args: {},
    });

    const operations = source.getSnapshot("operations");

    const mutation = operations.find((op) => op.path === "notes:insert");
    const query = operations.find((op) => op.path === "notes:list");

    expect(mutation).toBeDefined();
    expect(mutation?.kind).toBe("mutation");
    expect(mutation?.status).toBe("ok");
    expect(mutation?.durationMs).toBeGreaterThanOrEqual(0);
    expect(mutation?.args).toEqual({ title: "first", body: "hello" });
    expect(typeof mutation?.result).toBe("string");

    expect(query).toBeDefined();
    expect(query?.kind).toBe("query");
    expect(query?.status).toBe("ok");
    expect(query?.args).toEqual({});
    expect(Array.isArray(query?.result)).toBe(true);
  });

  it("exposes the logs view and clears activity", async () => {
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "x", body: "y" },
    });

    expect(source.getSnapshot("operations").length).toBeGreaterThan(0);
    expect(Array.isArray(source.getSnapshot("logs"))).toBe(true);

    source.clearActivity();

    expect(source.getSnapshot("operations")).toHaveLength(0);
    expect(source.getSnapshot("logs")).toHaveLength(0);
  });

  it("populates the performance summary buckets", async () => {
    for (let index = 0; index < 5; index += 1) {
      await source.runFunction({
        kind: "mutation",
        path: "notes:insert",
        args: { title: `note-${index}`, body: "x" },
      });
    }
    await source.runFunction({ kind: "query", path: "notes:list", args: {} });

    const performance = source.getSnapshot("performance");

    const mutationBucket = performance.buckets.find(
      (bucket) => bucket.kind === "mutation",
    );
    const queryBucket = performance.buckets.find(
      (bucket) => bucket.kind === "query",
    );

    expect(mutationBucket).toBeDefined();
    expect(mutationBucket?.count).toBe(5);
    expect(mutationBucket?.meanMs).toBeGreaterThanOrEqual(0);
    expect(queryBucket).toBeDefined();
    expect(queryBucket?.count).toBeGreaterThanOrEqual(1);
    expect(performance.slowest.length).toBeGreaterThan(0);
  });

  it("lists the seeded table with rows in the data view", async () => {
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "alpha", body: "a" },
    });
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "beta", body: "b" },
    });

    const tables = source.getSnapshot("data");
    const notes = tables.find((table) => table.name === "notes");

    expect(notes).toBeDefined();
    expect(notes?.rowCount).toBe(2);

    const rows = await source.listTableRows("notes");
    expect(rows.table).toBe("notes");
    expect(rows.rows).toHaveLength(2);
    expect(rows.isDone).toBe(true);
    const titles = rows.rows
      .map((row) => String(row.title))
      .sort((left, right) => left.localeCompare(right));
    expect(titles).toEqual(["alpha", "beta"]);
  });

  it("paginates table rows through the SQLite-backed cursor", async () => {
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "one", body: "1" },
    });
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "two", body: "2" },
    });
    await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "three", body: "3" },
    });

    const first = await source.listTableRows("notes", { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.isDone).toBe(false);
    expect(first.cursor).not.toBeNull();

    const collected = [...first.rows];
    let cursor = first.cursor;
    let isDone = first.isDone;
    while (!isDone) {
      const page = await source.listTableRows("notes", { cursor, limit: 1 });
      collected.push(...page.rows);
      cursor = page.cursor;
      isDone = page.isDone;
    }

    expect(collected).toHaveLength(3);
    expect(new Set(collected.map((row) => String(row._id))).size).toBe(3);
  });

  it("exposes index definitions in the schema view", () => {
    const schema = source.getSnapshot("schema");
    const notes = schema.find((table) => table.name === "notes");

    expect(notes).toBeDefined();
    const byTitle = notes?.indexes.find((index) => index.name === "by_title");
    expect(byTitle).toBeDefined();
    expect(byTitle?.fields).toContain("title");
  });

  it("returns table names via the runtime database", () => {
    expect(runtime.db.getTableNames()).toContain("notes");
  });

  it("runs functions through the source", async () => {
    const id = await source.runFunction({
      kind: "mutation",
      path: "notes:insert",
      args: { title: "ran", body: "via runFunction" },
    });
    expect(typeof id).toBe("string");

    const result = await source.runFunction({
      kind: "query",
      path: "notes:list",
      args: {},
    });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });
});
