import {
  getCollectionChanges,
  getLiveState,
  getLiveStates,
  getLiveStatesPage,
  recordDelete,
  recordUpdate,
} from "@resolve/component/public";
import { beforeEach, describe, expect, it, vi } from "@tests/testkit";
import * as Y from "yjs";

type TableName =
  | "collectionHeads"
  | "collectionTail"
  | "liveStates"
  | "deltaTail";

type Row = Record<string, unknown> & { _id: string };

interface RangeFilter {
  field: string;
  op: "eq" | "gt" | "gte" | "lt" | "lte";
  value: unknown;
}

interface IndexFilterBuilder {
  eq(field: string, value: unknown): IndexFilterBuilder;
  gt(field: string, value: unknown): IndexFilterBuilder;
  gte(field: string, value: unknown): IndexFilterBuilder;
  lt(field: string, value: unknown): IndexFilterBuilder;
  lte(field: string, value: unknown): IndexFilterBuilder;
}

interface PaginateResult {
  page: Row[];
  isDone: boolean;
  continueCursor: string | null;
}

interface QueryChain {
  unique(): Promise<Row | null>;
  first(): Promise<Row | null>;
  collect(): Promise<Row[]>;
  take(count: number): Promise<Row[]>;
  paginate(opts: {
    cursor: string | null;
    numItems: number;
  }): Promise<PaginateResult>;
  order(direction: "asc" | "desc"): QueryChain;
  filter(predicate: (row: Row) => boolean): QueryChain;
}

interface QueryTable extends QueryChain {
  withIndex(
    indexName: string,
    builder: (q: IndexFilterBuilder) => IndexFilterBuilder,
  ): QueryChain;
}

interface MockDb {
  query(tableName: string): QueryTable;
  insert(tableName: string, value: Record<string, unknown>): Promise<string>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
}

interface MockCtx {
  db: MockDb;
  tables: Record<TableName, Row[]>;
}

/** A registered Convex function exposes its handler under `_handler` at runtime. */
type HandlerOf<Args, Result> = {
  _handler: (ctx: MockCtx, args: Args) => Promise<Result>;
};

function handlerOf<Args, Result>(
  fn: unknown,
): (ctx: MockCtx, args: Args) => Promise<Result> {
  return (fn as HandlerOf<Args, Result>)._handler;
}

interface RecordUpdateArgs {
  collection: string;
  docId: string;
  update: ArrayBuffer;
  docCreationTime: number;
  keepTailCount?: number;
  keepCollectionTailCount?: number;
  tailByteLimit?: number;
}

interface RecordDeleteArgs {
  collection: string;
  docId: string;
  keepCollectionTailCount?: number;
}

interface LiveStateResult {
  update: ArrayBuffer;
  seq: number;
  docCreationTime?: number;
}

interface LiveStatesEntry {
  docId: string;
  update: ArrayBuffer;
  seq: number;
  docCreationTime?: number;
}

interface CollectionChange {
  docId: string;
  kind: "upsert" | "delete";
}

interface CollectionChangesResult {
  mode: "full" | "incremental";
  collectionSeq: number;
  isGapDetected: boolean;
  changes: CollectionChange[];
}

interface LiveStatesPageResult {
  page: LiveStatesEntry[];
  continueCursor: string | null;
  isDone: boolean;
}

const recordUpdateHandler = handlerOf<RecordUpdateArgs, unknown>(recordUpdate);
const recordDeleteHandler = handlerOf<RecordDeleteArgs, unknown>(recordDelete);
const getCollectionChangesHandler = handlerOf<
  { collection: string; sinceSeq: number | null },
  CollectionChangesResult
>(getCollectionChanges);
const getLiveStateHandler = handlerOf<
  { collection: string; docId: string },
  LiveStateResult | null
>(getLiveState);
const getLiveStatesHandler = handlerOf<
  { collection: string; docIds?: string[] },
  Array<LiveStatesEntry | null>
>(getLiveStates);
const getLiveStatesPageHandler = handlerOf<
  { collection: string; cursor?: string | null; limit?: number },
  LiveStatesPageResult
>(getLiveStatesPage);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function numericField(row: Row, field: string): number {
  const value = row[field];
  return typeof value === "number" ? value : 0;
}

function createMockCtx(): MockCtx {
  const tables: Record<TableName, Row[]> = {
    collectionHeads: [],
    collectionTail: [],
    liveStates: [],
    deltaTail: [],
  };
  let idCounter = 0;

  function terminalMethods(rows: Row[]): QueryChain {
    return {
      unique: async () => {
        if (rows.length > 1) {
          throw new Error("Expected unique result");
        }
        return clone(rows[0] ?? null);
      },
      first: async () => clone(rows[0] ?? null),
      collect: async () => clone(rows),
      take: async (count) => clone(rows.slice(0, count)),
      paginate: async (opts) => {
        const start = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0;
        const end = start + opts.numItems;
        return {
          page: clone(rows.slice(start, end)),
          isDone: end >= rows.length,
          continueCursor: end < rows.length ? String(end) : null,
        };
      },
      order: (direction) => {
        const sorted = [...rows].sort((a, b) => {
          const field = "_creationTime" in a ? "_creationTime" : "seq";
          const delta = numericField(a, field) - numericField(b, field);
          return direction === "desc" ? -delta : delta;
        });
        return terminalMethods(sorted);
      },
      filter: (predicate) => terminalMethods(rows.filter(predicate)),
    };
  }

  function compare(a: unknown, b: unknown): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }

  function applyFilters(tableName: TableName, filters: RangeFilter[]): Row[] {
    return tables[tableName].filter((row) =>
      filters.every(({ field, op, value }) => {
        const current = row[field];
        switch (op) {
          case "gt":
            return compare(current, value) > 0;
          case "gte":
            return compare(current, value) >= 0;
          case "lt":
            return compare(current, value) < 0;
          case "lte":
            return compare(current, value) <= 0;
          default:
            return current === value;
        }
      }),
    );
  }

  function indexFilterBuilder(): {
    proxy: IndexFilterBuilder;
    filters: RangeFilter[];
  } {
    const filters: RangeFilter[] = [];
    const proxy: IndexFilterBuilder = {
      eq: (field, value) => {
        filters.push({ field, op: "eq", value });
        return proxy;
      },
      gt: (field, value) => {
        filters.push({ field, op: "gt", value });
        return proxy;
      },
      gte: (field, value) => {
        filters.push({ field, op: "gte", value });
        return proxy;
      },
      lt: (field, value) => {
        filters.push({ field, op: "lt", value });
        return proxy;
      },
      lte: (field, value) => {
        filters.push({ field, op: "lte", value });
        return proxy;
      },
    };
    return { proxy, filters };
  }

  const queryTable = (tableName: TableName): QueryTable => ({
    ...terminalMethods([...tables[tableName]]),
    withIndex: (_indexName, builder) => {
      const { proxy, filters } = indexFilterBuilder();
      builder(proxy);
      return terminalMethods(applyFilters(tableName, filters));
    },
  });

  const db: MockDb = {
    query: (tableName) => queryTable(tableName as TableName),
    insert: vi.fn(async (tableName: string, value: Record<string, unknown>) => {
      const id = `${tableName}:${++idCounter}`;
      tables[tableName as TableName].push({ _id: id, ...clone(value) });
      return id;
    }),
    patch: vi.fn(async (id: string, fields: Record<string, unknown>) => {
      for (const table of Object.values(tables)) {
        const row = table.find((entry) => entry._id === id);
        if (row) {
          Object.assign(row, clone(fields));
          return;
        }
      }
    }),
    delete: vi.fn(async (id: string) => {
      for (const table of Object.values(tables)) {
        const index = table.findIndex((entry) => entry._id === id);
        if (index >= 0) {
          table.splice(index, 1);
          return;
        }
      }
    }),
  };

  return { db, tables };
}

function yUpdate(content: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Y.encodeStateAsUpdateV2(doc);
  const buffer = new ArrayBuffer(update.byteLength);
  new Uint8Array(buffer).set(update);
  doc.destroy();
  return buffer;
}

function seqsOf(rows: Row[]): number[] {
  return rows.map((row) => numericField(row, "seq"));
}

describe("component public API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00Z"));
  });

  it("records live state and trims the delta tail by count", async () => {
    const ctx = createMockCtx();
    const update3 = yUpdate("abc");
    for (const update of [yUpdate("a"), yUpdate("ab"), update3]) {
      await recordUpdateHandler(ctx, {
        collection: "tasks",
        docId: "doc1",
        update,
        keepTailCount: 2,
        tailByteLimit: 1024,
        docCreationTime: 1,
      });
    }

    const liveState = await getLiveStateHandler(ctx, {
      collection: "tasks",
      docId: "doc1",
    });

    expect(liveState).toMatchObject({ seq: 2 });
    expect(new Uint8Array(liveState!.update)).toEqual(new Uint8Array(update3));
    expect(ctx.tables.deltaTail).toHaveLength(2);
    expect(seqsOf(ctx.tables.deltaTail)).toEqual([1, 2]);
  });

  it("returns the latest state for requested and missing doc ids", async () => {
    const ctx = createMockCtx();
    await recordUpdateHandler(ctx, {
      collection: "tasks",
      docId: "doc1",
      update: yUpdate("abc"),
      keepTailCount: 2,
      tailByteLimit: 1024,
      docCreationTime: 1,
    });

    const liveStates = await getLiveStatesHandler(ctx, {
      collection: "tasks",
      docIds: ["doc1", "missing"],
    });
    const allLiveStates = await getLiveStatesHandler(ctx, {
      collection: "tasks",
    });

    expect(liveStates).toEqual([
      expect.objectContaining({ docId: "doc1", seq: 0 }),
      null,
    ]);
    expect(allLiveStates).toEqual([
      expect.objectContaining({ docId: "doc1", seq: 0, docCreationTime: 1 }),
    ]);
  });

  it("trims the delta tail by byte budget", async () => {
    const ctx = createMockCtx();
    const update2 = yUpdate("abcdefgh");
    await recordUpdateHandler(ctx, {
      collection: "tasks",
      docId: "doc2",
      update: yUpdate("abcd"),
      keepTailCount: 10,
      tailByteLimit: update2.byteLength,
      docCreationTime: 2,
    });
    await recordUpdateHandler(ctx, {
      collection: "tasks",
      docId: "doc2",
      update: update2,
      keepTailCount: 10,
      tailByteLimit: update2.byteLength,
      docCreationTime: 2,
    });

    expect(ctx.tables.deltaTail).toHaveLength(1);
    expect(numericField(ctx.tables.deltaTail[0]!, "seq")).toBe(1);
  });

  it("tracks per-document sequence numbers independently across interleaved updates", async () => {
    const ctx = createMockCtx();
    const updates: Array<{ docId: string; content: string; ct: number }> = [
      { docId: "docA", content: "a1", ct: 1 },
      { docId: "docB", content: "b1", ct: 2 },
      { docId: "docA", content: "a2", ct: 1 },
      { docId: "docB", content: "b2", ct: 2 },
      { docId: "docA", content: "a3", ct: 1 },
    ];
    for (const { docId, content, ct } of updates) {
      await recordUpdateHandler(ctx, {
        collection: "tasks",
        docId,
        update: yUpdate(content),
        keepTailCount: 8,
        tailByteLimit: 8192,
        docCreationTime: ct,
      });
    }

    const allLiveStates = await getLiveStatesHandler(ctx, {
      collection: "tasks",
    });
    const tailSeqs = (docId: string): number[] =>
      seqsOf(ctx.tables.deltaTail.filter((entry) => entry.docId === docId));

    expect(allLiveStates).toEqual([
      expect.objectContaining({ docId: "docA", seq: 2 }),
      expect.objectContaining({ docId: "docB", seq: 1 }),
    ]);
    expect(tailSeqs("docA")).toEqual([0, 1, 2]);
    expect(tailSeqs("docB")).toEqual([0, 1]);
  });

  it("keeps a monotonic tail for many updates to the same document", async () => {
    const ctx = createMockCtx();
    for (let index = 0; index < 12; index += 1) {
      await recordUpdateHandler(ctx, {
        collection: "issues",
        docId: "same-doc",
        update: yUpdate(`value-${index}`),
        keepTailCount: 12,
        tailByteLimit: 256 * 1024,
        docCreationTime: 5,
      });
    }

    const liveState = await getLiveStateHandler(ctx, {
      collection: "issues",
      docId: "same-doc",
    });

    expect(liveState).toMatchObject({ seq: 11 });
    expect(seqsOf(ctx.tables.deltaTail)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
  });

  it("falls back to full mode when the collection tail no longer covers the requested sequence", async () => {
    const ctx = createMockCtx();
    for (let index = 0; index < 4; index += 1) {
      await recordUpdateHandler(ctx, {
        collection: "tasks",
        docId: `doc${index}`,
        update: yUpdate(`value-${index}`),
        keepTailCount: 8,
        keepCollectionTailCount: 2,
        tailByteLimit: 8192,
        docCreationTime: index,
      });
    }

    const result = await getCollectionChangesHandler(ctx, {
      collection: "tasks",
      sinceSeq: 0,
    });

    expect(seqsOf(ctx.tables.collectionTail)).toEqual([2, 3]);
    expect(result).toMatchObject({
      mode: "full",
      collectionSeq: 3,
      isGapDetected: true,
    });
    expect(result.changes).toEqual([]);
  });

  it("returns incremental changes when the retained collection tail is contiguous", async () => {
    const ctx = createMockCtx();
    for (let index = 0; index < 4; index += 1) {
      await recordUpdateHandler(ctx, {
        collection: "tasks",
        docId: `doc${index}`,
        update: yUpdate(`value-${index}`),
        keepTailCount: 8,
        keepCollectionTailCount: 2,
        tailByteLimit: 8192,
        docCreationTime: index,
      });
    }

    const result = await getCollectionChangesHandler(ctx, {
      collection: "tasks",
      sinceSeq: 1,
    });

    expect(result).toEqual({
      mode: "incremental",
      collectionSeq: 3,
      isGapDetected: false,
      changes: [
        { docId: "doc2", kind: "upsert" },
        { docId: "doc3", kind: "upsert" },
      ],
    });
  });

  it("includes delete markers in incremental collection changes", async () => {
    const ctx = createMockCtx();
    await recordUpdateHandler(ctx, {
      collection: "tasks",
      docId: "doc1",
      update: yUpdate("value"),
      keepTailCount: 8,
      keepCollectionTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 1,
    });
    await recordDeleteHandler(ctx, {
      collection: "tasks",
      docId: "doc1",
      keepCollectionTailCount: 8,
    });

    const result = await getCollectionChangesHandler(ctx, {
      collection: "tasks",
      sinceSeq: 0,
    });

    expect(result).toEqual({
      mode: "incremental",
      collectionSeq: 1,
      isGapDetected: false,
      changes: [{ docId: "doc1", kind: "delete" }],
    });
  });

  it("pages live states by doc id cursor", async () => {
    const ctx = createMockCtx();
    for (const [index, docId] of ["doc1", "doc2", "doc3"].entries()) {
      await recordUpdateHandler(ctx, {
        collection: "tasks",
        docId,
        update: yUpdate(`value-${index}`),
        keepTailCount: 8,
        tailByteLimit: 8192,
        docCreationTime: index + 1,
      });
    }

    const firstPage = await getLiveStatesPageHandler(ctx, {
      collection: "tasks",
      limit: 2,
    });
    const secondPage = await getLiveStatesPageHandler(ctx, {
      collection: "tasks",
      limit: 2,
      cursor: firstPage.continueCursor,
    });

    expect(firstPage).toMatchObject({
      continueCursor: "doc2",
      isDone: false,
      page: [
        expect.objectContaining({ docId: "doc1", docCreationTime: 1 }),
        expect.objectContaining({ docId: "doc2", docCreationTime: 2 }),
      ],
    });
    expect(secondPage).toMatchObject({
      continueCursor: null,
      isDone: true,
      page: [expect.objectContaining({ docId: "doc3", docCreationTime: 3 })],
    });
  });
});
