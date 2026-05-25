import { getLiveStates, recordUpdate } from "@embedded/component/public";
import { bench, describe } from "@tests/testkit";
import * as Y from "yjs";

type TableName =
  | "collectionHeads"
  | "collectionTail"
  | "liveStates"
  | "deltaTail";

interface MockRow {
  _id: string;
  [key: string]: unknown;
}

type Filter = { kind: "eq" | "gt" | "lt" | "lte"; value: unknown };

interface MockIndexRange {
  eq(field: string, value: unknown): MockIndexRange;
  gt(field: string, value: unknown): MockIndexRange;
  lt(field: string, value: unknown): MockIndexRange;
  lte(field: string, value: unknown): MockIndexRange;
}

interface MockOrdered {
  first(): Promise<MockRow | null>;
  collect(): Promise<MockRow[]>;
  take(count: number): Promise<MockRow[]>;
}

interface MockIndexQuery extends MockOrdered {
  unique(): Promise<MockRow | null>;
  order(direction: "asc" | "desc"): MockOrdered;
}

interface MockQuery {
  withIndex(
    indexName: string,
    builder: (q: MockIndexRange) => MockIndexRange,
  ): MockIndexQuery;
}

interface MockDb {
  query(tableName: string): MockQuery;
  insert(tableName: string, value: Record<string, unknown>): Promise<string>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
}

interface MockCtx {
  db: MockDb;
}

interface RecordUpdateArgs {
  collection: string;
  docId: string;
  update: ArrayBuffer;
  docCreationTime: number;
  keepTailCount: number;
  tailByteLimit: number;
}

interface GetLiveStatesArgs {
  collection: string;
  docIds: string[];
}

interface WithHandler<Args> {
  _handler: (ctx: MockCtx, args: Args) => Promise<unknown>;
}

const recordUpdateHandler = (
  recordUpdate as unknown as WithHandler<RecordUpdateArgs>
)._handler;
const getLiveStatesHandler = (
  getLiveStates as unknown as WithHandler<GetLiveStatesArgs>
)._handler;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matches(cell: unknown, filter: Filter): boolean {
  switch (filter.kind) {
    case "eq":
      return cell === filter.value;
    case "gt":
      return Number(cell) > Number(filter.value);
    case "lt":
      return Number(cell) < Number(filter.value);
    case "lte":
      return Number(cell) <= Number(filter.value);
  }
}

function createMockCtx(): {
  ctx: MockCtx;
  tables: Record<TableName, MockRow[]>;
} {
  const tables: Record<TableName, MockRow[]> = {
    collectionHeads: [],
    collectionTail: [],
    liveStates: [],
    deltaTail: [],
  };
  let idCounter = 0;

  const queryTable = (tableName: TableName): MockQuery => ({
    withIndex(indexName, builder) {
      const filters: Record<string, Filter> = {};
      const range: MockIndexRange = {
        eq(field, value) {
          filters[field] = { kind: "eq", value };
          return range;
        },
        gt(field, value) {
          filters[field] = { kind: "gt", value };
          return range;
        },
        lt(field, value) {
          filters[field] = { kind: "lt", value };
          return range;
        },
        lte(field, value) {
          filters[field] = { kind: "lte", value };
          return range;
        },
      };
      builder(range);

      const rows = tables[tableName].filter((row) =>
        Object.entries(filters).every(([key, filter]) =>
          matches(row[key], filter),
        ),
      );

      const orderField = indexName.endsWith("updatedAt") ? "updatedAt" : "seq";
      const sorted = (direction: "asc" | "desc"): MockRow[] =>
        [...rows].sort((a, b) => {
          const av = Number(a[orderField] ?? 0);
          const bv = Number(b[orderField] ?? 0);
          return direction === "desc" ? bv - av : av - bv;
        });
      const orderedView = (direction: "asc" | "desc"): MockOrdered => {
        const ordered = sorted(direction);
        return {
          first: async () => clone(ordered[0] ?? null),
          collect: async () => clone(ordered),
          take: async (count) => clone(ordered.slice(0, count)),
        };
      };
      const ascending = orderedView("asc");
      return {
        unique: async () => clone(rows[0] ?? null),
        order: orderedView,
        first: () => ascending.first(),
        collect: () => ascending.collect(),
        take: (count: number) => ascending.take(count),
      };
    },
  });

  const db: MockDb = {
    query: (tableName) => queryTable(tableName as TableName),
    insert: async (tableName, value) => {
      const id = `${tableName}:${++idCounter}`;
      tables[tableName as TableName].push({ _id: id, ...clone(value) });
      return id;
    },
    patch: async (id, fields) => {
      for (const table of Object.values(tables)) {
        const row = table.find((entry) => entry._id === id);
        if (row) {
          Object.assign(row, clone(fields));
          return;
        }
      }
    },
    delete: async (id) => {
      for (const table of Object.values(tables)) {
        const index = table.findIndex((entry) => entry._id === id);
        if (index >= 0) {
          table.splice(index, 1);
          return;
        }
      }
    },
  };

  return { ctx: { db }, tables };
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

const COLLECTION = "issues";

async function record(
  ctx: MockCtx,
  docId: string,
  content: string,
  options: {
    keepTailCount: number;
    tailByteLimit: number;
    creationTime: number;
  },
): Promise<void> {
  await recordUpdateHandler(ctx, {
    collection: COLLECTION,
    docId,
    update: yUpdate(content),
    docCreationTime: options.creationTime,
    keepTailCount: options.keepTailCount,
    tailByteLimit: options.tailByteLimit,
  });
}

const DEFAULT_TAIL = { keepTailCount: 64, tailByteLimit: 256 * 1024 };
const LARGE_TAIL = { keepTailCount: 1_000, tailByteLimit: 2 * 1024 * 1024 };

let hotCtx: MockCtx;
let hotSeq = 0;
let manyDocsCtx: MockCtx;
let manyDocsSeq = 0;
let liveStatesCtx: MockCtx;
let liveStateIds: string[] = [];

describe("component storage", () => {
  bench(
    "recordUpdate fresh doc (single delta append)",
    async () => {
      hotSeq += 1;
      await record(createMockCtx().ctx, `doc-${hotSeq}`, `content-${hotSeq}`, {
        ...DEFAULT_TAIL,
        creationTime: 1,
      });
    },
    { time: 1_000 },
  );

  bench(
    "recordUpdate hot doc with 1000-deep retained tail",
    async () => {
      hotSeq += 1;
      await record(hotCtx, "doc-hot", `hot-${hotSeq}`, {
        ...LARGE_TAIL,
        creationTime: 1,
      });
    },
    {
      setup: async () => {
        const created = createMockCtx();
        hotCtx = created.ctx;
        for (let index = 0; index < 1_000; index += 1) {
          await record(hotCtx, "doc-hot", `seed-${index}`, {
            ...LARGE_TAIL,
            creationTime: 1,
          });
        }
      },
    },
  );

  bench(
    "recordUpdate across 10k-doc collection",
    async () => {
      manyDocsSeq += 1;
      await record(
        manyDocsCtx,
        `doc-${manyDocsSeq % 10_000}`,
        `update-${manyDocsSeq}`,
        { ...DEFAULT_TAIL, creationTime: manyDocsSeq % 10_000 },
      );
    },
    {
      setup: async () => {
        const created = createMockCtx();
        manyDocsCtx = created.ctx;
        for (let index = 0; index < 10_000; index += 1) {
          await record(manyDocsCtx, `doc-${index}`, `seed-${index}`, {
            ...DEFAULT_TAIL,
            creationTime: index,
          });
        }
      },
    },
  );

  bench(
    "getLiveStates 1000 docs",
    async () => {
      await getLiveStatesHandler(liveStatesCtx, {
        collection: COLLECTION,
        docIds: liveStateIds,
      });
    },
    {
      setup: async () => {
        const created = createMockCtx();
        liveStatesCtx = created.ctx;
        liveStateIds = Array.from(
          { length: 1_000 },
          (_, index) => `doc-${index}`,
        );
        await Promise.all(
          liveStateIds.map((docId, index) =>
            record(liveStatesCtx, docId, `seed-${index}`, {
              ...DEFAULT_TAIL,
              creationTime: index,
            }),
          ),
        );
      },
    },
  );
});
