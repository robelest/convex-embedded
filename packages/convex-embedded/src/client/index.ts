/**
 * convex-embedded/client
 *
 * Client SSR entry point: a per-query preload that mirrors Convex's
 * `preloadQuery` / `usePreloadedQuery`.
 *
 * Most users should use `createConvexClient()` from
 * `@robelest/convex-embedded/browser` instead of importing from this module
 * directly. Import from `@robelest/convex-embedded/client` when you need
 * `preloadQuery(...)` to server-render a query and hand it off to the live
 * local reactive query on the client.
 *
 * @packageDocumentation
 */

export {
  preloadQuery,
  preloadedQueryResult,
  preloadedQueryRef,
  emptyPreloaded,
} from "@/client/preload";

export type { Preloaded, PreloadQueryOptions } from "@/client/preload";
