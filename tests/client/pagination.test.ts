import { patchRoutedConvexClient } from "@resolve/client/adapter";
import { EmbeddedQueryCache } from "@resolve/client/cache";
import type { EmbeddedRuntime } from "@resolve/index";
import { describe, expect, it, vi } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

interface PaginatedClient {
  onUpdate(
    ref: unknown,
    args: Record<string, unknown>,
    callback: (value: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void;
  onPaginatedUpdate_experimental(
    ref: unknown,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    callback: (value: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void;
}

function createHarness() {
  const ensureReadReady = vi.fn(async () => undefined);

  const watch = {
    onUpdate: vi.fn(() => () => {}),
    localQueryResult: vi.fn(() => ({
      page: [],
      isDone: true,
      continueCursor: "",
    })),
    localQueryLogs: vi.fn(() => []),
  };

  const runtime = {
    executeLocal: vi.fn(async () => ({
      page: [],
      isDone: true,
      continueCursor: "",
    })),
    watchLocalQuery: vi.fn(() => watch),
    watchLocalPaginatedQuery: vi.fn(() => watch),
  } as unknown as EmbeddedRuntime;

  const remoteClient = {
    query: vi.fn(async () => undefined),
    mutation: vi.fn(async () => undefined),
    action: vi.fn(async () => undefined),
    onUpdate: vi.fn(() => () => {}),
    onPaginatedUpdate_experimental: vi.fn(() => () => {}),
  } as unknown as ConvexClient;

  const client = {
    query: vi.fn(),
    mutation: vi.fn(),
    action: vi.fn(),
    onUpdate: vi.fn(),
    onPaginatedUpdate_experimental: vi.fn(),
    client: {
      localQueryResult: vi.fn(),
      localQueryLogs: vi.fn(() => []),
    },
  } as unknown as ConvexClient;

  patchRoutedConvexClient({
    client,
    runtime,
    remoteClient,
    getRefName: (ref) => String(ref),
    asError: (error) =>
      error instanceof Error ? error : new Error(String(error)),
    resolveMutationPlan: () => ({ kind: "local", enqueueForReplay: false }),
    resolveReadPlan: () => ({ kind: "local" }),
    resolveReadPlanByName: () => ({ kind: "local" }),
    executeLocalMutation: vi.fn(async () => null),
    ensureReadReady,
    cache: new EmbeddedQueryCache(),
  });

  return { client: client as unknown as PaginatedClient, ensureReadReady };
}

describe("cold paginated query sync", () => {
  it("triggers ensureReadReady for a full query subscription", () => {
    const { client, ensureReadReady } = createHarness();

    client.onUpdate("things:full", { group: "a" }, () => {});

    expect(ensureReadReady).toHaveBeenCalledWith(
      "things:full",
      expect.objectContaining({ group: "a" }),
    );
  });

  it("triggers ensureReadReady for a paginated query subscription", () => {
    const { client, ensureReadReady } = createHarness();

    client.onPaginatedUpdate_experimental(
      "things:paged",
      { group: "a", paginationOpts: { cursor: null, numItems: 10 } },
      { initialNumItems: 10 },
      () => {},
    );

    expect(ensureReadReady).toHaveBeenCalledWith(
      "things:paged",
      expect.objectContaining({ group: "a" }),
    );
  });
});
