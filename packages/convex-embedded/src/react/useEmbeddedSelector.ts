import type { ConvexClient } from "convex/browser";
import { useConvex } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { unwrapEmbeddedBrowserClient } from "@/react/client";

interface SubscriptionLike<T> {
  getCurrentValue(): T | undefined;
  unsubscribe(): void;
}

interface EmbeddedClientLike<Query extends FunctionReference<"query">> {
  onUpdate(
    query: Query,
    args: FunctionArgs<Query>,
    onChange: () => void,
    onError?: (error: Error) => void,
  ): SubscriptionLike<FunctionReturnType<Query>>;
  peekCurrentValue?: (query: Query, args: FunctionArgs<Query>) => unknown;
}

const SENTINEL = Symbol("convex-embedded:selector-undefined");

export function useEmbeddedSelector<
  Query extends FunctionReference<"query">,
  Selected,
>(
  query: Query,
  args: FunctionArgs<Query>,
  selector: (value: FunctionReturnType<Query>) => Selected,
  isEqual: (a: Selected, b: Selected) => boolean = Object.is,
): Selected | undefined {
  const convex = useConvex();
  const embedded = useMemo(
    () =>
      unwrapEmbeddedBrowserClient(convex as unknown as ConvexClient) as unknown as
        EmbeddedClientLike<Query>,
    [convex],
  );

  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  const stableArgsKey = useMemo(() => stableKey(args), [args]);
  const cached = useRef<{ value: Selected | typeof SENTINEL; key: string }>({
    value: SENTINEL,
    key: stableArgsKey,
  });

  const { subscribe, getSnapshot } = useMemo(() => {
    let subscription: SubscriptionLike<FunctionReturnType<Query>> | null = null;
    const listeners = new Set<() => void>();

    const ensure = () => {
      if (subscription !== null) return subscription;
      subscription = embedded.onUpdate(query, args, () => {
        cached.current = { value: SENTINEL, key: stableArgsKey };
        for (const l of listeners) l();
      });
      return subscription;
    };

    const subscribeFn = (listener: () => void) => {
      ensure();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && subscription !== null) {
          subscription.unsubscribe();
          subscription = null;
        }
      };
    };

    let lastSelected: Selected | typeof SENTINEL = SENTINEL;
    const getSnapshotFn = (): Selected | undefined => {
      if (cached.current.key !== stableArgsKey) {
        cached.current = { value: SENTINEL, key: stableArgsKey };
        lastSelected = SENTINEL;
      }
      if (cached.current.value !== SENTINEL) {
        return cached.current.value as Selected;
      }
      const sub = subscription ?? ensure();
      const value =
        sub.getCurrentValue() ??
        (typeof embedded.peekCurrentValue === "function"
          ? (embedded.peekCurrentValue(query, args) as
              | FunctionReturnType<Query>
              | undefined)
          : undefined);
      if (value === undefined) {
        cached.current = { value: SENTINEL, key: stableArgsKey };
        return undefined;
      }
      const next = selectorRef.current(value);
      const stable =
        lastSelected !== SENTINEL &&
        isEqualRef.current(lastSelected as Selected, next)
          ? (lastSelected as Selected)
          : next;
      lastSelected = stable;
      cached.current = { value: stable, key: stableArgsKey };
      return stable;
    };

    return { subscribe: subscribeFn, getSnapshot: getSnapshotFn };
  }, [embedded, query, args, stableArgsKey]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    return () => {
      cached.current = { value: SENTINEL, key: stableArgsKey };
    };
  }, [stableArgsKey]);

  return snapshot;
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableKey((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
