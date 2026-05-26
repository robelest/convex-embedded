import { browser } from "$app/environment";
import { whenPreloaded } from "@robelest/convex-embedded/browser";
import {
  preloadedQueryRef,
  preloadedQueryResult,
  type Preloaded,
} from "@robelest/convex-embedded/client";
import { useConvexClient, useQuery } from "convex-svelte";
import {
  makeFunctionReference,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";

export interface PreloadedQuery<T> {
  readonly current: T;
  readonly error: Error | undefined;
}

export function usePreloadedQuery<Query extends FunctionReference<"query">>(
  preloaded: Preloaded<Query>,
): PreloadedQuery<FunctionReturnType<Query>> {
  const initial = preloadedQueryResult(preloaded);

  if (!browser) {
    return {
      get current() {
        return initial;
      },
      get error() {
        return undefined;
      },
    };
  }

  const client = useConvexClient();
  const { name, args } = preloadedQueryRef(preloaded);
  const live = useQuery(
    makeFunctionReference<Query>(name),
    () => args as FunctionArgs<Query>,
  );

  // Show the authoritative preloaded value (placeholder) until the query's scope
  // has resolved from remote (or we are offline / have no engine), then defer to
  // the live local query. Avoids a flash of stale local rows.
  let ready = $state(false);
  $effect(() => {
    let active = true;
    void whenPreloaded(client, preloaded).then(() => {
      if (active) ready = true;
    });
    return () => {
      active = false;
    };
  });

  return {
    get current(): FunctionReturnType<Query> {
      return ready ? (live.data ?? initial) : initial;
    },
    get error(): Error | undefined {
      return live.error;
    },
  };
}
