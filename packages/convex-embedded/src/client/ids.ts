/**
 * ID Map — maps local embedded UUIDs to remote Convex IDs.
 *
 * The sync engine uses this to translate document IDs in mutation args
 * before forwarding to the remote backend. The map is backed by the
 * embedded runtime's `_resolve_id_map` system table, and cached
 * in-memory for fast lookups (no async needed after hydration).
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";

import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import { createLogger } from "@/shared/logger";

const log = createLogger("id-map");

// ---------------------------------------------------------------------------
// System function paths (must match convex-embedded's SYSTEM_FUNCTIONS keys)
// ---------------------------------------------------------------------------

const SYS_ID_MAP_SET = "_system:idMapSet";
const SYS_ID_MAP_GET_ALL = "_system:idMapGetAll";
const SYS_ID_MAP_DELETE = "_system:idMapDelete";

export const ID_MAP_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "idMap",
  scope: "identity",
  version: 1,
};

// ---------------------------------------------------------------------------
// IdMap
// ---------------------------------------------------------------------------

/**
 * Optional local query executor. When provided, hydration reads use this
 * instead of `localClient.query()` to stay on the runtime-first execution path.
 */
export type LocalQueryExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type LocalMutationExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type LocalDocumentPresenceFn = (id: string) => boolean;

export class IdMap {
  /** In-memory cache: localId → remoteId */
  private _cache = new Map<string, string>();

  /** Reverse cache: remoteId → localId (for bidirectional lookups) */
  private _reverse = new Map<string, string>();

  /** The local embedded client for persisting to _resolve_id_map. */
  private _localClient: ConvexClient;

  /** Local query executor used for runtime-first hydration reads. */
  private _queryFn: LocalQueryExecutorFn | null;

  /** Local mutation executor used for runtime-first bookkeeping writes. */
  private _mutationFn: LocalMutationExecutorFn | null;

  /** Active identity namespace for persistence. */
  private _getIdentityKey: (() => string | null) | null;

  /** Synchronous local document presence lookup for active aliasing. */
  private _hasLocalDocumentId: LocalDocumentPresenceFn | null;

  constructor(
    localClient: ConvexClient,
    queryFn?: LocalQueryExecutorFn,
    mutationFn?: LocalMutationExecutorFn,
    getIdentityKey?: () => string | null,
    hasLocalDocumentId?: LocalDocumentPresenceFn,
  ) {
    this._localClient = localClient;
    this._queryFn = queryFn ?? null;
    this._mutationFn = mutationFn ?? null;
    this._getIdentityKey = getIdentityKey ?? null;
    this._hasLocalDocumentId = hasLocalDocumentId ?? null;
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
    const identityKey = this._getIdentityKey?.() ?? null;
    return Fx.run(
      Fx.from({
        ok: () => {
          if (this._queryFn) {
            return this._queryFn(SYS_ID_MAP_GET_ALL, {
              identityKey,
            }) as Promise<
              Array<{
                localId: string;
                remoteId: string;
                table: string;
                identityKey?: string;
              }>
            >;
          }
          return (this._localClient as any).query(SYS_ID_MAP_GET_ALL, {
            identityKey,
          }) as Promise<
            Array<{
              localId: string;
              remoteId: string;
              table: string;
              identityKey?: string;
            }>
          >;
        },
        err: (e) => e as Error,
      }).pipe(
        Fx.tap((entries) =>
          Fx.sync(() => {
            this._cache.clear();
            this._reverse.clear();
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
    const localId = this._reverse.get(remoteId) ?? null;
    if (!localId) {
      return null;
    }
    if (!this._hasLocalDocumentId) {
      return localId;
    }
    return this._hasLocalDocumentId(localId) ? localId : null;
  }

  /**
   * Check if a string is a known local ID.
   */
  hasLocalId(id: string): boolean {
    return this._cache.has(id);
  }

  /**
   * Return all known aliases for a logical document id.
   *
   * Includes the provided id plus its local/remote counterpart when known.
   */
  getAliases(id: string): Set<string> {
    const aliases = new Set<string>([id]);
    const remoteId = this._cache.get(id);
    if (remoteId) {
      aliases.add(remoteId);
    }
    const localId = this.getLocalId(id);
    if (localId) {
      aliases.add(localId);
    }
    return aliases;
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
    const previousRemoteId = this._cache.get(localId);
    if (previousRemoteId !== undefined && previousRemoteId !== remoteId) {
      this._reverse.delete(previousRemoteId);
    }

    this._cache.set(localId, remoteId);
    this._reverse.set(remoteId, localId);

    return Fx.run(
      Fx.from({
        ok: () =>
          this._mutationFn
            ? this._mutationFn(SYS_ID_MAP_SET, {
                localId,
                remoteId,
                table,
                identityKey: this._getIdentityKey?.() ?? null,
              })
            : ((this._localClient as any).mutation(SYS_ID_MAP_SET, {
                localId,
                remoteId,
                table,
                identityKey: this._getIdentityKey?.() ?? null,
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
            ? this._mutationFn(SYS_ID_MAP_DELETE, {
                localId,
                identityKey: this._getIdentityKey?.() ?? null,
              })
            : ((this._localClient as any).mutation(SYS_ID_MAP_DELETE, {
                localId,
                identityKey: this._getIdentityKey?.() ?? null,
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
    return this.translateLocalIdsToRemote(args) as Record<string, unknown>;
  }

  translateLocalIdsToRemote<T>(value: T): T {
    return this._translateValue(value, (candidate) =>
      this._cache.get(candidate),
    ) as T;
  }

  translateRemoteIdsToLocal<T>(value: T): T {
    return this._translateValue(
      value,
      (candidate) => this.getLocalId(candidate) ?? undefined,
    ) as T;
  }

  translateClientIdsToRuntime<T>(value: T): T {
    return this._translateValue(value, (candidate) => {
      const activeLocalId = this.getLocalId(candidate);
      if (activeLocalId) {
        return activeLocalId;
      }
      return this._cache.get(candidate);
    }) as T;
  }

  translateResult<T>(value: T): T {
    return this.translateLocalIdsToRemote(value);
  }

  private _shouldTranslateKey(key: string): boolean {
    return (
      key === "_id" || key === "id" || key.endsWith("Id") || key.endsWith("Ids")
    );
  }

  private _translateValue(
    value: unknown,
    mapString: (value: string) => string | undefined,
    allowStringRewrite = true,
  ): unknown {
    if (typeof value === "string") {
      return allowStringRewrite ? (mapString(value) ?? value) : value;
    }

    if (Array.isArray(value)) {
      return value.map((item) =>
        this._translateValue(item, mapString, allowStringRewrite),
      );
    }

    if (
      this._isOpaqueValue(value) ||
      value === null ||
      typeof value !== "object"
    ) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        this._translateValue(
          entryValue,
          mapString,
          this._shouldTranslateKey(key),
        ),
      ]),
    );
  }

  private _isOpaqueValue(value: unknown): boolean {
    return value instanceof ArrayBuffer || value instanceof Uint8Array;
  }
}
