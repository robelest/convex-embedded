import type { Prefetch } from "@embedded/client/prefetch";
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
  hasDocumentsForTable: ReturnType<typeof vi.fn<Db["hasDocumentsForTable"]>>;
}

interface FakeRuntime {
  setStorage: ReturnType<typeof vi.fn>;
  getIdentityKey: ReturnType<typeof vi.fn<EmbeddedRuntime["getIdentityKey"]>>;
  ingestPrefetchUngated: ReturnType<
    typeof vi.fn<EmbeddedRuntime["ingestPrefetchUngated"]>
  >;
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
    ingestPrefetchUngated: vi.fn(async () => undefined),
    resumePersistedState: vi.fn(async () => undefined),
    db: {
      setReadBackendForTests: vi.fn(),
      setStorage: vi.fn(),
      hydrate: vi.fn(async () => undefined),
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
  prefetch?: Prefetch,
): Promise<void> {
  return attachPlatformStorage({
    runtime: runtime as unknown as EmbeddedRuntime,
    platform,
    name: "test",
    prefetch,
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

const PREFETCH: Prefetch = {
  identityKey: null,
  tables: { tasks: [{ _id: "task-1", _creationTime: 1 }] },
  metadata: {
    tasks: { collectionSeq: 1, documents: [{ docId: "task-1", seq: 1 }] },
  },
};

describe("attachPlatformStorage", () => {
  it("hydrates all tables then persists prefetch when storage has no user rows", async () => {
    const runtime = createFakeRuntime();

    await attach(runtime, fakePlatform(createStorage({})), PREFETCH);

    expect(runtime.db.hydrate).toHaveBeenCalledWith();
    expect(runtime.ingestPrefetchUngated).toHaveBeenCalledTimes(1);
  });

  it("skips prefetch ingest and hydrates full data when storage already has user rows", async () => {
    const storage = createStorage({
      tasks: [doc("task-local", { title: "Persisted" })],
    });
    const runtime = createFakeRuntime({
      hasDocumentsForTable: vi.fn((name: string) => name === "tasks"),
    });

    await attach(runtime, fakePlatform(storage), PREFETCH);

    expect(runtime.db.hydrate).toHaveBeenCalledWith();
    expect(runtime.ingestPrefetchUngated).not.toHaveBeenCalled();
  });

  it("hydrates all tables eagerly at startup, including for sql storage adapters", async () => {
    const runtime = createFakeRuntime();

    await attach(runtime, fakePlatform(createStorage({}, "sql")));

    expect(runtime.db.hydrate).toHaveBeenCalledWith();
  });
});
