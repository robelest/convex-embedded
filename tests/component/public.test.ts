import {
  getCollectionChanges,
  getLiveState,
  getLiveStates,
  getLiveStatesPage,
  recordDelete,
  recordUpdate,
} from "@resolve/component/public";
import { beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";
import * as Y from "yjs";

const recordUpdateHandler = (recordUpdate as any)._handler as Function;
const recordDeleteHandler = (recordDelete as any)._handler as Function;
const getCollectionChangesHandler = (getCollectionChanges as any)
  ._handler as Function;
const getLiveStateHandler = (getLiveState as any)._handler as Function;
const getLiveStatesHandler = (getLiveStates as any)._handler as Function;
const getLiveStatesPageHandler = (getLiveStatesPage as any)
  ._handler as Function;

type TableName =
  | "collectionHeads"
  | "collectionTail"
  | "liveStates"
  | "deltaTail";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createMockCtx() {
  const tables: Record<TableName, Array<any>> = {
    collectionHeads: [],
    collectionTail: [],
    liveStates: [],
    deltaTail: [],
  };
  let idCounter = 0;

  const queryTable = (tableName: TableName) => ({
    withIndex: (indexName: string, builder: (q: any) => any) => {
      const filters: Record<string, unknown> = {};
      builder({
        eq: (field: string, value: unknown) => {
          filters[field] = value;
          return {
            eq: (nextField: string, nextValue: unknown) => {
              filters[nextField] = nextValue;
              return {
                gt: (gtField: string, gtValue: unknown) => {
                  filters[gtField] = { $gt: gtValue };
                  return undefined;
                },
              };
            },
            gt: (nextField: string, nextValue: unknown) => {
              filters[nextField] = { $gt: nextValue };
              return undefined;
            },
          };
        },
      });

      const rows = tables[tableName].filter((row) =>
        Object.entries(filters).every(([key, value]) => {
          const currentRow = row as Record<string, any>;
          if (
            value &&
            typeof value === "object" &&
            "$gt" in (value as Record<string, unknown>)
          ) {
            return currentRow[key] > (value as { $gt: any }).$gt;
          }
          return currentRow[key] === value;
        }),
      );

      return {
        unique: async () => {
          if (rows.length > 1) {
            throw new Error(`Expected unique result for ${tableName}`);
          }
          return clone(rows[0] ?? null);
        },
        collect: async () => clone(rows),
        take: async (count: number) => clone(rows.slice(0, count)),
        order: (direction: "asc" | "desc") => {
          const ordered = [...rows].sort((a, b) => {
            const orderField = indexName.endsWith("updatedAt")
              ? "updatedAt"
              : "seq";
            const aOrder = a[orderField] ?? 0;
            const bOrder = b[orderField] ?? 0;
            return direction === "desc" ? bOrder - aOrder : aOrder - bOrder;
          });

          return {
            first: async () => clone(ordered[0] ?? null),
            collect: async () => clone(ordered),
          };
        },
      };
    },
  });

  return {
    db: {
      query: (tableName: string) => queryTable(tableName as TableName),
      insert: vi.fn(
        async (tableName: string, value: Record<string, unknown>) => {
          const id = `${tableName}:${++idCounter}`;
          tables[tableName as TableName].push({ _id: id, ...clone(value) });
          return id;
        },
      ),
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
    },
    tables,
  };
}

function yUpdate(content: string) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  const update = Y.encodeStateAsUpdateV2(doc);
  const buffer = new ArrayBuffer(update.byteLength);
  new Uint8Array(buffer).set(update);
  doc.destroy();
  return buffer;
}

describe("component public API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00Z"));
  });

  it("records live state and trims delta tail by count", async () => {
    const ctx = createMockCtx();

    const update1 = yUpdate("a");
    const update2 = yUpdate("ab");
    const update3 = yUpdate("abc");

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      update: update1,
      keepTailCount: 2,
      tailByteLimit: 1024,
      docCreationTime: 1,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      update: update2,
      keepTailCount: 2,
      tailByteLimit: 1024,
      docCreationTime: 1,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      update: update3,
      keepTailCount: 2,
      tailByteLimit: 1024,
      docCreationTime: 1,
    });

    const liveState = await getLiveStateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
    });
    const liveStates = await getLiveStatesHandler(ctx as any, {
      collection: "tasks",
      docIds: ["doc1", "missing"],
    });
    const allLiveStates = await getLiveStatesHandler(ctx as any, {
      collection: "tasks",
    });

    expect(liveState).toMatchObject({ seq: 2 });
    expect(new Uint8Array(liveState!.update)).toEqual(new Uint8Array(update3));
    expect(liveStates).toEqual([
      expect.objectContaining({ docId: "doc1", seq: 2 }),
      null,
    ]);
    expect(allLiveStates).toEqual([
      expect.objectContaining({ docId: "doc1", seq: 2, docCreationTime: 1 }),
    ]);
    expect(ctx.tables.deltaTail).toHaveLength(2);
    expect(ctx.tables.deltaTail.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("trims delta tail by byte budget", async () => {
    const ctx = createMockCtx();

    const update1 = yUpdate("abcd");
    const update2 = yUpdate("abcdefgh");

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc2",
      update: update1,
      keepTailCount: 10,
      tailByteLimit: update2.byteLength,
      docCreationTime: 2,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc2",
      update: update2,
      keepTailCount: 10,
      tailByteLimit: update2.byteLength,
      docCreationTime: 2,
    });

    expect(ctx.tables.deltaTail).toHaveLength(1);
    expect(ctx.tables.deltaTail[0].seq).toBe(1);
  });

  it("tracks per-document sequence numbers independently across interleaved updates", async () => {
    const ctx = createMockCtx();

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "docA",
      update: yUpdate("a1"),
      keepTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 1,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "docB",
      update: yUpdate("b1"),
      keepTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 2,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "docA",
      update: yUpdate("a2"),
      keepTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 1,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "docB",
      update: yUpdate("b2"),
      keepTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 2,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "docA",
      update: yUpdate("a3"),
      keepTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 1,
    });

    const allLiveStates = await getLiveStatesHandler(ctx as any, {
      collection: "tasks",
    });
    const docATail = ctx.tables.deltaTail
      .filter((entry) => entry.docId === "docA")
      .map((entry) => entry.seq);
    const docBTail = ctx.tables.deltaTail
      .filter((entry) => entry.docId === "docB")
      .map((entry) => entry.seq);

    expect(allLiveStates).toEqual([
      expect.objectContaining({ docId: "docA", seq: 2 }),
      expect.objectContaining({ docId: "docB", seq: 1 }),
    ]);
    expect(docATail).toEqual([0, 1, 2]);
    expect(docBTail).toEqual([0, 1]);
  });

  it("keeps a monotonic tail for many updates to the same document", async () => {
    const ctx = createMockCtx();

    for (let index = 0; index < 12; index += 1) {
      await recordUpdateHandler(ctx as any, {
        collection: "issues",
        docId: "same-doc",
        update: yUpdate(`value-${index}`),
        keepTailCount: 12,
        tailByteLimit: 256 * 1024,
        docCreationTime: 5,
      });
    }

    const liveState = await getLiveStateHandler(ctx as any, {
      collection: "issues",
      docId: "same-doc",
    });

    expect(liveState).toMatchObject({ seq: 11 });
    expect(ctx.tables.deltaTail.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
  });

  it("falls back to full mode when collection tail no longer covers the requested sequence", async () => {
    const ctx = createMockCtx();

    for (let index = 0; index < 4; index += 1) {
      await recordUpdateHandler(ctx as any, {
        collection: "tasks",
        docId: `doc${index}`,
        update: yUpdate(`value-${index}`),
        keepTailCount: 8,
        keepCollectionTailCount: 2,
        tailByteLimit: 8192,
        docCreationTime: index,
      });
    }

    const result = await getCollectionChangesHandler(ctx as any, {
      collection: "tasks",
      sinceSeq: 0,
    });

    expect(ctx.tables.collectionTail.map((entry) => entry.seq)).toEqual([2, 3]);
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
      await recordUpdateHandler(ctx as any, {
        collection: "tasks",
        docId: `doc${index}`,
        update: yUpdate(`value-${index}`),
        keepTailCount: 8,
        keepCollectionTailCount: 2,
        tailByteLimit: 8192,
        docCreationTime: index,
      });
    }

    const result = await getCollectionChangesHandler(ctx as any, {
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

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      update: yUpdate("value"),
      keepTailCount: 8,
      keepCollectionTailCount: 8,
      tailByteLimit: 8192,
      docCreationTime: 1,
    });
    await recordDeleteHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      keepCollectionTailCount: 8,
    });

    const result = await getCollectionChangesHandler(ctx as any, {
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
      await recordUpdateHandler(ctx as any, {
        collection: "tasks",
        docId,
        update: yUpdate(`value-${index}`),
        keepTailCount: 8,
        tailByteLimit: 8192,
        docCreationTime: index + 1,
      });
    }

    const firstPage = await getLiveStatesPageHandler(ctx as any, {
      collection: "tasks",
      limit: 2,
    });
    const secondPage = await getLiveStatesPageHandler(ctx as any, {
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
