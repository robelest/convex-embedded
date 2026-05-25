import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { flushMicrotasks } from "@tests/helpers/time";
import { afterEach, describe, expect, it } from "@tests/testkit";
import {
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type PaginationOptions,
} from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  items: defineTable({
    order: v.number(),
  }).index("by_order", ["order"]),
});

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;

interface PaginatedSnapshot {
  results: Array<{ _id: string; order: number }>;
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => boolean;
}

const handlerCalls = { list: 0, listDesc: 0 };

function makeRuntime(): EmbeddedRuntime {
  handlerCalls.list = 0;
  handlerCalls.listDesc = 0;
  return new EmbeddedRuntime({
    schema,
    convex: {
      modules: {
        "_generated/api": () => Promise.resolve({}),
        items: () =>
          Promise.resolve({
            insert: mutationGeneric({
              handler: async (ctx: MutationCtx, args: { order: number }) =>
                ctx.db.insert("items", { order: args.order }),
            }),
            removeByOrder: mutationGeneric({
              handler: async (ctx: MutationCtx, args: { order: number }) => {
                const doc = await ctx.db
                  .query("items")
                  .withIndex("by_order", (q) => q.eq("order", args.order))
                  .first();
                if (doc) {
                  await ctx.db.delete(doc._id);
                }
              },
            }),
            list: queryGeneric({
              handler: async (
                ctx: QueryCtx,
                args: { paginationOpts: PaginationOptions },
              ) => {
                handlerCalls.list += 1;
                return ctx.db
                  .query("items")
                  .withIndex("by_order")
                  .order("asc")
                  .paginate(args.paginationOpts);
              },
            }),
            listDesc: queryGeneric({
              handler: async (
                ctx: QueryCtx,
                args: { paginationOpts: PaginationOptions },
              ) => {
                handlerCalls.listDesc += 1;
                return ctx.db
                  .query("items")
                  .withIndex("by_order")
                  .order("desc")
                  .paginate(args.paginationOpts);
              },
            }),
            all: queryGeneric({
              handler: async (ctx: QueryCtx, args: { order: "asc" | "desc" }) =>
                ctx.db
                  .query("items")
                  .withIndex("by_order")
                  .order(args.order)
                  .collect(),
            }),
          }),
      },
    },
  });
}

async function insert(runtime: EmbeddedRuntime, order: number): Promise<void> {
  await runtime.executeLocal({
    kind: "mutation",
    path: "items:insert",
    args: { order },
    applyLocalEffects: true,
  });
  await runtime.refreshLocalQueryWatches();
  await flushMicrotasks(6);
}

async function removeByOrder(
  runtime: EmbeddedRuntime,
  order: number,
): Promise<void> {
  await runtime.executeLocal({
    kind: "mutation",
    path: "items:removeByOrder",
    args: { order },
    applyLocalEffects: true,
  });
  await runtime.refreshLocalQueryWatches();
  await flushMicrotasks(6);
}

async function waitForSnapshot(
  runtime: EmbeddedRuntime,
  watch: { localQueryResult(): unknown },
): Promise<PaginatedSnapshot> {
  for (let i = 0; i < 30; i += 1) {
    const value = watch.localQueryResult() as PaginatedSnapshot | undefined;
    if (value !== undefined) {
      return value;
    }
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(4);
  }
  throw new Error("paginated snapshot never resolved");
}

async function fullOrdered(
  runtime: EmbeddedRuntime,
  order: "asc" | "desc",
): Promise<number[]> {
  const rows = (await runtime.executeLocal({
    kind: "query",
    path: "items:all",
    args: { order },
  })) as Array<{ order: number }>;
  return rows.map((row) => row.order);
}

let runtimes: EmbeddedRuntime[] = [];

function track(runtime: EmbeddedRuntime): EmbeddedRuntime {
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of runtimes) {
    runtime.shutdown();
  }
  runtimes = [];
});

describe("reactive paginated watch parity", () => {
  it("stays consistent after inserting inside an earlier page's range", async () => {
    const runtime = track(makeRuntime());
    await runtime.hydrate();
    for (let order = 0; order < 20; order += 1) {
      await insert(runtime, order * 2);
    }

    const watch = runtime.watchLocalPaginatedQuery<{
      _id: string;
      order: number;
    }>("items:list", {}, { initialNumItems: 4 });
    watch.onUpdate(() => {});
    await flushMicrotasks(10);
    await waitForSnapshot(runtime, watch);

    const snapshot = () => watch.localQueryResult() as PaginatedSnapshot;

    snapshot().loadMore(4);
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(10);
    snapshot().loadMore(4);
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(10);

    const loadedBefore = snapshot().results.map((r) => r.order);
    expect(loadedBefore).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);

    await insert(runtime, 5);
    await flushMicrotasks(10);

    const after = snapshot().results.map((r) => r.order);
    expect(new Set(after).size).toBe(after.length);
    const expectedPrefix = (await fullOrdered(runtime, "asc")).slice(
      0,
      after.length,
    );
    expect(after).toEqual(expectedPrefix);
    expect(after).toContain(5);
  });

  it("stays consistent after deleting inside an earlier page's range", async () => {
    const runtime = track(makeRuntime());
    await runtime.hydrate();
    for (let order = 0; order < 16; order += 1) {
      await insert(runtime, order);
    }

    const watch = runtime.watchLocalPaginatedQuery<{
      _id: string;
      order: number;
    }>("items:list", {}, { initialNumItems: 4 });
    watch.onUpdate(() => {});
    await flushMicrotasks(10);
    await waitForSnapshot(runtime, watch);
    const snapshot = () => watch.localQueryResult() as PaginatedSnapshot;

    snapshot().loadMore(4);
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(10);

    await removeByOrder(runtime, 2);
    await flushMicrotasks(10);

    const after = snapshot().results.map((r) => r.order);
    expect(after).not.toContain(2);
    expect(new Set(after).size).toBe(after.length);
    const expectedPrefix = (await fullOrdered(runtime, "asc")).slice(
      0,
      after.length,
    );
    expect(after).toEqual(expectedPrefix);
  });

  it("loadMore re-runs a constant number of pages, not all of them", async () => {
    const runtime = track(makeRuntime());
    await runtime.hydrate();
    for (let order = 0; order < 40; order += 1) {
      await insert(runtime, order);
    }

    const watch = runtime.watchLocalPaginatedQuery<{
      _id: string;
      order: number;
    }>("items:list", {}, { initialNumItems: 4 });
    watch.onUpdate(() => {});
    await flushMicrotasks(10);
    await waitForSnapshot(runtime, watch);
    const snapshot = () => watch.localQueryResult() as PaginatedSnapshot;

    const deltas: number[] = [];
    let previous = handlerCalls.list;
    for (let page = 0; page < 6; page += 1) {
      snapshot().loadMore(4);
      await runtime.refreshLocalQueryWatches();
      await flushMicrotasks(10);
      deltas.push(handlerCalls.list - previous);
      previous = handlerCalls.list;
    }

    // Re-running every page would make each loadMore cost grow with the number
    // of loaded pages (2,3,4,5,...). With (cursor,endCursor] pinning + per-page
    // caching, each loadMore re-runs only the new page plus the boundary page.
    for (const delta of deltas) {
      expect(delta).toBeLessThanOrEqual(2);
    }
    expect(deltas[deltas.length - 1]).toBeLessThanOrEqual(2);

    expect(snapshot().results.map((r) => r.order)).toEqual(
      Array.from({ length: 28 }, (_, index) => index),
    );
  });

  it("paginates in descending order with reactive consistency", async () => {
    const runtime = track(makeRuntime());
    await runtime.hydrate();
    for (let order = 0; order < 12; order += 1) {
      await insert(runtime, order);
    }

    const watch = runtime.watchLocalPaginatedQuery<{
      _id: string;
      order: number;
    }>("items:listDesc", {}, { initialNumItems: 4 });
    watch.onUpdate(() => {});
    await flushMicrotasks(10);
    await waitForSnapshot(runtime, watch);
    const snapshot = () => watch.localQueryResult() as PaginatedSnapshot;

    snapshot().loadMore(4);
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(10);

    await insert(runtime, 100);
    await flushMicrotasks(10);

    const after = snapshot().results.map((r) => r.order);
    expect(new Set(after).size).toBe(after.length);
    const expectedPrefix = (await fullOrdered(runtime, "desc")).slice(
      0,
      after.length,
    );
    expect(after).toEqual(expectedPrefix);
  });

  it("splits an overgrown page and keeps the list consistent", async () => {
    const runtime = track(makeRuntime());
    await runtime.hydrate();
    for (let order = 0; order < 6; order += 1) {
      await insert(runtime, order);
    }

    const watch = runtime.watchLocalPaginatedQuery<{
      _id: string;
      order: number;
    }>("items:list", {}, { initialNumItems: 4 });
    watch.onUpdate(() => {});
    await flushMicrotasks(10);
    await waitForSnapshot(runtime, watch);
    const snapshot = () => watch.localQueryResult() as PaginatedSnapshot;

    snapshot().loadMore(4);
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(10);

    for (let i = 0; i < 30; i += 1) {
      await insert(runtime, 1000 + i);
    }
    snapshot().loadMore(4);
    await runtime.refreshLocalQueryWatches();
    await flushMicrotasks(20);

    const after = snapshot().results.map((r) => r.order);
    expect(new Set(after).size).toBe(after.length);
    const expectedPrefix = (await fullOrdered(runtime, "asc")).slice(
      0,
      after.length,
    );
    expect(after).toEqual(expectedPrefix);
  });
});
