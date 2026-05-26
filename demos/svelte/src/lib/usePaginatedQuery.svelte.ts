import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

export type PaginatedStatus =
  | "LoadingFirstPage"
  | "CanLoadMore"
  | "LoadingMore"
  | "Exhausted";

interface PaginatedValue<T> {
  results: T[];
  status: PaginatedStatus;
  loadMore: (numItems: number) => boolean;
}

interface PaginatedSubscription<T> {
  getCurrentValue(): PaginatedValue<T> | undefined;
  unsubscribe(): void;
}

interface PaginatedCapableClient {
  onPaginatedUpdate_experimental<T>(
    query: FunctionReference<"query">,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    onResults: () => void,
    onStatus: () => void,
  ): PaginatedSubscription<T>;
}

export interface PaginatedQuery<T> {
  readonly results: T[];
  readonly status: PaginatedStatus;
  loadMore(numItems: number): boolean;
}

export function usePaginatedQuery<T>(
  getClient: () => ConvexClient,
  query: FunctionReference<"query">,
  getArgs: () => Record<string, unknown> | "skip",
  options: { initialNumItems: number },
): PaginatedQuery<T> {
  let value = $state<PaginatedValue<T> | undefined>(undefined);
  let subscription = $state<PaginatedSubscription<T> | undefined>(undefined);

  $effect(() => {
    const args = getArgs();
    if (args === "skip") {
      value = undefined;
      subscription = undefined;
      return;
    }
    const capable = getClient() as unknown as PaginatedCapableClient;
    // `sub` is forward-declared because `onPaginatedUpdate_experimental` may
    // invoke these callbacks synchronously during setup (before it returns).
    // Guarding on `sub` makes that initial emit a no-op; the value is captured
    // right after via `getCurrentValue()`. Referencing `sub` directly here would
    // throw a temporal-dead-zone ReferenceError and wedge the subscription.
    let sub: PaginatedSubscription<T> | undefined;
    const apply = () => {
      if (sub) {
        value = sub.getCurrentValue();
      }
    };
    sub = capable.onPaginatedUpdate_experimental<T>(
      query,
      args,
      { initialNumItems: options.initialNumItems },
      apply,
      apply,
    );
    subscription = sub;
    const initial = sub.getCurrentValue();
    if (initial !== undefined) {
      value = initial;
    }
    const active = sub;
    return () => {
      active.unsubscribe();
      if (subscription === active) {
        subscription = undefined;
      }
    };
  });

  return {
    get results(): T[] {
      return value?.results ?? [];
    },
    get status(): PaginatedStatus {
      return value?.status ?? "LoadingFirstPage";
    },
    loadMore(count: number): boolean {
      const current = value ?? subscription?.getCurrentValue();
      return current?.loadMore(count) ?? false;
    },
  };
}
