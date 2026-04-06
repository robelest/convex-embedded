import type {
  ConnectionState,
  ConvexClient,
  MutationOptions,
  PaginationStatus,
  QueryJournal,
} from "convex/browser";
import { ConvexReactClient } from "convex/react";
import type {
  ArgsAndOptions,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";

type WatchQueryOptions = {
  journal?: QueryJournal;
  componentPath?: string;
};

type WatchPaginatedQueryOptions = {
  initialNumItems: number;
  id: number;
  componentPath?: string;
};

type LoadMoreOfPaginatedQuery = (numItems: number) => boolean;

type QuerySubscription<Query extends FunctionReference<"query">> = {
  unsubscribe: () => void;
  getCurrentValue: () => FunctionReturnType<Query> | undefined;
  getQueryLogs?: () => string[] | undefined;
};

type PaginatedQueryValue<Query extends FunctionReference<"query">> = {
  results: FunctionReturnType<Query>[];
  status: PaginationStatus;
  loadMore: LoadMoreOfPaginatedQuery;
};

type PaginatedQuerySubscription<Query extends FunctionReference<"query">> = {
  unsubscribe: () => void;
  getCurrentValue: () => PaginatedQueryValue<Query> | undefined;
  getQueryLogs?: () => string[] | undefined;
};

const EMBEDDED_BROWSER_CLIENT = Symbol("convex-embedded:browserClient");

type EmbeddedReactClient = ConvexReactClient & {
  [EMBEDDED_BROWSER_CLIENT]?: ConvexClient;
};

function scheduleImmediateCallback(callback: () => void): () => void {
  let cancelled = false;
  queueMicrotask(() => {
    if (!cancelled) {
      callback();
    }
  });
  return () => {
    cancelled = true;
  };
}

/**
 * React-compatible Convex client backed by a generic embedded `ConvexClient`.
 *
 * This adapter keeps the browser and Expo entries framework-agnostic at the
 * core client layer, while exposing the `ConvexReactClient` contract needed by
 * `ConvexProvider`, `useQuery`, and `usePaginatedQuery`.
 *
 * @internal
 */
export class EmbeddedConvexReactClient extends ConvexReactClient {
  constructor(private readonly embeddedClient: ConvexClient) {
    super("https://embedded.local", { unsavedChangesWarning: false });
    Object.defineProperty(this, EMBEDDED_BROWSER_CLIENT, {
      value: embeddedClient,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }

  setAuth(...args: Parameters<ConvexReactClient["setAuth"]>): void {
    (this.embeddedClient as any).setAuth(...args);
  }

  clearAuth(...args: Parameters<ConvexReactClient["clearAuth"]>): void {
    (this.embeddedClient as any).clearAuth(...args);
  }

  setAdminAuth(...args: any[]): void {
    (this.embeddedClient as any).setAdminAuth(...args);
  }

  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...argsAndOptions: [args?: FunctionArgs<Query>, options?: WatchQueryOptions]
  ) {
    const [args = {} as FunctionArgs<Query>, options] = argsAndOptions;
    const listeners = new Set<() => void>();
    const subscription = this.embeddedClient.onUpdate(
      query,
      args,
      () => {
        for (const listener of listeners) {
          listener();
        }
      },
      () => {
        for (const listener of listeners) {
          listener();
        }
      },
    ) as unknown as QuerySubscription<Query>;

    return {
      onUpdate(callback: () => void) {
        listeners.add(callback);
        // Schedule after adding the listener so the callback can't fire
        // before the listener set contains it.
        const cancelImmediate =
          subscription.getCurrentValue() !== undefined
            ? scheduleImmediateCallback(() => {
                if (listeners.has(callback)) callback();
              })
            : null;

        return () => {
          listeners.delete(callback);
          cancelImmediate?.();
          if (listeners.size === 0) {
            subscription.unsubscribe();
          }
        };
      },
      localQueryResult() {
        return subscription.getCurrentValue();
      },
      localQueryLogs() {
        return subscription.getQueryLogs?.();
      },
      journal() {
        return options?.journal;
      },
    };
  }

  watchPaginatedQuery<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
    options: WatchPaginatedQueryOptions,
  ) {
    const listeners = new Set<() => void>();
    const subscription = this.embeddedClient.onPaginatedUpdate_experimental(
      query,
      args,
      { initialNumItems: options.initialNumItems },
      () => {
        for (const listener of listeners) {
          listener();
        }
      },
      () => {
        for (const listener of listeners) {
          listener();
        }
      },
    ) as unknown as PaginatedQuerySubscription<Query>;

    return {
      onUpdate(callback: () => void) {
        listeners.add(callback);
        const cancelImmediate =
          subscription.getCurrentValue() !== undefined
            ? scheduleImmediateCallback(() => {
                if (listeners.has(callback)) callback();
              })
            : null;

        return () => {
          listeners.delete(callback);
          cancelImmediate?.();
          if (listeners.size === 0) {
            subscription.unsubscribe();
          }
        };
      },
      localQueryResult() {
        return subscription.getCurrentValue();
      },
    };
  }

  mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...argsAndOptions: ArgsAndOptions<Mutation, MutationOptions>
  ): Promise<Awaited<FunctionReturnType<Mutation>>> {
    return (this.embeddedClient as any).mutation(mutation, ...argsAndOptions);
  }

  action<Action extends FunctionReference<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<Awaited<FunctionReturnType<Action>>> {
    return (this.embeddedClient as any).action(action, ...args);
  }

  query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<Awaited<FunctionReturnType<Query>>> {
    return (this.embeddedClient as any).query(query, ...args);
  }

  connectionState(): ConnectionState {
    return this.embeddedClient.connectionState();
  }

  subscribeToConnectionState(
    cb: (connectionState: ConnectionState) => void,
  ): () => void {
    return this.embeddedClient.subscribeToConnectionState(cb);
  }

  async close(): Promise<void> {
    await super.close();
    await this.embeddedClient.close();
  }
}

/**
 * Wrap a generic embedded `ConvexClient` in a `ConvexReactClient`-compatible
 * adapter.
 *
 * @internal
 */
export function wrapConvexClientForReact(client: ConvexClient) {
  return new EmbeddedConvexReactClient(client);
}

export function unwrapEmbeddedBrowserClient(
  client: ConvexClient | ConvexReactClient,
): ConvexClient {
  if (typeof (client as ConvexClient).onUpdate === "function") {
    return client as ConvexClient;
  }

  const embeddedClient = (client as EmbeddedReactClient)[
    EMBEDDED_BROWSER_CLIENT
  ];
  if (embeddedClient) {
    return embeddedClient;
  }

  throw new Error(
    "[convex-embedded] React helpers require a client created by createConvexReactClient(...) or createConvexClient(...).",
  );
}
