import { wrapConvexBrowserClientForReact } from "@resolve/react";
import { describe, expect, it } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { vi } from "vitest";

function createQuerySubscription<T>(initialValue: T | undefined) {
  let currentValue = initialValue;
  let onUpdate: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();
  const logs = ["query log"];

  return {
    subscription: {
      unsubscribe,
      getCurrentValue: () => currentValue,
      getQueryLogs: () => logs,
    },
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
      return this.subscription;
    },
  };
}

function createPaginatedSubscription<T>(initialValue: T | undefined) {
  let currentValue = initialValue;
  let onUpdate: (() => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();

  return {
    subscription: {
      unsubscribe,
      getCurrentValue: () => currentValue,
      getQueryLogs: () => [],
    },
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
      return this.subscription;
    },
  };
}

describe("wrapConvexBrowserClientForReact", () => {
  it("shares a single query subscription across React listeners", async () => {
    const queryRef = makeFunctionReference<"query">("tasks:list");
    const querySubscription = createQuerySubscription([{ _id: "task-1" }]);
    const client = {
      onUpdate: vi.fn((_query, _args, callback, onError) =>
        querySubscription.bind(callback, onError),
      ),
      onPaginatedUpdate_experimental: vi.fn(),
      mutation: vi.fn(),
      action: vi.fn(),
      query: vi.fn(),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } as unknown as ConvexClient;

    const reactClient = wrapConvexBrowserClientForReact(client);
    const watch = reactClient.watchQuery(queryRef, {});

    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = watch.onUpdate(first);
    const unsubscribeSecond = watch.onUpdate(second);

    await Promise.resolve();

    expect((client as any).onUpdate).toHaveBeenCalledTimes(1);
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
    const client = {
      onUpdate: vi.fn(),
      onPaginatedUpdate_experimental: vi.fn(
        (_query, _args, _options, callback, onError) =>
          paginatedSubscription.bind(callback, onError),
      ),
      mutation: vi.fn(),
      action: vi.fn(),
      query: vi.fn(),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => () => {}),
      close: vi.fn(async () => {}),
    } as unknown as ConvexClient;

    const reactClient = wrapConvexBrowserClientForReact(client);
    const watch = reactClient.watchPaginatedQuery(queryRef, {} as never, {
      initialNumItems: 1,
      id: 1,
    });

    const listener = vi.fn();
    const unsubscribe = watch.onUpdate(listener);
    await Promise.resolve();

    expect(
      (client as any).onPaginatedUpdate_experimental,
    ).toHaveBeenCalledTimes(1);
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
    const client = {
      onUpdate: vi.fn(),
      onPaginatedUpdate_experimental: vi.fn(),
      mutation: vi.fn(async () => ({ ok: true })),
      action: vi.fn(async () => ({ synced: true })),
      query: vi.fn(async () => [{ _id: "task-1" }]),
      connectionState: vi.fn(() => "connected"),
      subscribeToConnectionState: vi.fn(() => unsubscribeState),
      close: vi.fn(async () => {}),
    } as unknown as ConvexClient;

    const reactClient = wrapConvexBrowserClientForReact(client);

    await expect(
      reactClient.mutation(mutationRef, { title: "A" }),
    ).resolves.toEqual({
      ok: true,
    });
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

    expect((client as any).mutation).toHaveBeenCalledWith(mutationRef, {
      title: "A",
    });
    expect((client as any).query).toHaveBeenCalledWith(queryRef, {});
    expect((client as any).action).toHaveBeenCalledWith(actionRef, {});
    expect((client as any).subscribeToConnectionState).toHaveBeenCalledWith(
      stateListener,
    );
    expect((client as any).close).toHaveBeenCalledOnce();
  });

  it("delegates auth methods to the embedded client", () => {
    const fetchToken = vi.fn(async () => "token");
    const onChange = vi.fn();
    const client = {
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
    } as unknown as ConvexClient;

    const reactClient = wrapConvexBrowserClientForReact(client);

    reactClient.setAuth(fetchToken, onChange);
    reactClient.clearAuth();
    (reactClient as any).setAdminAuth("admin-token", { subject: "admin" });

    expect((client as any).setAuth).toHaveBeenCalledWith(fetchToken, onChange);
    expect((client as any).clearAuth).toHaveBeenCalledOnce();
    expect((client as any).setAdminAuth).toHaveBeenCalledWith("admin-token", {
      subject: "admin",
    });
  });
});
