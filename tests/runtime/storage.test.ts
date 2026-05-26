import type { DocumentId, StoredDocument } from "@embedded/runtime/db/types";
import type { EmbeddedRuntime } from "@embedded/runtime/embedded";
import type { EmbeddedPlatformAdapter } from "@embedded/runtime/platform";
import type { StorageAdapter } from "@embedded/storage/adapter";
import { attachPlatformStorage } from "@resolve/runtime/load";
import { mockAdapter } from "@tests/helpers/adapter";
import { describe, expect, it, vi } from "@tests/testkit";

function doc(id: string, fields: Record<string, unknown> = {}): StoredDocument {
  return { _id: id as DocumentId, _creationTime: 1, ...fields };
}

type Db = EmbeddedRuntime["db"];

interface FakeRuntimeDb {
  setReadBackendForTests: ReturnType<typeof vi.fn>;
  setStorage: ReturnType<typeof vi.fn>;
  hydrate: ReturnType<typeof vi.fn<Db["hydrate"]>>;
  hydrateSystemTables: ReturnType<typeof vi.fn<Db["hydrateSystemTables"]>>;
  hasDocumentsForTable: ReturnType<typeof vi.fn<Db["hasDocumentsForTable"]>>;
}

interface FakeRuntime {
  setStorage: ReturnType<typeof vi.fn>;
  getIdentityKey: ReturnType<typeof vi.fn<EmbeddedRuntime["getIdentityKey"]>>;
  resumePersistedState: ReturnType<
    typeof vi.fn<EmbeddedRuntime["resumePersistedState"]>
  >;
  db: FakeRuntimeDb;
}

function createFakeRuntime(
  dbOverrides: Partial<FakeRuntimeDb> = {},
): FakeRuntime {
  return {
    setStorage: vi.fn(),
    getIdentityKey: vi.fn(() => null),
    resumePersistedState: vi.fn(async () => undefined),
    db: {
      setReadBackendForTests: vi.fn(),
      setStorage: vi.fn(),
      hydrate: vi.fn(async () => undefined),
      hydrateSystemTables: vi.fn(async () => undefined),
      hasDocumentsForTable: vi.fn(() => false),
      ...dbOverrides,
    },
  };
}

function fakePlatform(storage: StorageAdapter): EmbeddedPlatformAdapter {
  return {
    openStorage: vi.fn(async () => storage),
  } as unknown as EmbeddedPlatformAdapter;
}

function attach(
  runtime: FakeRuntime,
  platform: EmbeddedPlatformAdapter,
): Promise<void> {
  return attachPlatformStorage({
    runtime: runtime as unknown as EmbeddedRuntime,
    platform,
    name: "test",
  });
}

function createStorage(
  rowsByTable: Record<string, StoredDocument[]>,
  kind: "opaque" | "sql" = "opaque",
): StorageAdapter {
  const base = {
    getDocuments: vi.fn(async (table?: string) =>
      table === undefined
        ? Object.entries(rowsByTable).flatMap(([tableName, docs]) =>
            docs.map((doc) => ({ tableName, doc })),
          )
        : (rowsByTable[table] ?? []),
    ),
    getMetadata: vi.fn(async () => ({ timestamp: 1, lastCreationTime: 1 })),
    listBlobs: vi.fn(async () => []),
    write: vi.fn(async () => undefined),
    putBlob: vi.fn(async () => undefined),
    deleteBlob: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  if (kind === "sql") {
    return mockAdapter({
      ...base,
      source: vi.fn(async () => []),
      query: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => []),
      write: vi.fn(async (_batch, opts) =>
        opts
          ? {
              meta: { timestamp: 1, lastCreationTime: 1 },
              tables: [],
            }
          : undefined,
      ),
    });
  }
  return mockAdapter(base);
}

describe("attachPlatformStorage", () => {
  it("hydrates storage then resumes persisted state", async () => {
    const runtime = createFakeRuntime();

    await attach(runtime, fakePlatform(createStorage({})));

    expect(runtime.db.hydrateSystemTables).toHaveBeenCalledTimes(1);
    expect(runtime.resumePersistedState).toHaveBeenCalledTimes(1);
  });

  it("hydrates existing persisted user rows", async () => {
    const storage = createStorage({
      tasks: [doc("task-local", { title: "Persisted" })],
    });
    const runtime = createFakeRuntime({
      hasDocumentsForTable: vi.fn((name: string) => name === "tasks"),
    });

    await attach(runtime, fakePlatform(storage));

    expect(runtime.db.hydrateSystemTables).toHaveBeenCalledTimes(1);
    expect(runtime.resumePersistedState).toHaveBeenCalledTimes(1);
  });

  it("delegates open hydration to hydrateSystemTables (lazy user tables)", async () => {
    const runtime = createFakeRuntime();

    await attach(runtime, fakePlatform(createStorage({}, "sql")));

    expect(runtime.db.hydrateSystemTables).toHaveBeenCalledTimes(1);
  });
});
