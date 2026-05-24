import type {
  DocumentId,
  Source,
  StoredDocument,
} from "@embedded/runtime/db/types";
import type { PendingReplayMeta } from "@embedded/shared/symbols";
import type {
  DocumentWithTable,
  StorageMetadata,
} from "@embedded/storage/adapter";
import { mockAdapter } from "@tests/helpers/adapter";
import { describe, expect, it } from "@tests/testkit";

const mocks = vi.hoisted(() => ({
  discoverPendingReplayMetadata: vi.fn(
    async (): Promise<Map<string, PendingReplayMeta>> => new Map(),
  ),
}));

vi.mock("convex/browser", () => ({
  ConvexClient: class MockConvexClient {
    mutation = vi.fn(async () => undefined);
    query = vi.fn(async () => undefined);
    action = vi.fn(async () => undefined);
    onUpdate = vi.fn(() => {
      const unsub = (() => {}) as (() => void) & { unsubscribe: () => void };
      unsub.unsubscribe = unsub;
      return unsub;
    });
    onPaginatedUpdate_experimental = vi.fn(() => {
      const unsub = (() => {}) as (() => void) & { unsubscribe: () => void };
      unsub.unsubscribe = unsub;
      return unsub;
    });
    close = vi.fn(async () => undefined);
    setAuth = vi.fn();

    constructor(
      readonly url: string,
      readonly options?: Record<string, unknown>,
    ) {}
  },
}));

vi.mock("@resolve/client/replay", () => ({
  discoverPendingReplayMetadata: mocks.discoverPendingReplayMetadata,
}));

import { getEmbeddedClientEntry } from "@resolve/client/entry";
import { createEmbeddedClient } from "@resolve/client/factory";
import { discoverPendingReplayMetadata } from "@resolve/client/replay";
import { EmbeddedRuntime } from "@resolve/index";

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MODULES = {
  "_generated/api": async () => ({}),
};

describe("createEmbeddedClient prefetch bootstrap", () => {
  it("serves prefetched data immediately and refreshes local watches after durable storage loads", async ({
    track,
  }) => {
    const persistedRows = deferredPromise<DocumentWithTable[]>();
    const persistedMeta = deferredPromise<StorageMetadata>();
    const refreshSpy = vi
      .spyOn(EmbeddedRuntime.prototype, "refreshLocalQueryWatches")
      .mockResolvedValue(undefined);

    const client = track(
      createEmbeddedClient({
        options: {
          convex: { modules: MODULES },
          name: "factory-prefetch-test",
          prefetch: {
            identityKey: null,
            tables: {
              tasks: [
                {
                  _id: "task-prefetch",
                  _creationTime: 1,
                  title: "Prefetched task",
                },
              ],
            },
            metadata: {
              tasks: {
                collectionSeq: 1,
                documents: [{ docId: "task-prefetch", seq: 1 }],
              },
            },
          },
        },
        platform: {
          openStorage: vi.fn(async () =>
            mockAdapter({
              getDocuments: (table?: string) =>
                table === undefined
                  ? persistedRows.promise
                  : Promise.resolve([]),
              getMetadata: () => persistedMeta.promise,
              write: vi.fn(async () => undefined),
              putBlob: vi.fn(async () => undefined),
              deleteBlob: vi.fn(async () => undefined),
              clearAll: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            }),
          ),
        },
      }),
    );

    const entry = getEmbeddedClientEntry(client);
    expect(entry).toBeDefined();
    const runtime = entry!.runtime;
    track({ close: () => runtime.shutdown() });

    await runtime.hydrate();

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      expect.objectContaining({
        _id: "task-prefetch",
        title: "Prefetched task",
      }),
    ]);
    expect(refreshSpy).not.toHaveBeenCalled();

    persistedRows.resolve([
      {
        tableName: "tasks",
        doc: {
          _id: "task-persisted" as DocumentId,
          _creationTime: 2,
          title: "Persisted task",
        },
      },
    ]);
    persistedMeta.resolve({ timestamp: 2, lastCreationTime: 2 });

    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      expect.objectContaining({
        _id: "task-persisted",
        title: "Persisted task",
      }),
    ]);
  });

  it("loads replay metadata only when sql-backed pending rows exist for the active identity", async ({
    track,
  }) => {
    mocks.discoverPendingReplayMetadata.mockImplementation(
      async () => new Map(),
    );
    const pendingRow: StoredDocument = {
      _id: "pending-1" as DocumentId,
      _creationTime: 1,
      identityKey: null,
      ref: "tasks:create",
      args: JSON.stringify({}),
      localResult: JSON.stringify(null),
      table: "tasks",
      payloadVersion: 1,
      state: "pending",
    };

    const withPending = track(
      createEmbeddedClient({
        options: {
          convex: { modules: MODULES },
          name: "factory-pending-hit",
        },
        platform: {
          openStorage: vi.fn(async () =>
            mockAdapter({
              kind: "sql",
              getDocuments: vi.fn(async () => []),
              getDocument: vi.fn(async () => null),
              getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
              listBlobs: vi.fn(async () => []),
              countDocuments: vi.fn(async () => 0),
              source: vi.fn(async (source: Source) => {
                if (
                  source.type === "IndexRange" &&
                  source.indexName ===
                    "_resolve_pending.by_identity_key_and_creation_time"
                ) {
                  return [pendingRow];
                }
                return [];
              }),
              query: vi.fn(async () => null),
              write: vi.fn(async () => undefined),
              putBlob: vi.fn(async () => undefined),
              deleteBlob: vi.fn(async () => undefined),
              clearAll: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            }),
          ),
        },
      }),
    );

    const withoutPending = track(
      createEmbeddedClient({
        options: {
          convex: { modules: MODULES },
          name: "factory-pending-miss",
        },
        platform: {
          openStorage: vi.fn(async () =>
            mockAdapter({
              kind: "sql",
              getDocuments: vi.fn(async () => []),
              getDocument: vi.fn(async () => null),
              getMetadata: async () => ({ timestamp: 0, lastCreationTime: 0 }),
              listBlobs: vi.fn(async () => []),
              countDocuments: vi.fn(async () => 0),
              source: vi.fn(async () => []),
              query: vi.fn(async () => null),
              write: vi.fn(async () => undefined),
              putBlob: vi.fn(async () => undefined),
              deleteBlob: vi.fn(async () => undefined),
              clearAll: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            }),
          ),
        },
      }),
    );

    const withPendingRuntime = getEmbeddedClientEntry(withPending)!.runtime;
    const withoutPendingRuntime =
      getEmbeddedClientEntry(withoutPending)!.runtime;
    track({ close: () => withPendingRuntime.shutdown() });
    track({ close: () => withoutPendingRuntime.shutdown() });

    await withPendingRuntime.hydrate();
    await withoutPendingRuntime.hydrate();

    expect(
      vi.mocked(discoverPendingReplayMetadata).mock.calls.length,
    ).toBeLessThanOrEqual(1);
  });
});
