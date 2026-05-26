import { ConvexHttpClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { convexToJson, jsonToConvex, type JSONValue } from "convex/values";

import { getFunctionName } from "@/shared/refs";

/**
 * Options for {@link preloadQuery}.
 */
export interface PreloadQueryOptions {
  /** Remote Convex deployment URL to run the query against. */
  url: string;
  /** Optional auth token for the server-side read. */
  token?: string | null;
}

/**
 * Opaque payload returned by {@link preloadQuery} and consumed by
 * `usePreloadedQuery` in a client component. Mirrors Convex's `Preloaded<Query>`:
 * it carries the server-fetched value (for SSR render + first client paint) and
 * the query identity needed to hand off to the live local reactive query.
 *
 * @typeParam Query - The preloaded query's function reference.
 */
export interface Preloaded<Query extends FunctionReference<"query">> {
  /** Phantom type link to the query's return type; never read at runtime. */
  readonly __type?: Query;
  /** Convex function name (e.g. `"projects:list"`). */
  readonly _name: string;
  /** `convexToJson`-encoded query args. */
  readonly _argsJSON: JSONValue;
  /** `convexToJson`-encoded server-fetched value. */
  readonly _valueJSON: JSONValue;
}

/**
 * Run a query on the server and return an opaque {@link Preloaded} payload to
 * pass to a client component, mirroring Convex's `preloadQuery`. The client
 * renders the preloaded value first, then transitions to the live local query.
 *
 * Intended for non-paginated queries; paginated queries load client-side
 * (`usePaginatedQuery` is not server-rendered, matching Convex).
 */
export async function preloadQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
  options: PreloadQueryOptions,
): Promise<Preloaded<Query>> {
  const client = new ConvexHttpClient(options.url, { logger: false });
  if (options.token) {
    client.setAuth(options.token);
  }
  const value = await client.query(query, args);
  return {
    _name: getFunctionName(query),
    _argsJSON: convexToJson(args as never),
    _valueJSON: convexToJson(value as never),
  };
}

/**
 * Build a {@link Preloaded} payload with no server value, typed from the query
 * reference. Use it when a server value is unavailable (e.g. SSR without a
 * configured remote URL, or a failed preload) so the type is still inferred and
 * the client can hand off to the live local query. The decoded value is `null`
 * until the local query yields.
 */
export function emptyPreloaded<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): Preloaded<Query> {
  return {
    _name: getFunctionName(query),
    _argsJSON: convexToJson(args as never),
    _valueJSON: null,
  };
}

/**
 * Read the server-fetched value out of a {@link Preloaded} payload (server or
 * client side), e.g. to render SSR markup or branch before mounting a client
 * component. Mirrors Convex's `preloadedQueryResult`.
 */
export function preloadedQueryResult<Query extends FunctionReference<"query">>(
  preloaded: Preloaded<Query>,
): FunctionReturnType<Query> {
  return jsonToConvex(preloaded._valueJSON) as FunctionReturnType<Query>;
}

/**
 * Decode the query name + args from a {@link Preloaded} payload so a framework's
 * reactive `useQuery` can run the live local query that takes over after the
 * server value.
 */
export function preloadedQueryRef<Query extends FunctionReference<"query">>(
  preloaded: Preloaded<Query>,
): { name: string; args: Record<string, unknown> } {
  return {
    name: preloaded._name,
    args: jsonToConvex(preloaded._argsJSON) as Record<string, unknown>,
  };
}
