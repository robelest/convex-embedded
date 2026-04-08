import { bench, describe } from "vite-plus/test";
import * as Y from "yjs";

import {
  cleanupDoc,
  createCheckpoint,
  getLiveStates,
  recordUpdate,
} from "../../packages/convex-embedded/src/component/public";

const recordUpdateHandler = (recordUpdate as any)._handler as Function;
const getLiveStatesHandler = (getLiveStates as any)._handler as Function;
const createCheckpointHandler = (createCheckpoint as any)._handler as Function;
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

      return {
        unique: async () => clone(rows[0] ?? null),
        order: (direction: "asc" | "desc") => {
          const orderField = indexName.endsWith("createdAt")
            ? "createdAt"
            : "seq";
          const ordered = [...rows].sort((a, b) =>
            direction === "desc"
              ? (b[orderField] ?? 0) - (a[orderField] ?? 0)
              : (a[orderField] ?? 0) - (b[orderField] ?? 0),
          );
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
      insert: async (tableName: string, value: Record<string, unknown>) => {
        const id = `${tableName}:${++idCounter}`;
        tables[tableName as TableName].push({ _id: id, ...clone(value) });
        return id;
      },
      patch: async (id: string, fields: Record<string, unknown>) => {
        for (const table of Object.values(tables)) {
          const row = table.find((entry) => entry._id === id);
          if (row) {
            Object.assign(row, clone(fields));
            return;
          }
        }
      },
      delete: async (id: string) => {
        for (const table of Object.values(tables)) {
          const index = table.findIndex((entry) => entry._id === id);
          if (index >= 0) {
            table.splice(index, 1);
            return;
          }
        }
      },
      get: async (id: string) => {
        for (const table of Object.values(tables)) {
          const row = table.find((entry) => entry._id === id);
          if (row) {
            return clone(row);
          }
        }
        return null;
      },
      normalizeId: (tableName: string, id: string) =>
        id.startsWith(`${tableName}:`) ? id : null,
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

async function seedDocumentHistory(input: {
  ctx: ReturnType<typeof createMockCtx>;
  docId: string;
  updates: number;
  checkpointsEvery?: number;
}) {
  for (let index = 0; index < input.updates; index += 1) {
    await recordUpdateHandler(input.ctx as any, {
      collection: "issues",
      docId: input.docId,
      update: yUpdate(`value-${index}`),
      keepTailCount: 64,
      tailByteLimit: 256 * 1024,
    });
    if (
      input.checkpointsEvery &&
      index > 0 &&
      index % input.checkpointsEvery === 0
    ) {
      await createCheckpointHandler(input.ctx as any, {
        collection: "issues",
        docId: input.docId,
        label: `checkpoint-${index}`,
        keepCheckpointCount: 10,
      });
    }
  }
}

describe("component storage", () => {
  bench("recordUpdate single document x1000", async () => {
    const ctx = createMockCtx();
    for (let index = 0; index < 1_000; index += 1) {
      await recordUpdateHandler(ctx as any, {
        collection: "issues",
        docId: "doc-1",
        update: yUpdate(`content-${index}`),
        keepTailCount: 64,
        tailByteLimit: 256 * 1024,
      });
    }
  });

  bench("recordUpdate 100 docs x20 updates", async () => {
    const ctx = createMockCtx();
    for (let doc = 0; doc < 100; doc += 1) {
      for (let index = 0; index < 20; index += 1) {
        await recordUpdateHandler(ctx as any, {
          collection: "issues",
          docId: `doc-${doc}`,
          update: yUpdate(`doc-${doc}-${index}`),
          keepTailCount: 64,
          tailByteLimit: 256 * 1024,
        });
      }
    }
  });

  bench("getLiveStates 500 docs", async () => {
    const ctx = createMockCtx();
    await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        recordUpdateHandler(ctx as any, {
          collection: "issues",
          docId: `doc-${index}`,
          update: yUpdate(`seed-${index}`),
          keepTailCount: 64,
          tailByteLimit: 256 * 1024,
        }),
      ),
    );

    await getLiveStatesHandler(ctx as any, {
      collection: "issues",
      docIds: Array.from({ length: 500 }, (_, index) => `doc-${index}`),
    });
  });

  bench("cleanupDoc after long history with checkpoints", async () => {
    const ctx = createMockCtx();
    await seedDocumentHistory({
      ctx,
      docId: "doc-cleanup",
      updates: 1_000,
      checkpointsEvery: 50,
    });

    await cleanupDocHandler(ctx as any, {
      collection: "issues",
      docId: "doc-cleanup",
      keepTailCount: 32,
      tailByteLimit: 128 * 1024,
      keepCheckpointCount: 5,
    });
  });
});
