import type {
  ConnectionState,
  ConvexClient,
  MutationOptions,
  PaginationStatus,
  QueryJournal,
} from "convex/browser";
import { ConvexReactClient } from "convex/react";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
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

type LoadMoreOfPaginatedQuery = (numItems: number) => void;

export class ExpoConvexReactClient extends ConvexReactClient {
  constructor(private readonly embeddedClient: ConvexClient) {
    super("https://embedded.local", { unsavedChangesWarning: false });
  }

  watchQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...argsAndOptions: [args?: FunctionArgs<Query>, options?: WatchQueryOptions]
  ) {
    const [args = {} as FunctionArgs<Query>, options] = argsAndOptions;
    const client = this.embeddedClient;
    const subscription = client.onUpdate(query, args, () => {}) as any;

    return {
      onUpdate(callback: () => void) {
        const live = client.onUpdate(query, args, () => callback()) as any;
        return () => live.unsubscribe();
      },
      localQueryResult() {
        return subscription.getCurrentValue() as
          | FunctionReturnType<Query>
          | undefined;
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
    const client = this.embeddedClient;
    const subscription = client.onPaginatedUpdate_experimental(
      query,
      args,
      { initialNumItems: options.initialNumItems },
      () => {},
    ) as any;

    return {
      onUpdate(callback: () => void) {
        const live = client.onPaginatedUpdate_experimental(
          query,
          args,
          { initialNumItems: options.initialNumItems },
          () => callback(),
        ) as any;
        return () => live.unsubscribe();
      },
      localQueryResult():
        | {
            results: FunctionReturnType<Query>[];
            status: PaginationStatus;
            loadMore: LoadMoreOfPaginatedQuery;
          }
        | undefined {
        const value = subscription.getCurrentValue() as
          | {
              page: FunctionReturnType<Query>[];
              isDone: boolean;
              continueCursor: string;
              loadMore: LoadMoreOfPaginatedQuery;
            }
          | undefined;

        if (!value) {
          return undefined;
        }

        return {
          results: value.page,
          status: value.isDone ? "Exhausted" : "CanLoadMore",
          loadMore: value.loadMore,
        };
      },
    };
  }

  mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    options?: MutationOptions,
  ): Promise<Awaited<FunctionReturnType<Mutation>>> {
    return this.embeddedClient.mutation(mutation, args, options);
  }

  action<Action extends FunctionReference<"action">>(
    action: Action,
    args: FunctionArgs<Action>,
  ): Promise<Awaited<FunctionReturnType<Action>>> {
    return this.embeddedClient.action(action, args);
  }

  query<Query extends FunctionReference<"query">>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<Awaited<FunctionReturnType<Query>>> {
    return this.embeddedClient.query(query, args);
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
    await this.embeddedClient.close();
  }
}

export function wrapConvexClientForReact(client: ConvexClient) {
  return new ExpoConvexReactClient(client);
}
