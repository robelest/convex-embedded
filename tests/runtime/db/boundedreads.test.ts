import { parseSchema, type SchemaExport } from "@embedded/runtime/db/schema";
import { embeddedTest, testMutation, testQuery } from "@tests/helpers/embedded";
import { describe, expect, it } from "@tests/testkit";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = defineSchema({
  items: defineTable({
    bucket: v.string(),
    rank: v.number(),
    flag: v.boolean(),
  })
    .index("by_bucket_and_rank", ["bucket", "rank"])
    .index("by_rank", ["rank"]),
});

function makeHarness() {
  return embeddedTest({
    schema: parseSchema(schema as unknown as SchemaExport),
    modules: {
      "items:insert": testMutation(
        async (ctx, args: { bucket: string; rank: number; flag: boolean }) =>
          ctx.db.insert("items", args),
      ),
      "items:takeFilteredScan": testQuery(
        async (ctx, args: { n: number; flag: boolean }) =>
          ctx.db
            .query("items")
            .filter((q) => q.eq(q.field("flag"), args.flag))
            .take(args.n),
      ),
      "items:firstFilteredScan": testQuery(
        async (ctx, args: { flag: boolean }) =>
          ctx.db
            .query("items")
            .filter((q) => q.eq(q.field("flag"), args.flag))
            .first(),
      ),
      "items:uniqueFilteredScan": testQuery(
        async (ctx, args: { rank: number }) =>
          ctx.db
            .query("items")
            .filter((q) => q.eq(q.field("rank"), args.rank))
            .unique(),
      ),
      "items:takeFilteredIndex": testQuery(
        async (ctx, args: { bucket: string; n: number; flag: boolean }) =>
          ctx.db
            .query("items")
            .withIndex("by_bucket_and_rank", (q) => q.eq("bucket", args.bucket))
            .filter((q) => q.eq(q.field("flag"), args.flag))
            .take(args.n),
      ),
      "items:scanOrdered": testQuery(
        async (ctx, args: { order: "asc" | "desc" }) =>
          ctx.db.query("items").order(args.order).collect(),
      ),
      "items:indexOrdered": testQuery(
        async (ctx, args: { bucket: string; order: "asc" | "desc" }) =>
          ctx.db
            .query("items")
            .withIndex("by_bucket_and_rank", (q) => q.eq("bucket", args.bucket))
            .order(args.order)
            .collect(),
      ),
      "items:takeOrdered": testQuery(
        async (ctx, args: { order: "asc" | "desc"; n: number }) =>
          ctx.db.query("items").order(args.order).take(args.n),
      ),
    },
  });
}

async function seed(
  t: ReturnType<typeof makeHarness>,
  rows: Array<{ bucket: string; rank: number; flag: boolean }>,
): Promise<void> {
  for (const row of rows) {
    await t.mutation("items:insert", row);
  }
}

describe("bounded take/first/unique with .filter()", () => {
  it("take returns fewer than n when matches are scarce", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 0, flag: true },
      { bucket: "a", rank: 1, flag: false },
      { bucket: "a", rank: 2, flag: false },
      { bucket: "a", rank: 3, flag: false },
    ]);

    const result = await t.query("items:takeFilteredScan", {
      n: 5,
      flag: true,
    });
    expect(result.map((r) => r.rank)).toEqual([0]);
  });

  it("take returns exactly n when matches equal n", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 0, flag: true },
      { bucket: "a", rank: 1, flag: false },
      { bucket: "a", rank: 2, flag: true },
      { bucket: "a", rank: 3, flag: false },
    ]);

    const result = await t.query("items:takeFilteredScan", {
      n: 2,
      flag: true,
    });
    expect(result.map((r) => r.rank)).toEqual([0, 2]);
  });

  it("take caps at n when more than n match (selective over large table)", async () => {
    const t = makeHarness();
    const rows: Array<{ bucket: string; rank: number; flag: boolean }> = [];
    for (let i = 0; i < 200; i += 1) {
      rows.push({ bucket: "a", rank: i, flag: i % 50 === 0 });
    }
    await seed(t, rows);

    const result = await t.query("items:takeFilteredScan", {
      n: 3,
      flag: true,
    });
    expect(result.map((r) => r.rank)).toEqual([0, 50, 100]);
  });

  it("take stays correct when matches span past the initial read window", async () => {
    const t = makeHarness();
    const rows: Array<{ bucket: string; rank: number; flag: boolean }> = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push({ bucket: "a", rank: i, flag: i >= 80 });
    }
    await seed(t, rows);

    const result = await t.query("items:takeFilteredScan", {
      n: 4,
      flag: true,
    });
    expect(result.map((r) => r.rank)).toEqual([80, 81, 82, 83]);
  });

  it("first returns the earliest match", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 0, flag: false },
      { bucket: "a", rank: 1, flag: false },
      { bucket: "a", rank: 2, flag: true },
      { bucket: "a", rank: 3, flag: true },
    ]);

    const result = await t.query("items:firstFilteredScan", { flag: true });
    expect(result?.rank).toBe(2);
  });

  it("first returns null when nothing matches", async () => {
    const t = makeHarness();
    await seed(t, [{ bucket: "a", rank: 0, flag: false }]);

    const result = await t.query("items:firstFilteredScan", { flag: true });
    expect(result).toBeNull();
  });

  it("unique returns the single match", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 5, flag: true },
      { bucket: "a", rank: 6, flag: false },
      { bucket: "a", rank: 7, flag: false },
    ]);

    const result = await t.query("items:uniqueFilteredScan", { rank: 5 });
    expect(result?.rank).toBe(5);
  });

  it("unique still detects the more-than-one case", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 5, flag: true },
      { bucket: "a", rank: 5, flag: false },
      { bucket: "a", rank: 6, flag: false },
    ]);

    await expect(
      t.query("items:uniqueFilteredScan", { rank: 5 }),
    ).rejects.toThrow();
  });

  it("bounded take over an index range with a filter respects the range", async () => {
    const t = makeHarness();
    const rows: Array<{ bucket: string; rank: number; flag: boolean }> = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push({ bucket: "a", rank: i, flag: i % 20 === 0 });
    }
    for (let i = 0; i < 60; i += 1) {
      rows.push({ bucket: "b", rank: i, flag: true });
    }
    await seed(t, rows);

    const result = await t.query("items:takeFilteredIndex", {
      bucket: "a",
      n: 2,
      flag: true,
    });
    expect(result.every((r) => r.bucket === "a")).toBe(true);
    expect(result.map((r) => r.rank)).toEqual([0, 20]);
  });
});

describe("ordering is correct when the sort is skipped", () => {
  it("full scan asc and desc return correct order", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 2, flag: true },
      { bucket: "a", rank: 0, flag: true },
      { bucket: "a", rank: 1, flag: true },
    ]);

    const asc = await t.query("items:scanOrdered", { order: "asc" });
    expect(asc.map((r) => r.rank)).toEqual([2, 0, 1]);

    const desc = await t.query("items:scanOrdered", { order: "desc" });
    expect(desc.map((r) => r.rank)).toEqual([1, 0, 2]);
  });

  it("index scan asc and desc return correct order", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 2, flag: true },
      { bucket: "a", rank: 0, flag: true },
      { bucket: "a", rank: 1, flag: true },
    ]);

    const asc = await t.query("items:indexOrdered", {
      bucket: "a",
      order: "asc",
    });
    expect(asc.map((r) => r.rank)).toEqual([0, 1, 2]);

    const desc = await t.query("items:indexOrdered", {
      bucket: "a",
      order: "desc",
    });
    expect(desc.map((r) => r.rank)).toEqual([2, 1, 0]);
  });

  it("take respects skipped-sort ordering for asc and desc", async () => {
    const t = makeHarness();
    await seed(t, [
      { bucket: "a", rank: 2, flag: true },
      { bucket: "a", rank: 0, flag: true },
      { bucket: "a", rank: 1, flag: true },
      { bucket: "a", rank: 3, flag: true },
    ]);

    const asc = await t.query("items:takeOrdered", { order: "asc", n: 2 });
    expect(asc.map((r) => r.rank)).toEqual([2, 0]);

    const desc = await t.query("items:takeOrdered", { order: "desc", n: 2 });
    expect(desc.map((r) => r.rank)).toEqual([3, 1]);
  });
});
