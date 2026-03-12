/**
 * ID Map — maps local embedded UUIDs to remote Convex IDs.
 *
 * The monitor uses this to translate document IDs in mutation args
 * before forwarding to the remote backend. The map is backed by the
 * embedded runtime's `_resolve_id_map` system table, and cached
 * in-memory for fast lookups (no async needed after hydration).
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";

import { createLogger } from "@/shared/logger";

const log = createLogger("id-map");

// ---------------------------------------------------------------------------
// System function paths (must match convex-embedded's SYSTEM_FUNCTIONS keys)
// ---------------------------------------------------------------------------

const SYS_ID_MAP_SET = "_system:idMapSet";
const SYS_ID_MAP_GET_ALL = "_system:idMapGetAll";
const SYS_ID_MAP_DELETE = "_system:idMapDelete";

// ---------------------------------------------------------------------------
// IdMap
// ---------------------------------------------------------------------------

/**
 * Optional direct query function that bypasses the ConvexClient
 * subscription machinery. When provided, hydration reads use this
 * instead of `localClient.query()` — avoiding the `Invalid start
 * version` bug caused by engine hydration subscriptions colliding
 * with the app's `useQuery` version counter.
 */
export type DirectQueryFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type DirectMutationFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export class IdMap {
  /** In-memory cache: localId → remoteId */
  private _cache = new Map<string, string>();

  /** Reverse cache: remoteId → localId (for bidirectional lookups) */
  private _reverse = new Map<string, string>();

  /** The local embedded client for persisting to _resolve_id_map. */
  private _localClient: ConvexClient;

  /** Direct query bypass (avoids subscription version conflicts). */
  private _queryFn: DirectQueryFn | null;

  /** Direct mutation bypass (avoids patched ConvexClient.mutation). */
  private _mutationFn: DirectMutationFn | null;

  constructor(
    localClient: ConvexClient,
    queryFn?: DirectQueryFn,
    mutationFn?: DirectMutationFn,
  ) {
    this._localClient = localClient;
    this._queryFn = queryFn ?? null;
    this._mutationFn = mutationFn ?? null;
  }

  // -----------------------------------------------------------------------
  // Hydration
  // -----------------------------------------------------------------------

  /**
   * Load all persisted mappings from the embedded DB into the cache.
   * Must be called (and awaited) before using `getRemoteId` or
   * `translateArgs`.
   */
  hydrate(): Promise<void> {
    return Fx.run(
      Fx.from({
        ok: () => {
          if (this._queryFn) {
            return this._queryFn(SYS_ID_MAP_GET_ALL, {}) as Promise<
              Array<{ localId: string; remoteId: string; table: string }>
            >;
          }
          return (this._localClient as any).query(
            SYS_ID_MAP_GET_ALL,
            {},
          ) as Promise<
            Array<{ localId: string; remoteId: string; table: string }>
          >;
        },
        err: (e) => e as Error,
      }).pipe(
        Fx.tap((entries) =>
          Fx.sync(() => {
            for (const entry of entries) {
              this._cache.set(entry.localId, entry.remoteId);
              this._reverse.set(entry.remoteId, entry.localId);
            }
            log.info(`id-map: hydrated ${entries.length} mapping(s)`);
          }),
        ),
        Fx.inspect((err) =>
          Fx.sync(() =>
            log.warn("id-map: hydration failed (starting with empty map)", err),
          ),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Read
  // -----------------------------------------------------------------------

  /**
   * Look up the remote ID for a local UUID.
   * Synchronous cache lookup — no async needed after hydration.
   */
  getRemoteId(localId: string): string | null {
    return this._cache.get(localId) ?? null;
  }

  /**
   * Look up the local UUID for a remote ID.
   */
  getLocalId(remoteId: string): string | null {
    return this._reverse.get(remoteId) ?? null;
  }

  /**
   * Check if a string is a known local ID.
   */
  hasLocalId(id: string): boolean {
    return this._cache.has(id);
  }

  /** Number of cached mappings. */
  get size(): number {
    return this._cache.size;
  }

  // -----------------------------------------------------------------------
  // Write
  // -----------------------------------------------------------------------

  /**
   * Record a mapping from local UUID to remote Convex ID.
   *
   * Updates the in-memory cache immediately and persists to the
   * embedded DB's `_resolve_id_map` system table.
   */
  set(localId: string, remoteId: string, table: string): Promise<void> {
    this._cache.set(localId, remoteId);
    this._reverse.set(remoteId, localId);

    return Fx.run(
      Fx.from({
        ok: () =>
          this._mutationFn
            ? this._mutationFn(SYS_ID_MAP_SET, { localId, remoteId, table })
            : ((this._localClient as any).mutation(SYS_ID_MAP_SET, {
                localId,
                remoteId,
                table,
              }) as Promise<unknown>),
        err: (e) => e as Error,
      }).pipe(
        Fx.tap(() =>
          Fx.sync(() =>
            log.debug(`id-map: set ${localId} → ${remoteId} (table: ${table})`),
          ),
        ),
        Fx.inspect((err) =>
          Fx.sync(() => log.warn("id-map: failed to persist mapping", err)),
        ),
        // Cache is already updated — persistence failure is non-fatal.
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  /**
   * Remove a mapping by local ID.
   */
  delete(localId: string): Promise<void> {
    const remoteId = this._cache.get(localId);
    this._cache.delete(localId);
    if (remoteId) {
      this._reverse.delete(remoteId);
    }

    return Fx.run(
      Fx.from({
        ok: () =>
          this._mutationFn
            ? this._mutationFn(SYS_ID_MAP_DELETE, { localId })
            : ((this._localClient as any).mutation(SYS_ID_MAP_DELETE, {
                localId,
              }) as Promise<unknown>),
        err: (e) => e as Error,
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => log.warn("id-map: failed to delete mapping", err)),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Translation
  // -----------------------------------------------------------------------

  /**
   * Deep-walk `args` and replace any string value that is a known local
   * ID with its remote counterpart.
   *
   * Does not use regex — checks each string value against the cache Map.
   * Returns a new object (does not mutate the original).
   */
  translateArgs(args: Record<string, unknown>): Record<string, unknown> {
    return this._translateValue(args) as Record<string, unknown>;
  }

  private _translateValue(value: unknown): unknown {
    if (typeof value === "string") {
      return this._cache.get(value) ?? value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this._translateValue(item));
    }

    if (value !== null && typeof value === "object") {
      // Skip special Convex value types (ArrayBuffer, Blob, etc.)
      if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
        return value;
      }

      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this._translateValue(val);
      }
      return result;
    }

    // Primitives (number, boolean, null, undefined)
    return value;
  }
}
