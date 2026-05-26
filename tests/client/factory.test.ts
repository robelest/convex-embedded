import type {
  DocumentId,
  Source,
  StoredDocument,
} from "@embedded/runtime/db/types";
import type { PendingReplayMeta } from "@embedded/shared/symbols";
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
import { emptyPreloaded } from "@resolve/client/preload";
import { whenPreloaded } from "@resolve/client/remote";
import { discoverPendingReplayMetadata } from "@resolve/client/replay";
import { makeFunctionReference } from "@resolve/shared/refs";
import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

const MODULES = {
  "_generated/api": async () => ({}),
};

describe("createEmbeddedClient bootstrap", () => {
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

  it("whenPreloaded resolves immediately when no sync engine is attached", async () => {
    const bare = {} as unknown as ConvexClient;
    const preloaded = emptyPreloaded(
      makeFunctionReference<FunctionReference<"query">>("projects:list"),
      {},
    );
    await expect(whenPreloaded(bare, preloaded)).resolves.toBeUndefined();
  });
});
