/**
 * convex-embedded/client
 *
 * Client prefetch entry point for SSR and preload flows.
 *
 * Most users should use `createConvexClient()` from
 * `@robelest/convex-embedded/browser` instead of importing from this module
 * directly. Import from `@robelest/convex-embedded/client` when you need
 * `createEmbeddedPrefetch(...)` to build remote-backed prefetched data for SSR.
 *
 * @packageDocumentation
 */

/**
 * Build embedded prefetched data from explicit Convex SSR queries.
 *
 * See {@link CreateEmbeddedPrefetchOptions} for configuration and
 * {@link Prefetch} for the embedded prefetch artifact shape.
 *
 * @see CreateEmbeddedPrefetchOptions
 * @see Prefetch
 * @category Factory
 */
export {
  createEmbeddedPrefetch,
  emptyEmbeddedPrefetch,
} from "@/client/prefetch";

/**
 * Serializable embedded prefetch artifact and options used by
 * `createEmbeddedPrefetch(...)`.
 *
 * @see createEmbeddedPrefetch
 * @category Type
 */
export type {
  CreateEmbeddedPrefetchOptions,
  CreateEmbeddedPrefetchResult,
  EmbeddedPrefetchQuerySpec,
  Prefetch,
} from "@/client/prefetch";
