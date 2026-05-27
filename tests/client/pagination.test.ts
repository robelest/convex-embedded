import { EmbeddedQueryCache } from "@resolve/client/cache";
import { EmbeddedClient } from "@resolve/client/embedded";
import type { EmbeddedRuntime } from "@resolve/index";
import { flushMicrotasks } from "@tests/helpers/time";
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

  const client = new EmbeddedClient("http://embedded.local");

  client.installRouting({
    runtime,
    remoteClient,
    getRefName: (ref: unknown) => String(ref),
    asError: (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    planMutation: () => ({ kind: "local", enqueueForReplay: false }),
    planRead: () => ({ kind: "local" }),
    planReadByName: () => ({ kind: "local" }),
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

  it("never invokes the paginated callback synchronously during subscribe", async () => {
    const { client } = createHarness();
    const args = { paginationOpts: { cursor: null, numItems: 10 } };

    // Warm the cache so the value is available synchronously on the next
    // subscribe (the case that used to fire the callback synchronously).
    const first = client.onPaginatedUpdate_experimental(
      "things:paged",
      args,
      { initialNumItems: 10 },
      () => {},
    );
    await flushMicrotasks();
    first();

    let calledDuringSubscribe = false;
    let calledAsync = false;
    let returned = false;
    const second = client.onPaginatedUpdate_experimental(
      "things:paged",
      args,
      { initialNumItems: 10 },
      () => {
        if (returned) calledAsync = true;
        else calledDuringSubscribe = true;
      },
    );
    returned = true;

    // The standard `const sub = onUpdate(..., () => sub.x)` pattern relies on
    // this: the callback must not fire before the subscribe call returns.
    expect(calledDuringSubscribe).toBe(false);
    await flushMicrotasks();
    expect(calledAsync).toBe(true);

    second();
  });
});

interface Row {
  _id: string;
  _creationTime: number;
}

interface MergedResult {
  results: Row[];
  status: PaginatedStatus;
  loadMore: (n: number) => boolean;
}

type PaginatedStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted";

interface PageValue {
  page: Row[];
  isDone: boolean;
  continueCursor: string;
}

function dedupHarness(
  pagesByCursor: Record<string, PageValue>,
): PaginatedClient {
  const cursorKey = (args: Record<string, unknown>): string => {
    const opts = args.paginationOpts as { cursor?: string | null } | undefined;
    return opts?.cursor ?? "";
  };
  const empty: PageValue = { page: [], isDone: true, continueCursor: "" };

  const runtime = {
    executeLocal: vi.fn(async () => empty),
    watchLocalQuery: vi.fn((_ref: string, args: Record<string, unknown>) => ({
      onUpdate: () => () => {},
      localQueryResult: () => pagesByCursor[cursorKey(args)] ?? empty,
      localQueryLogs: () => [],
    })),
    watchLocalPaginatedQuery: vi.fn(() => ({
      onUpdate: () => () => {},
      localQueryResult: () => empty,
      localQueryLogs: () => [],
    })),
  } as unknown as EmbeddedRuntime;

  const remoteClient = {
    query: vi.fn(async () => undefined),
    mutation: vi.fn(async () => undefined),
    action: vi.fn(async () => undefined),
    onUpdate: vi.fn(() => () => {}),
    onPaginatedUpdate_experimental: vi.fn(() => () => {}),
  } as unknown as ConvexClient;

  const client = new EmbeddedClient("http://embedded.local");

  client.installRouting({
    runtime,
    remoteClient,
    getRefName: (ref: unknown) => String(ref),
    asError: (error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    planMutation: () => ({ kind: "local", enqueueForReplay: false }),
    planRead: () => ({ kind: "local" }),
    planReadByName: () => ({ kind: "local" }),
    executeLocalMutation: vi.fn(async () => null),
    ensureReadReady: vi.fn(async () => undefined),
    cache: new EmbeddedQueryCache(),
  });

  return client as unknown as PaginatedClient;
}

describe("paginated snapshot dedup", () => {
  it("drops ids that overlap across page boundaries", async () => {
    const client = dedupHarness({
      "": {
        page: [
          { _id: "A", _creationTime: 1 },
          { _id: "B", _creationTime: 2 },
        ],
        isDone: false,
        continueCursor: "c1",
      },
      c1: {
        page: [
          { _id: "B", _creationTime: 2 },
          { _id: "D", _creationTime: 4 },
        ],
        isDone: true,
        continueCursor: "",
      },
    });

    let latest: MergedResult | undefined;
    client.onPaginatedUpdate_experimental(
      "issues:forProject",
      { paginationOpts: { cursor: null, numItems: 2 } },
      { initialNumItems: 2 },
      (value) => {
        latest = value as MergedResult;
      },
    );

    await flushMicrotasks();
    expect(latest?.results.map((d) => d._id)).toEqual(["A", "B"]);

    latest?.loadMore(2);
    await flushMicrotasks();

    const ids = latest?.results.map((d) => d._id) ?? [];
    expect(ids).toEqual(["A", "B", "D"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
