import { parseSchema, type SchemaExport } from "@embedded/runtime/db/schema";
import { embeddedTest, testMutation, testQuery } from "@tests/helpers/embedded";
import { describe, expect, it } from "@tests/testkit";
import {
  defineSchema,
  defineTable,
  type PaginationOptions,
} from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  tasks: defineTable({
    status: v.string(),
    order: v.number(),
    tiebreak: v.number(),
    title: v.string(),
  })
    .index("by_status_and_order", ["status", "order"])
    .index("by_status_and_order_and_tiebreak", ["status", "order", "tiebreak"]),
});

interface Page {
  page: Array<Record<string, unknown>>;
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
}

function makeHarness() {
  return embeddedTest({
    schema: parseSchema(schema as unknown as SchemaExport),
    modules: {
      "tasks:insert": testMutation(
        async (
          ctx,
          args: {
            status: string;
            order: number;
            tiebreak: number;
            title: string;
          },
        ) => ctx.db.insert("tasks", args),
      ),
      "tasks:page": testQuery(
        async (
          ctx,
          args: {
            status: string;
            order: "asc" | "desc";
            paginationOpts: PaginationOptions;
          },
        ) =>
          ctx.db
            .query("tasks")
            .withIndex("by_status_and_order", (q) =>
              q.eq("status", args.status),
            )
            .order(args.order)
            .paginate(args.paginationOpts),
      ),
      "tasks:pageMulti": testQuery(
        async (
          ctx,
          args: { status: string; paginationOpts: PaginationOptions },
        ) =>
          ctx.db
            .query("tasks")
            .withIndex("by_status_and_order_and_tiebreak", (q) =>
              q.eq("status", args.status),
            )
            .order("asc")
            .paginate(args.paginationOpts),
      ),
      "tasks:fullScanPage": testQuery(
        async (ctx, args: { paginationOpts: PaginationOptions }) =>
          ctx.db.query("tasks").order("asc").paginate(args.paginationOpts),
      ),
    },
  });
}

async function walkAll(
  query: (cursor: string | null) => Promise<Page>,
): Promise<Array<Record<string, unknown>>> {
  const collected: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (;;) {
    const next = await query(cursor);
    collected.push(...next.page);
    if (next.isDone) {
      break;
    }
    expect(next.continueCursor).not.toBe("_end_cursor");
    cursor = next.continueCursor;
  }
  return collected;
}

describe("paginated index seek", () => {
  it("walks every doc exactly once across pages with no dupes or gaps", async () => {
    const t = makeHarness();
    for (let order = 0; order < 25; order += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order,
        tiebreak: 0,
        title: `task-${order}`,
      });
    }

    const collected = await walkAll((cursor) =>
      t.query("tasks:page", {
        status: "active",
        order: "asc",
        paginationOpts: { cursor, numItems: 4 },
      }),
    );

    expect(collected).toHaveLength(25);
    expect(new Set(collected.map((doc) => String(doc._id))).size).toBe(25);
    expect(collected.map((doc) => doc.order)).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );
  });

  it("reports isDone on the last page at an exact page boundary", async () => {
    const t = makeHarness();
    for (let order = 0; order < 6; order += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order,
        tiebreak: 0,
        title: `task-${order}`,
      });
    }

    const first = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: { cursor: null, numItems: 3 },
    })) as Page;
    expect(first.page).toHaveLength(3);
    expect(first.isDone).toBe(false);

    const second = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: { cursor: first.continueCursor, numItems: 3 },
    })) as Page;
    expect(second.page).toHaveLength(3);
    expect(second.isDone).toBe(true);
    expect(second.continueCursor).toBe("_end_cursor");

    const all = [...first.page, ...second.page];
    expect(all.map((doc) => doc.order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("paginates in descending order", async () => {
    const t = makeHarness();
    for (let order = 0; order < 10; order += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order,
        tiebreak: 0,
        title: `task-${order}`,
      });
    }

    const collected = await walkAll((cursor) =>
      t.query("tasks:page", {
        status: "active",
        order: "desc",
        paginationOpts: { cursor, numItems: 3 },
      }),
    );

    expect(collected.map((doc) => doc.order)).toEqual([
      9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
    ]);
    expect(new Set(collected.map((doc) => String(doc._id))).size).toBe(10);
  });

  it("walks correctly when many rows tie on the order field", async () => {
    const t = makeHarness();
    for (let index = 0; index < 30; index += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order: index < 20 ? 1 : 2,
        tiebreak: index,
        title: `task-${index}`,
      });
    }

    const collected = await walkAll((cursor) =>
      t.query("tasks:page", {
        status: "active",
        order: "asc",
        paginationOpts: { cursor, numItems: 4 },
      }),
    );

    expect(collected).toHaveLength(30);
    expect(new Set(collected.map((doc) => String(doc._id))).size).toBe(30);
    const orders = collected.map((doc) => doc.order);
    expect(orders.filter((value) => value === 1)).toHaveLength(20);
    expect(orders.filter((value) => value === 2)).toHaveLength(10);
    for (let index = 1; index < orders.length; index += 1) {
      expect(Number(orders[index])).toBeGreaterThanOrEqual(
        Number(orders[index - 1]),
      );
    }
  });

  it("walks a multi-field index with ties on the leading order field", async () => {
    const t = makeHarness();
    const expected: Array<{ order: number; tiebreak: number }> = [];
    for (let order = 0; order < 4; order += 1) {
      for (let tiebreak = 0; tiebreak < 5; tiebreak += 1) {
        await t.mutation("tasks:insert", {
          status: "active",
          order,
          tiebreak,
          title: `task-${order}-${tiebreak}`,
        });
        expected.push({ order, tiebreak });
      }
    }

    const collected = await walkAll((cursor) =>
      t.query("tasks:pageMulti", {
        status: "active",
        paginationOpts: { cursor, numItems: 3 },
      }),
    );

    expect(collected).toHaveLength(20);
    expect(new Set(collected.map((doc) => String(doc._id))).size).toBe(20);
    expect(
      collected.map((doc) => ({
        order: doc.order as number,
        tiebreak: doc.tiebreak as number,
      })),
    ).toEqual(expected);
  });

  it("pins a page to (cursor, endCursor] when endCursor is provided", async () => {
    const t = makeHarness();
    for (let order = 0; order < 12; order += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order,
        tiebreak: 0,
        title: `task-${order}`,
      });
    }

    const first = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: { cursor: null, numItems: 4 },
    })) as Page;
    const second = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: { cursor: first.continueCursor, numItems: 4 },
    })) as Page;

    const pinnedFirst = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: {
        cursor: null,
        endCursor: first.continueCursor,
        numItems: 4,
      },
    })) as Page;

    expect(pinnedFirst.page.map((doc) => doc.order)).toEqual(
      first.page.map((doc) => doc.order),
    );
    expect(pinnedFirst.isDone).toBe(false);
    expect(pinnedFirst.continueCursor).toBe(first.continueCursor);

    const pinnedSecond = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: {
        cursor: first.continueCursor,
        endCursor: second.continueCursor,
        numItems: 4,
      },
    })) as Page;
    expect(pinnedSecond.page.map((doc) => doc.order)).toEqual(
      second.page.map((doc) => doc.order),
    );
  });

  it("keeps a pinned page stable across an insert inside its range", async () => {
    const t = makeHarness();
    for (let order = 0; order < 12; order += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order: order * 2,
        tiebreak: 0,
        title: `task-${order * 2}`,
      });
    }

    const first = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: { cursor: null, numItems: 4 },
    })) as Page;

    await t.mutation("tasks:insert", {
      status: "active",
      order: 3,
      tiebreak: 0,
      title: "task-inserted",
    });

    const pinnedFirst = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: {
        cursor: null,
        endCursor: first.continueCursor,
        numItems: 4,
      },
    })) as Page;

    expect(pinnedFirst.continueCursor).toBe(first.continueCursor);
    expect(pinnedFirst.page.map((doc) => doc.order)).toEqual([0, 2, 3, 4, 6]);
  });

  it("emits splitCursor / pageStatus for an overgrown pinned page", async () => {
    const t = makeHarness();
    for (let order = 0; order < 30; order += 1) {
      await t.mutation("tasks:insert", {
        status: "active",
        order,
        tiebreak: 0,
        title: `task-${order}`,
      });
    }

    const pinned = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: {
        cursor: null,
        endCursor: "_end_cursor",
        numItems: 4,
      },
    })) as Page;

    expect(pinned.page).toHaveLength(30);
    expect(pinned.isDone).toBe(true);
    expect(pinned.pageStatus).toBe("SplitRequired");
    expect(typeof pinned.splitCursor).toBe("string");

    const head = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: {
        cursor: null,
        endCursor: pinned.splitCursor as string,
        numItems: 4,
      },
    })) as Page;
    const tail = (await t.query("tasks:page", {
      status: "active",
      order: "asc",
      paginationOpts: {
        cursor: pinned.splitCursor as string,
        endCursor: "_end_cursor",
        numItems: 4,
      },
    })) as Page;

    expect([...head.page, ...tail.page].map((doc) => doc.order)).toEqual(
      Array.from({ length: 30 }, (_, index) => index),
    );
    expect(new Set([...head.page, ...tail.page].map((d) => d._id)).size).toBe(
      30,
    );
  });

  it("walks a full table scan ordered by creation time", async () => {
    const t = makeHarness();
    for (let index = 0; index < 12; index += 1) {
      await t.mutation("tasks:insert", {
        status: index % 2 === 0 ? "active" : "blocked",
        order: index,
        tiebreak: 0,
        title: `task-${index}`,
      });
    }

    const collected = await walkAll((cursor) =>
      t.query("tasks:fullScanPage", {
        paginationOpts: { cursor, numItems: 5 },
      }),
    );

    expect(collected).toHaveLength(12);
    expect(new Set(collected.map((doc) => String(doc._id))).size).toBe(12);
    expect(collected.map((doc) => doc.order)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
  });
});
