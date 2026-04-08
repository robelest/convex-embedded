import {
  cleanupDoc,
  createCheckpoint,
  getCheckpoint,
  getLiveState,
  getLiveStates,
  listCheckpoints,
  recordUpdate,
} from "@resolve/component/public";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";

const recordUpdateHandler = (recordUpdate as any)._handler as Function;
const getLiveStateHandler = (getLiveState as any)._handler as Function;
const getLiveStatesHandler = (getLiveStates as any)._handler as Function;
const createCheckpointHandler = (createCheckpoint as any)._handler as Function;
const listCheckpointsHandler = (listCheckpoints as any)._handler as Function;
const getCheckpointHandler = (getCheckpoint as any)._handler as Function;
const cleanupDocHandler = (cleanupDoc as any)._handler as Function;

type TableName =
  | "liveStates"
  | "deltaTail"
  | "checkpoints"
  | "pinnedCheckpoints";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createMockCtx() {
  const tables: Record<TableName, Array<any>> = {
    liveStates: [],
    deltaTail: [],
    checkpoints: [],
    pinnedCheckpoints: [],
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
              return undefined;
            },
          };
        },
      });

      const rows = tables[tableName].filter((row) =>
        Object.entries(filters).every(([key, value]) => row[key] === value),
      );

      const query = {
        unique: async () => {
          if (rows.length > 1) {
            throw new Error(`Expected unique result for ${tableName}`);
          }
          return clone(rows[0] ?? null);
        },
        collect: async () => clone(rows),
        order: (direction: "asc" | "desc") => {
          const ordered = [...rows].sort((a, b) => {
            const orderField = indexName.endsWith("createdAt")
              ? "createdAt"
              : indexName.endsWith("updatedAt")
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

      return query;
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
      get: vi.fn(async (id: string) => {
        for (const table of Object.values(tables)) {
          const row = table.find((entry) => entry._id === id);
          if (row) return clone(row);
        }
        return null;
      }),
      normalizeId: vi.fn((tableName: string, id: string) =>
        id.startsWith(`${tableName}:`) ? id : null,
      ),
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
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      update: update2,
      keepTailCount: 2,
      tailByteLimit: 1024,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc1",
      update: update3,
      keepTailCount: 2,
      tailByteLimit: 1024,
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
      expect.objectContaining({ docId: "doc1", seq: 2 }),
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
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc2",
      update: update2,
      keepTailCount: 10,
      tailByteLimit: update2.byteLength,
    });

    expect(ctx.tables.deltaTail).toHaveLength(1);
    expect(ctx.tables.deltaTail[0].seq).toBe(1);
  });

  it("keeps pinned checkpoints and the latest unpinned N", async () => {
    const ctx = createMockCtx();

    const update1 = yUpdate("v1");
    const update2 = yUpdate("v2");
    const update3 = yUpdate("v3");
    const update4 = yUpdate("v4");

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      update: update1,
      keepTailCount: 10,
      tailByteLimit: 1024,
    });

    const first = await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      label: "first",
      pinned: true,
      keepCheckpointCount: 2,
    });
    vi.advanceTimersByTime(1);

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      update: update2,
      keepTailCount: 10,
      tailByteLimit: 1024,
    });
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      label: "second",
      keepCheckpointCount: 2,
    });
    vi.advanceTimersByTime(1);

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      update: update3,
      keepTailCount: 10,
      tailByteLimit: 1024,
    });
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      label: "third",
      keepCheckpointCount: 2,
    });
    vi.advanceTimersByTime(1);

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      update: update4,
      keepTailCount: 10,
      tailByteLimit: 1024,
    });
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      label: "fourth",
      keepCheckpointCount: 2,
    });

    const checkpoints = await listCheckpointsHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
    });
    const checkpoint = await getCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc3",
      checkpointId: first.checkpointId,
    });

    expect(checkpoints.map((entry: any) => entry.label)).toEqual([
      "fourth",
      "third",
      "first",
    ]);
    expect(checkpoint).toMatchObject({ label: "first", pinned: true, seq: 0 });
    expect(ctx.tables.checkpoints.map((entry) => entry.label)).toEqual([
      "third",
      "fourth",
    ]);
    expect(ctx.tables.pinnedCheckpoints.map((entry) => entry.label)).toEqual([
      "first",
    ]);
  });

  it("does not trim checkpoints during recordUpdate", async () => {
    const ctx = createMockCtx();

    const update1 = yUpdate("draft");
    const update2 = yUpdate("draft v2");

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc-inline",
      update: update1,
      keepTailCount: 10,
      tailByteLimit: 1024,
    });
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc-inline",
      label: "first",
      keepCheckpointCount: 1,
    });
    vi.advanceTimersByTime(1);
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc-inline",
      label: "second",
      keepCheckpointCount: 10,
    });

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc-inline",
      update: update2,
      keepTailCount: 10,
      tailByteLimit: 1024,
    });

    expect(ctx.tables.checkpoints.map((entry) => entry.label)).toEqual([
      "first",
      "second",
    ]);
  });

  it("cleanupDoc prunes tail and unpinned checkpoints", async () => {
    const ctx = createMockCtx();

    const update1 = yUpdate("x");
    const update2 = yUpdate("xy");
    const update3 = yUpdate("xyz");

    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      update: update1,
      keepTailCount: 5,
      tailByteLimit: 1024,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      update: update2,
      keepTailCount: 5,
      tailByteLimit: 1024,
    });
    await recordUpdateHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      update: update3,
      keepTailCount: 5,
      tailByteLimit: 1024,
    });

    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      label: "keep-me",
      pinned: true,
      keepCheckpointCount: 10,
    });
    vi.advanceTimersByTime(1);
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      label: "drop-me",
      keepCheckpointCount: 10,
    });
    vi.advanceTimersByTime(1);
    await createCheckpointHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      label: "keep-latest",
      keepCheckpointCount: 10,
    });

    const result = await cleanupDocHandler(ctx as any, {
      collection: "tasks",
      docId: "doc4",
      keepTailCount: 1,
      tailByteLimit: update3.byteLength,
      keepCheckpointCount: 1,
    });

    expect(result).toEqual({
      tailDeleted: 2,
      tailKept: 1,
      checkpointDeleted: 1,
      checkpointKept: 2,
    });
    expect(ctx.tables.deltaTail).toHaveLength(1);
    expect(
      ctx.tables.checkpoints
        .map((entry: any) => entry.label)
        .sort((left: string, right: string) => left.localeCompare(right)),
    ).toEqual(["keep-latest"]);
    expect(
      ctx.tables.pinnedCheckpoints.map((entry: any) => entry.label),
    ).toEqual(["keep-me"]);
  });
});
