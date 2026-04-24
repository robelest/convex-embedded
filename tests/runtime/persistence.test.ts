import { attachPlatformPersistence } from "@resolve/runtime/persistence";
import { mockAdapter } from "@tests/helpers/test-adapter";
import { describe, expect, it, vi } from "@tests/testkit";

function createStorage(
  rowsByTable: Record<string, Array<Record<string, unknown>>>,
  kind: "opaque" | "sql" = "opaque",
) {
  const base = {
    listAll: vi.fn(async () =>
      Object.entries(rowsByTable).flatMap(([tableName, docs]) =>
        docs.map((doc) => ({ tableName, doc })),
      ),
    ),
    list: vi.fn(async (tableName: string) => rowsByTable[tableName] ?? []),
    meta: vi.fn(async () => ({ timestamp: 1, lastCreationTime: 1 })),
    listBlobs: vi.fn(async () => []),
    commit: vi.fn(async () => undefined),
    putBlob: vi.fn(async () => undefined),
    deleteBlob: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  if (kind === "sql") {
    // Real SQL adapters expose pushdown reads + atomic commits.
    return mockAdapter({
      ...base,
      source: vi.fn(async () => []),
      query: vi.fn(async () => []),
      vectorSearch: vi.fn(async () => []),
      atomicCommit: vi.fn(async () => ({
        meta: { timestamp: 1, lastCreationTime: 1 },
        tables: [],
      })),
    });
  }
  return mockAdapter(base);
}

describe("attachPlatformPersistence", () => {
  it("hydrates all tables then persists prefetch when storage has no user rows", async () => {
    const storage = createStorage({});
    const runtime = {
      setPersistenceAdapter: vi.fn(),
      setIdentityKey: vi.fn(),
      crypto: {} as never,
      getIdentityKey: vi.fn(() => null),
      ingestPrefetchUngated: vi.fn(async () => undefined),
      resumePersistedState: vi.fn(async () => undefined),
      db: {
        setReadBackendForTests: vi.fn(),
        setStorage: vi.fn(),
        hydrate: vi.fn(async () => undefined),
        hasDocumentsForTable: vi.fn(() => false),
      },
    } as any;

    await attachPlatformPersistence({
      runtime,
      platform: {
        openPersistence: vi.fn(async () => storage),
      } as any,
      name: "test",
      prefetch: {
        identityKey: null,
        tables: { tasks: [{ _id: "task-1", _creationTime: 1 }] },
        metadata: {
          tasks: { collectionSeq: 1, documents: [{ docId: "task-1", seq: 1 }] },
        },
      },
    });

    expect(runtime.db.hydrate).toHaveBeenCalledWith();
    expect(runtime.ingestPrefetchUngated).toHaveBeenCalledTimes(1);
  });

  it("skips prefetch persistence and hydrates full data when storage already has user rows", async () => {
    const storage = createStorage({
      tasks: [{ _id: "task-local", _creationTime: 1, title: "Persisted" }],
    });
    const runtime = {
      setPersistenceAdapter: vi.fn(),
      crypto: {} as never,
      getIdentityKey: vi.fn(() => null),
      ingestPrefetchUngated: vi.fn(async () => undefined),
      resumePersistedState: vi.fn(async () => undefined),
      db: {
        setReadBackendForTests: vi.fn(),
        setStorage: vi.fn(),
        hydrate: vi.fn(async () => undefined),
        // Simulates the post-hydrate state: durable storage populated `tasks`.
        hasDocumentsForTable: vi.fn((name: string) => name === "tasks"),
      },
    } as any;

    await attachPlatformPersistence({
      runtime,
      platform: {
        openPersistence: vi.fn(async () => storage),
      } as any,
      name: "test",
      prefetch: {
        identityKey: null,
        tables: { tasks: [{ _id: "task-1", _creationTime: 1 }] },
        metadata: {
          tasks: { collectionSeq: 1, documents: [{ docId: "task-1", seq: 1 }] },
        },
      },
    });

    expect(runtime.db.hydrate).toHaveBeenCalledWith();
    expect(runtime.ingestPrefetchUngated).not.toHaveBeenCalled();
  });

  it("hydrates all tables eagerly at startup, including for sql persistence adapters", async () => {
    const storage = createStorage({}, "sql");
    const runtime = {
      setPersistenceAdapter: vi.fn(),
      crypto: {} as never,
      getIdentityKey: vi.fn(() => null),
      ingestPrefetchUngated: vi.fn(async () => undefined),
      resumePersistedState: vi.fn(async () => undefined),
      db: {
        setReadBackendForTests: vi.fn(),
        setStorage: vi.fn(),
        hydrate: vi.fn(async () => undefined),
        hasDocumentsForTable: vi.fn(() => false),
      },
    } as any;

    await attachPlatformPersistence({
      runtime,
      platform: {
        openPersistence: vi.fn(async () => storage),
      } as any,
      name: "test",
    });

    expect(runtime.db.hydrate).toHaveBeenCalledWith();
  });
});
