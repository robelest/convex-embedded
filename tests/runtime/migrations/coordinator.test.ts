import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import type { AsyncReadBackend } from "@embedded/runtime/db/backend";
import type { Source, StoredDocument } from "@embedded/runtime/db/types";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { runLocalMigrations } from "@embedded/runtime/migrations/coordinator";
import type { PendingReplayMeta } from "@embedded/shared/symbols";
import { mockAdapter } from "@tests/helpers/adapter";
import { describe, expect, it, vi } from "@tests/testkit";

const STUB_MODULES: ConvexModuleRegistry = {
  "_generated/api": () => Promise.resolve({}),
};

function sourceTableName(source: Source): string {
  if (source.type === "FullTableScan") return source.tableName;
  return source.indexName.split(".")[0] ?? source.indexName;
}

function createSqlStorage(rowsByTable: Record<string, StoredDocument[]>) {
  const readSource = vi.fn(
    async (source: Source): Promise<StoredDocument[] | null> => {
      const tableName = sourceTableName(source);
      let rows = [...(rowsByTable[tableName] ?? [])];
      if (source.type === "IndexRange") {
        rows = rows.filter((row) =>
          source.range.every(
            (entry) =>
              entry.type !== "Eq" || row[entry.fieldPath] === entry.value,
          ),
        );
      }
      return rows;
    },
  );

  const adapter = mockAdapter({
    getDocuments: async (table) =>
      table === undefined
        ? Object.entries(rowsByTable).flatMap(([tableName, docs]) =>
            docs.map((doc) => ({ tableName, doc })),
          )
        : [...(rowsByTable[table] ?? [])],
    getDocument: async () => null,
    getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
    countDocuments: async () => 0,
    source: readSource,
    query: async () => null,
    vectorSearch: async () => null,
    write: async (batch) => {
      for (const put of batch.puts) {
        const tableRows = rowsByTable[put.tableName] ?? [];
        rowsByTable[put.tableName] = [
          ...tableRows.filter((row) => row._id !== put.doc._id),
          put.doc,
        ];
      }
      for (const deletion of batch.deletes) {
        rowsByTable[deletion.tableName] = (
          rowsByTable[deletion.tableName] ?? []
        ).filter((row) => row._id !== deletion.id);
      }
    },
    storeBlob: async () => undefined,
    deleteBlob: async () => undefined,
    clearAll: async () => undefined,
  });
  return { adapter, readSource };
}

describe("runLocalMigrations", () => {
  it("migrates only the active identity's pending entries", async ({
    track,
  }) => {
    const { adapter: storage } = createSqlStorage({
      _resolve_pending: [
        pendingRow("pending-a", 1, "user:a", { title: "a" }),
        pendingRow("pending-b", 2, "user:b", { title: "b" }),
      ],
    });
    const runtime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      storage,
    });
    track({ close: () => runtime.shutdown() });
    runtime.db.setReadBackendForTests(storage as unknown as AsyncReadBackend);

    const replayMetadata = new Map<string, PendingReplayMeta>([
      [
        "tasks:create",
        {
          __brand: "convex-embedded:pendingReplayMeta",
          version: 2,
          migrate: {
            2: ({ args, localResult }) => ({
              args: { ...args, migrated: true },
              localResult,
            }),
          },
        },
      ],
    ]);

    await runtime.hydrate();
    await runLocalMigrations(runtime, {
      identityKey: "user:a",
      storeManifests: [],
      tableDefinitions: new Map(),
      replayMetadata,
    });

    const pendingRows = (
      await runtime.db.listDocumentsAsync("_resolve_pending")
    ).sort((left, right) => String(left._id).localeCompare(String(right._id)));

    expect(pendingRows).toEqual([
      expect.objectContaining({
        _id: "pending-a",
        identityKey: "user:a",
        payloadVersion: 2,
        args: JSON.stringify({ title: "a", migrated: true }),
      }),
      expect.objectContaining({
        _id: "pending-b",
        identityKey: "user:b",
        payloadVersion: 1,
        args: JSON.stringify({ title: "b" }),
      }),
    ]);
  });
});

function pendingRow(
  id: string,
  creationTime: number,
  identityKey: string,
  args: Record<string, unknown>,
): StoredDocument {
  return {
    _id: id as StoredDocument["_id"],
    _creationTime: creationTime,
    ref: "tasks:create",
    args: JSON.stringify(args),
    localResult: JSON.stringify({ ok: true }),
    table: "tasks",
    payloadVersion: 1,
    identityKey,
    state: "pending",
  };
}
