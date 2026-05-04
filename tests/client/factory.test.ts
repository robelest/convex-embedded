import { mockAdapter } from "@tests/helpers/adapter";
import { afterEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

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
  discoverPendingReplayMetadata: vi.fn(async () => new Map()),
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

const MODULES = {
  "_generated/api": async () => ({}),
};

describe("createEmbeddedClient prefetch bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves prefetched data immediately and refreshes local watches after durable storage loads", async () => {
    const persistedRows =
      deferredPromise<
        Array<{ tableName: string; doc: Record<string, unknown> }>
      >();
    const persistedMeta = deferredPromise<{
      timestamp: number;
      lastCreationTime: number;
    }>();
    const refreshSpy = vi
      .spyOn(EmbeddedRuntime.prototype, "refreshLocalQueryWatches")
      .mockResolvedValue(undefined);

    const client = createEmbeddedClient({
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
                ? (persistedRows.promise as any)
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
    });

    const entry = getEmbeddedClientEntry(client);
    expect(entry).toBeDefined();
    const runtime = entry!.runtime;

    try {
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
            _id: "task-persisted",
            _creationTime: 2,
            title: "Persisted task",
          },
        },
      ]);
      persistedMeta.resolve({ timestamp: 2, lastCreationTime: 2 });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(await runtime.getDocumentsForTable("tasks")).toEqual([
        expect.objectContaining({
          _id: "task-persisted",
          title: "Persisted task",
        }),
      ]);
    } finally {
      await (client as any).close?.();
      runtime.shutdown();
    }
  });

  it("loads replay metadata only when sql-backed pending rows exist for the active identity", async () => {
    const discoverSpy = vi.mocked(discoverPendingReplayMetadata);
    discoverSpy.mockImplementation(async () => new Map());
    const withPending = createEmbeddedClient({
      options: {
        convex: { modules: MODULES },
        name: "factory-pending-hit",
      },
      platform: {
        openStorage: vi.fn(async () =>
          mockAdapter({
            kind: "sql",
            listAll: async () => [],
            list: vi.fn(async () => []),
            get: vi.fn(async () => null),
            meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
            listBlobs: vi.fn(async () => []),
            getDocuments: vi.fn(async (tableName: string) =>
              tableName === "_resolve_pending"
                ? [
                    {
                      _id: "pending-1",
                      _creationTime: 1,
                      identityKey: null,
                      ref: "tasks:create",
                      args: JSON.stringify({}),
                      localResult: JSON.stringify(null),
                      table: "tasks",
                      payloadVersion: 1,
                      state: "pending",
                    },
                  ]
                : [],
            ),
            count: vi.fn(async () => 0),
            source: vi.fn(async (source: any) => {
              if (
                source.type === "IndexRange" &&
                source.indexName ===
                  "_resolve_pending.by_identity_key_and_creation_time"
              ) {
                return [
                  {
                    _id: "pending-1",
                    _creationTime: 1,
                    identityKey: null,
                    ref: "tasks:create",
                    args: JSON.stringify({}),
                    localResult: JSON.stringify(null),
                    table: "tasks",
                    payloadVersion: 1,
                    state: "pending",
                  },
                ];
              }
              return [];
            }),
            query: vi.fn(async () => null),
            commit: vi.fn(async () => undefined),
            putBlob: vi.fn(async () => undefined),
            deleteBlob: vi.fn(async () => undefined),
            clear: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
          }),
        ),
      },
    });

    const withoutPending = createEmbeddedClient({
      options: {
        convex: { modules: MODULES },
        name: "factory-pending-miss",
      },
      platform: {
        openStorage: vi.fn(async () =>
          mockAdapter({
            kind: "sql",
            listAll: async () => [],
            list: vi.fn(async () => []),
            get: vi.fn(async () => null),
            meta: async () => ({ timestamp: 0, lastCreationTime: 0 }),
            listBlobs: vi.fn(async () => []),
            getDocuments: vi.fn(async () => []),
            count: vi.fn(async () => 0),
            source: vi.fn(async () => []),
            query: vi.fn(async () => null),
            commit: vi.fn(async () => undefined),
            putBlob: vi.fn(async () => undefined),
            deleteBlob: vi.fn(async () => undefined),
            clear: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
          }),
        ),
      },
    });

    try {
      await getEmbeddedClientEntry(withPending)!.runtime.hydrate();
      await getEmbeddedClientEntry(withoutPending)!.runtime.hydrate();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(discoverSpy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      await (withPending as any).close?.();
      await (withoutPending as any).close?.();
      getEmbeddedClientEntry(withPending)?.runtime.shutdown();
      getEmbeddedClientEntry(withoutPending)?.runtime.shutdown();
    }
  });
});
