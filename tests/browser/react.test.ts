import { wrapConvexBrowserClientForReact } from "@resolve/react";
import { describe, expect, it, vi, type Mock } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

interface QuerySubscriptionHandle<T> {
  unsubscribe: Mock;
  getCurrentValue: () => T | undefined;
  getQueryLogs: () => string[];
}

function createQuerySubscription<T>(initialValue: T | undefined) {
  let currentValue = initialValue;
  let onUpdate: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();
  const logs = ["query log"];

  const subscription: QuerySubscriptionHandle<T> = {
    unsubscribe,
    getCurrentValue: () => currentValue,
    getQueryLogs: () => logs,
  };

  return {
    subscription,
    emit(nextValue: T) {
      currentValue = nextValue;
      onUpdate?.();
    },
    fail(error: Error) {
      onError?.(error);
    },
    bind(callback: () => void, errorCallback?: (error: Error) => void) {
      onUpdate = callback;
      onError = errorCallback;
      return subscription;
    },
  };
}

interface PaginatedSubscriptionHandle<T> {
  unsubscribe: Mock;
  getCurrentValue: () => T | undefined;
  getQueryLogs: () => string[];
}

function createPaginatedSubscription<T>(initialValue: T | undefined) {
  let currentValue = initialValue;
  let onUpdate: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();

  const subscription: PaginatedSubscriptionHandle<T> = {
    unsubscribe,
    getCurrentValue: () => currentValue,
    getQueryLogs: () => [],
  };

  return {
    subscription,
    emit(nextValue: T) {
      currentValue = nextValue;
      onUpdate?.();
    },
    fail(error: Error) {
      onError?.(error);
    },
    bind(callback: () => void, errorCallback?: (error: Error) => void) {
      onUpdate = callback;
      onError = errorCallback;
      return subscription;
    },
  };
}

interface MockBrowserClient {
  onUpdate: Mock;
  onPaginatedUpdate_experimental: Mock;
  mutation: Mock;
  action: Mock;
  query: Mock;
  setAuth: Mock;
  clearAuth: Mock;
  setAdminAuth: Mock;
  connectionState: Mock;
  subscribeToConnectionState: Mock;
  close: Mock;
}

function asConvexClient(mock: Partial<MockBrowserClient>): ConvexClient {
  return mock as unknown as ConvexClient;
}

describe("wrapConvexBrowserClientForReact", () => {
  it("shares a single query subscription across React listeners", async () => {
    const queryRef = makeFunctionReference<"query">("tasks:list");
    const querySubscription = createQuerySubscription([{ _id: "task-1" }]);
    const onUpdate = vi.fn((_query, _args, callback: () => void, onError) =>
      querySubscription.bind(callback, onError),
    );
    const client = asConvexClient({
      onUpdate,
      onPaginatedUpdate_experimental: vi.fn(),
      mutation: vi.fn(),
      action: vi.fn(),
      query: vi.fn(),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    });

    const reactClient = wrapConvexBrowserClientForReact(client);
    const watch = reactClient.watchQuery(queryRef, {});

    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = watch.onUpdate(first);
    const unsubscribeSecond = watch.onUpdate(second);

    await Promise.resolve();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
    expect(watch.localQueryLogs()).toEqual(["query log"]);

    querySubscription.emit([{ _id: "task-2" }]);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual([{ _id: "task-2" }]);

    unsubscribeFirst();
    expect(querySubscription.subscription.unsubscribe).not.toHaveBeenCalled();

    unsubscribeSecond();
    expect(querySubscription.subscription.unsubscribe).toHaveBeenCalledOnce();
  });

  it("passes paginated query state through without remapping statuses", async () => {
    const queryRef = makeFunctionReference<"query">("tasks:paginated");
    const loadMore = vi.fn(() => true);
    const paginatedSubscription = createPaginatedSubscription({
      results: [{ _id: "task-1" }],
      status: "CanLoadMore",
      loadMore,
    });
    const onPaginatedUpdate = vi.fn(
      (_query, _args, _options, callback: () => void, onError) =>
        paginatedSubscription.bind(callback, onError),
    );
    const client = asConvexClient({
      onUpdate: vi.fn(),
      onPaginatedUpdate_experimental: onPaginatedUpdate,
      mutation: vi.fn(),
      action: vi.fn(),
      query: vi.fn(),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    });

    const reactClient = wrapConvexBrowserClientForReact(client);
    const watch = reactClient.watchPaginatedQuery(queryRef, {} as never, {
      initialNumItems: 1,
      id: 1,
    });

    const listener = vi.fn();
    const unsubscribe = watch.onUpdate(listener);
    await Promise.resolve();

    expect(onPaginatedUpdate).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(watch.localQueryResult()).toEqual({
      results: [{ _id: "task-1" }],
      status: "CanLoadMore",
      loadMore,
    });

    const nextLoadMore = vi.fn(() => false);
    paginatedSubscription.emit({
      results: [{ _id: "task-1" }, { _id: "task-2" }],
      status: "LoadingMore",
      loadMore: nextLoadMore,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual({
      results: [{ _id: "task-1" }, { _id: "task-2" }],
      status: "LoadingMore",
      loadMore: nextLoadMore,
    });

    unsubscribe();
    expect(
      paginatedSubscription.subscription.unsubscribe,
    ).toHaveBeenCalledOnce();
  });

  it("delegates imperative methods to the embedded client", async () => {
    const mutationRef = makeFunctionReference<"mutation">("tasks:create");
    const queryRef = makeFunctionReference<"query">("tasks:list");
    const actionRef = makeFunctionReference<"action">("tasks:sync");
    const stateListener = vi.fn();
    const unsubscribeState = vi.fn();
    const mock = {
      onUpdate: vi.fn(),
      onPaginatedUpdate_experimental: vi.fn(),
      mutation: vi.fn(async () => ({ ok: true })),
      action: vi.fn(async () => ({ synced: true })),
      query: vi.fn(async () => [{ _id: "task-1" }]),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => unsubscribeState),
      close: vi.fn(async () => {}),
    } satisfies Partial<MockBrowserClient>;

    const reactClient = wrapConvexBrowserClientForReact(asConvexClient(mock));

    await expect(
      reactClient.mutation(mutationRef, { title: "A" }),
    ).resolves.toEqual({ ok: true });
    await expect(reactClient.query(queryRef, {})).resolves.toEqual([
      { _id: "task-1" },
    ]);
    await expect(reactClient.action(actionRef, {})).resolves.toEqual({
      synced: true,
    });
    expect(reactClient.connectionState()).toBe("connected");
    expect(reactClient.subscribeToConnectionState(stateListener)).toBe(
      unsubscribeState,
    );

    await reactClient.close();

    expect(mock.mutation).toHaveBeenCalledWith(mutationRef, { title: "A" });
    expect(mock.query).toHaveBeenCalledWith(queryRef, {});
    expect(mock.action).toHaveBeenCalledWith(actionRef, {});
    expect(mock.subscribeToConnectionState).toHaveBeenCalledWith(stateListener);
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("delegates auth methods to the embedded client", () => {
    const fetchToken = vi.fn(async () => "token");
    const onChange = vi.fn();
    const mock = {
      onUpdate: vi.fn(),
      onPaginatedUpdate_experimental: vi.fn(),
      mutation: vi.fn(),
      action: vi.fn(),
      query: vi.fn(),
      setAuth: vi.fn(),
      clearAuth: vi.fn(),
      setAdminAuth: vi.fn(),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } satisfies Partial<MockBrowserClient>;

    const reactClient = wrapConvexBrowserClientForReact(asConvexClient(mock));

    reactClient.setAuth(fetchToken, onChange);
    reactClient.clearAuth();
    reactClient.setAdminAuth("admin-token", { subject: "admin" });

    expect(mock.setAuth).toHaveBeenCalledWith(fetchToken, onChange);
    expect(mock.clearAuth).toHaveBeenCalledOnce();
    expect(mock.setAdminAuth).toHaveBeenCalledWith("admin-token", {
      subject: "admin",
    });
  });
});
