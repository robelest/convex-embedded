import type { SerializedQuery } from "@embedded/runtime/db/types";
import { afterAll, bench, describe } from "@tests/testkit";

import {
  closeTrackedResources,
  fullScanQuery,
  indexRangeQuery,
  seededSqliteDb,
  sizeByLabel,
} from "./helpers";

const medium = sizeByLabel("medium");
const seeded = await seededSqliteDb(medium, { withIndex: true });
const db = seeded.db;

afterAll(closeTrackedResources);

const byStatusActive = indexRangeQuery("tasks.by_status", [
  { type: "Eq", fieldPath: "status", value: "active" },
]);
const fullScan = fullScanQuery("tasks");

async function paginateAll(
  query: SerializedQuery,
  pageSize: number,
): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  for (;;) {
    const page = await db.paginateAsync({ query, cursor, pageSize });
    total += page.page.length;
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return total;
}

const LOAD_MORE_PAGES = 10;
const LOAD_MORE_PAGE_SIZE = 50;

async function reactiveLoadMoreNaive(
  query: SerializedQuery,
  pages: number,
  pageSize: number,
): Promise<number> {
  let work = 0;
  for (let loaded = 1; loaded <= pages; loaded += 1) {
    let cursor: string | null = null;
    for (let page = 0; page < loaded; page += 1) {
      const result = await db.paginateAsync({ query, cursor, pageSize });
      work += result.page.length;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
  }
  return work;
}

async function reactiveLoadMorePinned(
  query: SerializedQuery,
  pages: number,
  pageSize: number,
): Promise<number> {
  let work = 0;
  const cursors: Array<string | null> = [null];
  for (let loaded = 1; loaded <= pages; loaded += 1) {
    const cursor = cursors[cursors.length - 1] ?? null;
    const probe = await db.paginateAsync({ query, cursor, pageSize });
    const endCursor = probe.isDone ? "_end_cursor" : probe.continueCursor;
    const previousBoundary =
      cursors.length >= 2 ? (cursors[cursors.length - 2] ?? null) : null;
    if (cursors.length >= 2) {
      const boundary = await db.paginateAsync({
        query,
        cursor: previousBoundary,
        endCursor: cursor,
        pageSize,
      });
      work += boundary.page.length;
    }
    const pinned = await db.paginateAsync({
      query,
      cursor,
      endCursor,
      pageSize,
    });
    work += pinned.page.length;
    if (probe.isDone) break;
    cursors.push(probe.continueCursor);
  }
  return work;
}

describe("pagination (real indexed SQLite, 10k docs)", () => {
  bench("first page — indexed Eq(status=active), pageSize=50", async () => {
    await db.paginateAsync({
      query: byStatusActive,
      cursor: null,
      pageSize: 50,
    });
  });

  bench("first page — full table scan, pageSize=50", async () => {
    await db.paginateAsync({ query: fullScan, cursor: null, pageSize: 50 });
  });

  bench("paginate entire indexed range, pageSize=100", async () => {
    await paginateAll(byStatusActive, 100);
  });

  bench("reactive loadMore x10 — naive re-run-all-pages", async () => {
    await reactiveLoadMoreNaive(
      byStatusActive,
      LOAD_MORE_PAGES,
      LOAD_MORE_PAGE_SIZE,
    );
  });

  bench("reactive loadMore x10 — endCursor pinned (boundary only)", async () => {
    await reactiveLoadMorePinned(
      byStatusActive,
      LOAD_MORE_PAGES,
      LOAD_MORE_PAGE_SIZE,
    );
  });
});
