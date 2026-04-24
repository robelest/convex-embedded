import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { runLocalMigrations } from "@embedded/runtime/migrations/coordinator";
import type { PendingReplayMeta } from "@embedded/shared/symbols";
import { mockAdapter } from "@tests/helpers/test-adapter";
import { describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

const STUB_MODULES: Record<string, () => Promise<any>> = {
  "_generated/api": () => Promise.resolve({}),
};

function createSqlPersistence(
  rowsByTable: Record<string, Array<Record<string, unknown>>>,
) {
  const getDocumentsByTable = vi.fn(async (tableName: string) => [
    ...(rowsByTable[tableName] ?? []),
  ]);
  const listDocuments = vi.fn(async (tableName: string) => [
    ...(rowsByTable[tableName] ?? []),
  ]);
  const readSource = vi.fn(async (source: any) => {
    const tableName =
      source.type === "FullTableScan"
        ? source.tableName
        : String(source.indexName).split(".")[0];
    let rows = [...(rowsByTable[tableName] ?? [])];
    if (source.type === "IndexRange") {
      rows = rows.filter((row) =>
        source.range.every(
          (entry: any) =>
            entry.type !== "Eq" || row[entry.fieldPath] === entry.value,
        ),
      );
    }
    return rows;
  });

  const adapter = mockAdapter({
    listAll: async () =>
      Object.entries(rowsByTable).flatMap(([tableName, docs]) =>
        docs.map((doc) => ({ tableName, doc })),
      ),
    list: listDocuments,
    get: vi.fn(async () => null),
    meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
    listBlobs: async () => [],
    count: vi.fn(async () => 0),
    source: readSource,
    query: vi.fn(async () => null),
    vectorSearch: vi.fn(async () => null),
    commit: vi.fn(async (batch) => {
      for (const put of batch.puts) {
        const tableRows = rowsByTable[put.tableName] ?? [];
        const next = tableRows.filter((row) => row._id !== put.doc._id);
        next.push(put.doc);
        rowsByTable[put.tableName] = next;
      }
      for (const deletion of batch.deletes) {
        rowsByTable[deletion.tableName] = (
          rowsByTable[deletion.tableName] ?? []
        ).filter((row) => row._id !== deletion.id);
      }
    }),
    putBlob: async () => undefined,
    deleteBlob: async () => undefined,
    clear: async () => undefined,
  });
  return { adapter, readSource };
}

describe("runLocalMigrations", () => {
  it("migrates only pending entries for the active identity via indexed reads", async () => {
    const { adapter: persistence, readSource } = createSqlPersistence({
      _resolve_pending: [
        {
          _id: "pending-a",
          _creationTime: 1,
          ref: "tasks:create",
          args: JSON.stringify({ title: "a" }),
          localResult: JSON.stringify({ ok: true }),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:a",
          state: "pending",
        },
        {
          _id: "pending-b",
          _creationTime: 2,
          ref: "tasks:create",
          args: JSON.stringify({ title: "b" }),
          localResult: JSON.stringify({ ok: true }),
          table: "tasks",
          payloadVersion: 1,
          identityKey: "user:b",
          state: "pending",
        },
      ],
    });
    const runtime = new EmbeddedRuntime({
      convex: { modules: STUB_MODULES },
      persistence,
    });
    runtime.db.setReadBackendForTests(persistence);

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

    try {
      await runtime.hydrate();

      await runLocalMigrations(runtime, {
        identityKey: "user:a",
        storeManifests: [],
        tableDefinitions: new Map(),
        replayMetadata,
      });

      expect(readSource).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "IndexRange",
          indexName: "_resolve_pending.by_identity_key_and_creation_time",
        }),
        expect.anything(),
      );

      const pendingRows = (
        await runtime.db.listDocumentsAsync("_resolve_pending")
      ).sort((left, right) =>
        String(left._id).localeCompare(String(right._id)),
      );

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
    } finally {
      runtime.shutdown();
    }
  });
});
