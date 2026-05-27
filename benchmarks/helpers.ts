import { rmSync } from "node:fs";

import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import { Database } from "@embedded/runtime/db/database";
import { parseSchema, type SchemaExport } from "@embedded/runtime/db/schema";
import type {
  SerializedQuery,
  SerializedRangeExpression,
} from "@embedded/runtime/db/types";
import {
  createEmbeddedRuntime,
  type EmbeddedRuntime,
} from "@embedded/runtime/embedded";
import { schema as crdtSchema } from "@embedded/server/schema/fields";
import { define, type Definition } from "@embedded/shared/schema";
import { buildUserTableSpecs } from "@embedded/storage/sqlite/factory";
import { temporaryDatabasePath, uniqueSuffix } from "@tests/helpers/storage";
import {
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type GenericDataModel,
} from "convex/server";
import { v, type Value } from "convex/values";

export interface Size {
  readonly label: "small" | "medium" | "large";
  readonly docs: number;
}

const SIZES: readonly Size[] = [
  { label: "small", docs: 1_000 },
  { label: "medium", docs: 10_000 },
  { label: "large", docs: 50_000 },
];

export const sizeByLabel = (label: Size["label"]): Size => {
  const found = SIZES.find((size) => size.label === label);
  if (!found) {
    throw new Error(`unknown size label: ${label}`);
  }
  return found;
};

export interface TaskRow {
  title: string;
  body: string;
  status: string;
  priority: number;
  assignee: string;
}

const STATUSES = ["active", "queued", "done", "blocked"] as const;

export function buildRow(index: number): TaskRow {
  return {
    title: `task-${index}`,
    body:
      index % 2 === 0
        ? `quick brown fox jumps ${index}`
        : `lazy dog sleeps ${index}`,
    status: STATUSES[index % STATUSES.length] ?? "active",
    priority: index % 10,
    assignee: `user-${index % 32}`,
  };
}

export function makeRows(count: number): TaskRow[] {
  return Array.from({ length: count }, (_, index) => buildRow(index));
}

type Cleanup = () => void | Promise<void>;

const cleanups = new Set<Cleanup>();

function track<T extends { close?: () => unknown }>(resource: T): T {
  cleanups.add(async () => {
    await resource.close?.();
  });
  return resource;
}

function trackFile(path: string): void {
  cleanups.add(() => {
    rmSync(path, { force: true });
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
  });
}

export async function closeTrackedResources(): Promise<void> {
  const pending = [...cleanups];
  cleanups.clear();
  for (const cleanup of pending) {
    await cleanup();
  }
}

const tasksSchema = defineSchema({
  tasks: defineTable({
    title: v.string(),
    body: v.string(),
    status: v.string(),
    priority: v.number(),
    assignee: v.string(),
  })
    .index("by_status", ["status"])
    .index("by_assignee", ["assignee"])
    .index("by_priority", ["priority"]),
});

const PARSED_SCHEMA = parseSchema(tasksSchema as unknown as SchemaExport);
const USER_TABLE_SPECS = buildUserTableSpecs(PARSED_SCHEMA);

async function seedDatabase(db: Database, count: number): Promise<void> {
  const rows = makeRows(count);
  const BATCH = 2_000;
  for (let start = 0; start < rows.length; start += BATCH) {
    const end = Math.min(start + BATCH, rows.length);
    db.startTransaction();
    for (let index = start; index < end; index += 1) {
      db.insert("tasks", rows[index] as unknown as Record<string, unknown>);
    }
    await db.commitAsync();
  }
  await db.waitForPersistence();
}

export interface SeededDb {
  readonly db: Database;
  readonly file: string;
}

export async function emptyIndexedDb(
  options: { trackResources?: boolean } = {},
): Promise<SeededDb> {
  const file = temporaryDatabasePath(uniqueSuffix("bench-empty"));
  if (options.trackResources !== false) {
    trackFile(file);
  }

  const storage = await openNodeStorage({
    filename: file,
    userTableSpecs: USER_TABLE_SPECS,
  });
  if (options.trackResources !== false) {
    track(storage);
  }

  const db = new Database(PARSED_SCHEMA);
  db.setStorage(storage);
  await db.hydrate();

  return { db, file };
}

export async function seededSqliteDb(
  size: Size,
  options: { withIndex: boolean },
): Promise<SeededDb> {
  const file = temporaryDatabasePath(uniqueSuffix(`bench-db-${size.label}`));
  trackFile(file);

  const storage = track(
    await openNodeStorage({
      filename: file,
      userTableSpecs: options.withIndex ? USER_TABLE_SPECS : undefined,
    }),
  );

  const db = new Database(options.withIndex ? PARSED_SCHEMA : null);
  db.setStorage(storage);
  await db.hydrate();

  await seedDatabase(db, size.docs);

  return { db, file };
}

export async function unhydratedSqliteDb(file: string): Promise<Database> {
  const storage = track(
    await openNodeStorage({
      filename: file,
      userTableSpecs: USER_TABLE_SPECS,
    }),
  );

  const db = new Database(PARSED_SCHEMA);
  db.setStorage(storage);

  return db;
}

export function indexRangeQuery(
  indexName: string,
  range: SerializedRangeExpression[],
): SerializedQuery {
  return {
    source: { type: "IndexRange", indexName, range, order: "asc" },
    operators: [],
  };
}

export function fullScanQuery(tableName: string): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order: "asc" },
    operators: [
      { filter: { $eq: [{ $field: "status" }, { $literal: "active" }] } },
    ],
  };
}

export function fullScanTakeFilteredQuery(
  tableName: string,
  priority: number,
  limit: number,
): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order: "asc" },
    operators: [
      { filter: { $eq: [{ $field: "priority" }, { $literal: priority }] } },
      { limit },
    ],
  };
}

export function fullScanTakeArithmeticQuery(
  tableName: string,
  limit: number,
): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order: "asc" },
    operators: [
      {
        filter: {
          $eq: [
            { $mod: [{ $field: "priority" }, { $literal: 9 }] },
            { $literal: 7 },
          ],
        },
      },
      { limit },
    ],
  };
}

export function fullScanArithmeticQuery(tableName: string): SerializedQuery {
  return {
    source: { type: "FullTableScan", tableName, order: "asc" },
    operators: [
      {
        filter: {
          $eq: [
            { $mod: [{ $field: "priority" }, { $literal: 9 }] },
            { $literal: 7 },
          ],
        },
      },
    ],
  };
}

export async function drainQueryAsync(
  db: Database,
  query: SerializedQuery,
): Promise<number> {
  const qid = db.startQueryAsync(query);
  let count = 0;
  try {
    for (;;) {
      const next = await db.queryNextAsync(qid);
      if (next.done) {
        return count;
      }
      count += 1;
    }
  } finally {
    db.queryCleanup(qid);
  }
}

type MutationCtx = GenericMutationCtx<GenericDataModel>;
type QueryCtx = GenericQueryCtx<GenericDataModel>;

const insertTask = mutationGeneric({
  handler: async (ctx: MutationCtx, args: { row: Record<string, Value> }) =>
    ctx.db.insert("tasks", args.row),
});

const queryByStatus = queryGeneric({
  handler: async (ctx: QueryCtx, args: { status: string }) =>
    ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect(),
});

const queryByStatusLimit = queryGeneric({
  handler: async (ctx: QueryCtx, args: { status: string; limit: number }) =>
    ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .take(args.limit),
});

const queryFullScan = queryGeneric({
  handler: async (ctx: QueryCtx, args: { status: string }) =>
    ctx.db
      .query("tasks")
      .filter((q) => q.eq(q.field("status"), args.status))
      .collect(),
});

const COMPUTE_MODULES = {
  tasks: () =>
    Promise.resolve({
      insert: insertTask,
      byStatus: queryByStatus,
      byStatusLimit: queryByStatusLimit,
      fullScan: queryFullScan,
    }),
  "_generated/api": () => Promise.resolve({}),
};

export interface SeededRuntime {
  readonly runtime: EmbeddedRuntime;
  readonly file: string;
}

export async function seededSqliteRuntime(size: Size): Promise<SeededRuntime> {
  const file = temporaryDatabasePath(
    uniqueSuffix(`bench-runtime-${size.label}`),
  );
  trackFile(file);

  const storage = await openNodeStorage({ filename: file });
  const runtime = createEmbeddedRuntime({
    convex: { modules: COMPUTE_MODULES },
    schema: tasksSchema,
    storage,
  });
  cleanups.add(async () => {
    await runtime.db.waitForPersistence();
    runtime.shutdown();
  });
  await runtime.hydrate();

  await seedDatabase(runtime.db, size.docs);

  return { runtime, file };
}

export function crdtTaskDefinition(): Definition {
  return define({
    shape: {
      title: crdtSchema.register(v.string()),
      status: crdtSchema.register(v.string()),
      votes: crdtSchema.counter(),
      tags: crdtSchema.set(v.string()),
    },
  });
}

export interface CrdtSeedRow extends Record<string, unknown> {
  _id: string;
  _creationTime: number;
  title: string;
  status: string;
  votes: number;
  tags: string[];
}

export function crdtSeedRow(index: number): CrdtSeedRow {
  return {
    _id: `doc-${index}`,
    _creationTime: index + 1,
    title: `task-${index}`,
    status: STATUSES[index % STATUSES.length] ?? "active",
    votes: index % 5,
    tags: [`tag-${index % 8}`, `tag-${index % 3}`],
  };
}
