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
import { startTransition } from "react";

import { createLogger } from "@/shared/logger";
import {
  createDefaultWorkScheduler,
  type WorkPriority,
  type WorkScheduler,
} from "@/shared/work";

const log = createLogger("react");

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

interface EmbeddedClientInternals {
  setAuth(...args: unknown[]): void;
  clearAuth(...args: unknown[]): void;
  setAdminAuth(...args: unknown[]): void;
  mutation(...args: unknown[]): Promise<unknown>;
  action(...args: unknown[]): Promise<unknown>;
  query(...args: unknown[]): Promise<unknown>;
  getWorkScheduler?(): WorkScheduler | undefined;
  setWorkScheduler?(scheduler: WorkScheduler | null): void;
  peekCurrentValue?(ref: unknown, args: unknown): unknown;
  peekPaginatedCurrentValue?(
    ref: unknown,
    args: unknown,
    options: { initialNumItems: number },
  ): unknown;
}

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
    const augmented = embeddedClient as unknown as EmbeddedClientInternals;
    const base = augmented.getWorkScheduler?.() ?? createDefaultWorkScheduler();
    const reactScheduler: WorkScheduler = {
      post(priority: WorkPriority, work: () => void) {
        if (priority === "user-visible") {
          base.post(priority, () => startTransition(work));
          return;
        }
        base.post(priority, work);
      },
      yield: () => base.yield(),
      shouldYield: () => base.shouldYield(),
    };
    augmented.setWorkScheduler?.(reactScheduler);
  }

  private get _internals(): EmbeddedClientInternals {
    return this.embeddedClient as unknown as EmbeddedClientInternals;
  }

  setAuth(...args: Parameters<ConvexReactClient["setAuth"]>): void {
    this._internals.setAuth(...args);
  }

  clearAuth(...args: Parameters<ConvexReactClient["clearAuth"]>): void {
    this._internals.clearAuth(...args);
  }

  setAdminAuth(...args: unknown[]): void {
    this._internals.setAdminAuth(...args);
  }

  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...argsAndOptions: [args?: FunctionArgs<Query>, options?: WatchQueryOptions]
  ) {
    const [args = {} as FunctionArgs<Query>, options] = argsAndOptions;
    const embedded = this.embeddedClient;
    const listeners = new Set<() => void>();
    let subscription: QuerySubscription<Query> | null = null;

    const ensureSubscription = (): QuerySubscription<Query> => {
      if (subscription !== null) return subscription;
      subscription = embedded.onUpdate(
        query,
        args,
        () => {
          const ts = globalThis.performance?.now?.() ?? Date.now();
          log.debug(
            `react-notify listeners=${listeners.size} ts=${ts.toFixed(1)}`,
          );
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
      return subscription;
    };

    return {
      onUpdate(callback: () => void) {
        const sub = ensureSubscription();
        listeners.add(callback);
        const cancelImmediate =
          sub.getCurrentValue() !== undefined
            ? scheduleImmediateCallback(() => {
                if (listeners.has(callback)) callback();
              })
            : null;

        return () => {
          listeners.delete(callback);
          cancelImmediate?.();
          if (listeners.size === 0 && subscription !== null) {
            subscription.unsubscribe();
            subscription = null;
          }
        };
      },
      localQueryResult() {
        if (subscription !== null) {
          return subscription.getCurrentValue();
        }
        const peek = (embedded as unknown as EmbeddedClientInternals)
          .peekCurrentValue;
        return typeof peek === "function" ? peek(query, args) : undefined;
      },
      localQueryLogs() {
        return subscription?.getQueryLogs?.();
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
    const embedded = this.embeddedClient;
    const listeners = new Set<() => void>();
    let subscription: PaginatedQuerySubscription<Query> | null = null;

    const ensureSubscription = (): PaginatedQuerySubscription<Query> => {
      if (subscription !== null) return subscription;
      subscription = embedded.onPaginatedUpdate_experimental(
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
      return subscription;
    };

    return {
      onUpdate(callback: () => void) {
        const sub = ensureSubscription();
        listeners.add(callback);
        const cancelImmediate =
          sub.getCurrentValue() !== undefined
            ? scheduleImmediateCallback(() => {
                if (listeners.has(callback)) callback();
              })
            : null;

        return () => {
          listeners.delete(callback);
          cancelImmediate?.();
          if (listeners.size === 0 && subscription !== null) {
            subscription.unsubscribe();
            subscription = null;
          }
        };
      },
      localQueryResult() {
        if (subscription !== null) {
          return subscription.getCurrentValue();
        }
        const peek = (embedded as unknown as EmbeddedClientInternals)
          .peekPaginatedCurrentValue;
        return typeof peek === "function"
          ? peek(query, args, { initialNumItems: options.initialNumItems })
          : undefined;
      },
    };
  }

  mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...argsAndOptions: ArgsAndOptions<Mutation, MutationOptions>
  ): Promise<Awaited<FunctionReturnType<Mutation>>> {
    return this._internals.mutation(mutation, ...argsAndOptions) as Promise<
      Awaited<FunctionReturnType<Mutation>>
    >;
  }

  action<Action extends FunctionReference<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<Awaited<FunctionReturnType<Action>>> {
    return this._internals.action(action, ...args) as Promise<
      Awaited<FunctionReturnType<Action>>
    >;
  }

  query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<Awaited<FunctionReturnType<Query>>> {
    return this._internals.query(query, ...args) as Promise<
      Awaited<FunctionReturnType<Query>>
    >;
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
