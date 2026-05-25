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
  items: defineTable({
    bucket: v.string(),
    rank: v.number(),
    flag: v.boolean(),
    blob: v.string(),
  }).index("by_bucket_and_rank", ["bucket", "rank"]),
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
      "items:insert": testMutation(
        async (
          ctx,
          args: { bucket: string; rank: number; flag: boolean; blob: string },
        ) => ctx.db.insert("items", args),
      ),
      "items:indexPage": testQuery(
        async (
          ctx,
          args: { bucket: string; paginationOpts: PaginationOptions },
        ) =>
          ctx.db
            .query("items")
            .withIndex("by_bucket_and_rank", (q) => q.eq("bucket", args.bucket))
            .order("asc")
            .paginate(args.paginationOpts),
      ),
      "items:scanPage": testQuery(
        async (ctx, args: { paginationOpts: PaginationOptions }) =>
          ctx.db.query("items").order("asc").paginate(args.paginationOpts),
      ),
    },
  });
}

async function seed(
  t: ReturnType<typeof makeHarness>,
  rows: Array<{ bucket: string; rank: number; flag: boolean; blob: string }>,
): Promise<void> {
  for (const row of rows) {
    await t.mutation("items:insert", row);
  }
}

function rows(
  count: number,
  blob = "x",
): Array<{ bucket: string; rank: number; flag: boolean; blob: string }> {
  return Array.from({ length: count }, (_, index) => ({
    bucket: "a",
    rank: index,
    flag: index % 2 === 0,
    blob: blob.repeat(64),
  }));
}

describe("pagination read budgets", () => {
  it("maximumRowsRead stops the page early with SplitRequired", async () => {
    const t = makeHarness();
    await seed(t, rows(100));

    const page = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: { numItems: 50, cursor: null, maximumRowsRead: 10 },
    })) as Page;

    expect(page.pageStatus).toBe("SplitRequired");
    expect(page.isDone).toBe(false);
    expect(page.page.length).toBeLessThan(50);
    expect(page.page.length).toBeGreaterThan(0);
  });

  it("maximumBytesRead stops the page early with SplitRequired", async () => {
    const t = makeHarness();
    await seed(t, rows(100));

    const page = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: { numItems: 50, cursor: null, maximumBytesRead: 200 },
    })) as Page;

    expect(page.pageStatus).toBe("SplitRequired");
    expect(page.isDone).toBe(false);
    expect(page.page.length).toBeLessThan(50);
    expect(page.page.length).toBeGreaterThan(0);
  });

  it("absent budget returns the full requested page unchanged", async () => {
    const t = makeHarness();
    await seed(t, rows(100));

    const page = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: { numItems: 50, cursor: null },
    })) as Page;

    expect(page.pageStatus ?? null).toBeNull();
    expect(page.page.length).toBe(50);
    expect(page.isDone).toBe(false);
  });

  it("a budget high enough for the page leaves results unchanged", async () => {
    const t = makeHarness();
    await seed(t, rows(20));

    const bounded = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: { numItems: 10, cursor: null, maximumRowsRead: 1000 },
    })) as Page;
    const unbounded = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: { numItems: 10, cursor: null },
    })) as Page;

    expect(bounded.page.map((row) => row.rank)).toEqual(
      unbounded.page.map((row) => row.rank),
    );
    expect(bounded.pageStatus ?? null).toBeNull();
  });

  it("a budget-bounded page continues from its continueCursor", async () => {
    const t = makeHarness();
    await seed(t, rows(100));

    const first = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: { numItems: 50, cursor: null, maximumRowsRead: 10 },
    })) as Page;
    expect(first.pageStatus).toBe("SplitRequired");

    const second = (await t.query("items:indexPage", {
      bucket: "a",
      paginationOpts: {
        numItems: 50,
        cursor: first.continueCursor,
        maximumRowsRead: 10,
      },
    })) as Page;

    const firstRanks = first.page.map((row) => row.rank as number);
    const secondRanks = second.page.map((row) => row.rank as number);
    const lastOfFirst = firstRanks.at(-1) ?? -1;
    expect(secondRanks.every((rank) => rank > lastOfFirst)).toBe(true);
  });

  it("maximumRowsRead bounds a full-table-scan page", async () => {
    const t = makeHarness();
    await seed(t, rows(100));

    const page = (await t.query("items:scanPage", {
      paginationOpts: { numItems: 50, cursor: null, maximumRowsRead: 8 },
    })) as Page;

    expect(page.pageStatus).toBe("SplitRequired");
    expect(page.isDone).toBe(false);
    expect(page.page.length).toBeLessThanOrEqual(8);
    expect(page.page.length).toBeGreaterThan(0);
  });
});
