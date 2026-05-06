import type { ConvexClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

import { getFunctionRefName } from "@/client/routing/refs";
import { stableValueKey } from "@/shared/valuekey";

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

type MutationHandler<TItem extends object> = (
  ctx: MutationContext<TItem>,
) => Promise<unknown> | unknown;

export interface ConvexEmbeddedCollectionMutationRefs {
  insert?: FunctionReference<"mutation">;
  update?: FunctionReference<"mutation">;
  delete?: FunctionReference<"mutation">;
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
  /**
   * Convex mutation references to auto-wire collection mutations to.
   *
   * - `insert` is invoked with the new doc as the payload (minus `_id` /
   *   `_creationTime`, which the server assigns).
   * - `update` is invoked with `{ id: original._id, ...changes }`.
   * - `delete` is invoked with `{ id: original._id }`.
   *
   * If a mutation reference's argument shape doesn't match these defaults,
   * pass an explicit `onInsert` / `onUpdate` / `onDelete` handler instead;
   * the explicit handler always takes precedence over `mutations`.
   */
  mutations?: ConvexEmbeddedCollectionMutationRefs;
  onInsert?: MutationHandler<TItem>;
  onUpdate?: MutationHandler<TItem>;
  onDelete?: MutationHandler<TItem>;
}

interface ClientWithMutation {
  onUpdate: (
    query: unknown,
    args: unknown,
    onChange: () => void,
    onError?: (error: Error) => void,
  ) => {
    unsubscribe: () => void;
    getCurrentValue: () => unknown;
  };
  mutation: (ref: unknown, args?: Record<string, unknown>) => Promise<unknown>;
}

const RESERVED_DOC_FIELDS = new Set(["_id", "_creationTime"]);

function stripReservedFields<T extends object>(doc: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (RESERVED_DOC_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function defaultCollectionId<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q>,
): string {
  const refName = getFunctionRefName(query) || "query";
  return `convex-embedded:${refName}:${stableValueKey(args)}`;
}

/**
 * Wire a convex-embedded query into a TanStack DB collection.
 *
 * Returns a `CollectionConfig`-shaped object suitable for passing to
 * `createCollection` from `@tanstack/db`. The returned config:
 *
 * - subscribes to `client.onUpdate(query, args)` and writes each remote push
 *   into the collection's sync source as `insert`/`update`/`delete` deltas;
 * - forwards collection mutations through user-supplied `onInsert` /
 *   `onUpdate` / `onDelete` handlers, or auto-wires them from
 *   `mutations: { insert, update, delete }` (Convex mutation references).
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
  id: string;
  getKey: (doc: TItem) => string;
  sync: { sync: (params: SyncParams<TItem>) => () => void };
  onInsert?: MutationHandler<TItem>;
  onUpdate?: MutationHandler<TItem>;
  onDelete?: MutationHandler<TItem>;
} {
  const getKey = input.getKey ?? ((doc) => doc._id);
  const args = (input.args ?? {}) as FunctionArgs<Q>;
  const client = input.client as unknown as ClientWithMutation;
  const id = input.id ?? defaultCollectionId(input.query, args);

  const insertRef = input.mutations?.insert;
  const updateRef = input.mutations?.update;
  const deleteRef = input.mutations?.delete;

  const onInsert =
    input.onInsert ??
    (insertRef
      ? async ({ transaction }) => {
          for (const m of transaction.mutations) {
            await client.mutation(insertRef, stripReservedFields(m.modified));
          }
        }
      : undefined);

  const onUpdate =
    input.onUpdate ??
    (updateRef
      ? async ({ transaction }) => {
          for (const m of transaction.mutations) {
            await client.mutation(updateRef, {
              id: m.original._id,
              ...m.changes,
            });
          }
        }
      : undefined);

  const onDelete =
    input.onDelete ??
    (deleteRef
      ? async ({ transaction }) => {
          for (const m of transaction.mutations) {
            await client.mutation(deleteRef, { id: m.original._id });
          }
        }
      : undefined);

  return {
    id,
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
    onInsert,
    onUpdate,
    onDelete,
  };
}
