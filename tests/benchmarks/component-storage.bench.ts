import { bench, describe } from "@tests/testkit";
import * as Y from "yjs";

import {
  getLiveStates,
  recordUpdate,
} from "../../packages/convex-embedded/src/component/public";

const recordUpdateHandler = (recordUpdate as any)._handler as Function;
const getLiveStatesHandler = (getLiveStates as any)._handler as Function;

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
        unique: async () => clone(rows[0] ?? null),
        order: (direction: "asc" | "desc") => {
          const orderField = indexName.endsWith("updatedAt")
            ? "updatedAt"
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

describe("component storage", () => {
  bench("recordUpdate single document x1000", async () => {
    const ctx = createMockCtx();
    for (let index = 0; index < 1_000; index += 1) {
      await recordUpdateHandler(ctx as any, {
        collection: "issues",
        docId: "doc-1",
        update: yUpdate(`content-${index}`),
        docCreationTime: 1,
        keepTailCount: 64,
        tailByteLimit: 256 * 1024,
      });
    }
  });

  bench("recordUpdate same document x1000 with large retained tail", async () => {
    const ctx = createMockCtx();
    for (let index = 0; index < 1_000; index += 1) {
      await recordUpdateHandler(ctx as any, {
        collection: "issues",
        docId: "doc-hot",
        update: yUpdate(`hot-${index}`),
        docCreationTime: 1,
        keepTailCount: 1_000,
        tailByteLimit: 2 * 1024 * 1024,
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
          docCreationTime: doc,
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
          docCreationTime: index,
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
});
