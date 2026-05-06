import type { ConvexClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

type Doc = Record<string, unknown> & { _id: string };

interface CollectionTransactionMutation<TItem extends object> {
  original: TItem;
  modified: TItem;
  changes: Partial<TItem>;
  key: string;
}

interface CollectionTransaction<TItem extends object> {
  mutations: Array<CollectionTransactionMutation<TItem>>;
}

interface SyncWriteOp<TItem extends object> {
  type: "insert" | "update" | "delete";
  value: TItem;
}

interface SyncParams<TItem extends object> {
  begin: () => void;
  write: (op: SyncWriteOp<TItem>) => void;
  commit: () => void;
  markReady: () => void;
  collection: unknown;
}

interface MutationContext<TItem extends object> {
  transaction: CollectionTransaction<TItem>;
  collection: unknown;
}

export interface ConvexEmbeddedCollectionOptions<
  TItem extends object,
  Q extends FunctionReference<"query">,
> {
  client: ConvexClient;
  query: Q;
  args?: FunctionArgs<Q>;
  id?: string;
  getKey?: (doc: TItem) => string;
  onInsert?: (ctx: MutationContext<TItem>) => Promise<unknown> | unknown;
  onUpdate?: (ctx: MutationContext<TItem>) => Promise<unknown> | unknown;
  onDelete?: (ctx: MutationContext<TItem>) => Promise<unknown> | unknown;
}

interface ClientWithOnUpdate {
  onUpdate: (
    query: unknown,
    args: unknown,
    onChange: () => void,
    onError?: (error: Error) => void,
  ) => {
    unsubscribe: () => void;
    getCurrentValue: () => unknown;
  };
}

/**
 * Wire a convex-embedded query into a TanStack DB collection.
 *
 * Returns a `CollectionConfig`-shaped object suitable for passing to
 * `createCollection` from `@tanstack/db`. The returned config:
 *
 * - subscribes to `client.onUpdate(query, args)` and writes each remote push
 *   into the collection's sync source as `insert`/`update`/`delete` deltas;
 * - forwards collection mutations through user-supplied `onInsert`/
 *   `onUpdate`/`onDelete` handlers (which typically call
 *   `client.mutation(...)`).
 *
 * convex-embedded remains the sync engine (server reactivity, durable replay,
 * auth, SQLite). TanStack DB owns the reactive view layer (live queries,
 * optimistic UI). They compose; neither has to absorb the other.
 *
 * `@tanstack/db` is an optional peer dependency — install it only if you
 * need this seam.
 */
export function convexEmbeddedCollectionOptions<
  Q extends FunctionReference<"query">,
  TItem extends Doc = FunctionReturnType<Q> extends Array<infer Item>
    ? Item extends Doc
      ? Item
      : Doc
    : Doc,
>(
  input: ConvexEmbeddedCollectionOptions<TItem, Q>,
): {
  id?: string;
  getKey: (doc: TItem) => string;
  sync: { sync: (params: SyncParams<TItem>) => () => void };
  onInsert?: (ctx: MutationContext<TItem>) => Promise<unknown> | unknown;
  onUpdate?: (ctx: MutationContext<TItem>) => Promise<unknown> | unknown;
  onDelete?: (ctx: MutationContext<TItem>) => Promise<unknown> | unknown;
} {
  const getKey = input.getKey ?? ((doc) => doc._id);
  const args = (input.args ?? {}) as FunctionArgs<Q>;
  const client = input.client as unknown as ClientWithOnUpdate;

  return {
    id: input.id,
    getKey,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        let seen: Map<string, TItem> = new Map();
        let firstPush = true;

        const subscription = client.onUpdate(input.query, args, () => {
          const value = subscription.getCurrentValue();
          if (!Array.isArray(value)) {
            markReady();
            return;
          }
          const next = new Map<string, TItem>();
          for (const item of value as TItem[]) {
            next.set(getKey(item), item);
          }

          begin();
          for (const [key, item] of next) {
            const prior = seen.get(key);
            if (prior === undefined) {
              write({ type: "insert", value: item });
            } else if (prior !== item) {
              write({ type: "update", value: item });
            }
          }
          for (const [key, item] of seen) {
            if (!next.has(key)) {
              write({ type: "delete", value: item });
            }
          }
          commit();

          seen = next;
          if (firstPush) {
            firstPush = false;
            markReady();
          }
        });

        return () => subscription.unsubscribe();
      },
    },
    onInsert: input.onInsert,
    onUpdate: input.onUpdate,
    onDelete: input.onDelete,
  };
}
