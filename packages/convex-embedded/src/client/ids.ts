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

import type { ConvexClient } from "convex/browser";

import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import { createLogger } from "@/shared/logger";

const log = createLogger("id-map");

const SYS_ID_MAP_SET = "_system:idMapSet";
const SYS_ID_MAP_GET_ALL = "_system:idMapGetAll";
const SYS_ID_MAP_DELETE = "_system:idMapDelete";

export const ID_MAP_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "idMap",
  scope: "identity",
  version: 1,
};

/**
 * Optional local query executor. When provided, hydration reads use
 * this instead of `localClient.query()` to stay on the runtime-first
 * execution path. Used by {@link IdMap}, the mutation pending queue,
 * and the upload pending queue.
 *
 * @public
 */
export type LocalQueryExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Optional local mutation executor. Same shape and motivation as
 * {@link LocalQueryExecutorFn} but for write paths.
 *
 * @public
 */
export type LocalMutationExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type LocalDocumentPresenceFn = (id: string) => boolean;

/**
 * The embedded ConvexClient invoked with raw `_system:*` path strings, which
 * the public generic `query`/`mutation` signatures don't accept.
 */
interface SystemPathClient {
  query(path: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(path: string, args: Record<string, unknown>): Promise<unknown>;
}

export class IdMap {
  private _cache = new Map<string, string>();
  private _reverse = new Map<string, string>();
  private _localClient: ConvexClient;
  private _queryFn: LocalQueryExecutorFn | null;
  private _mutationFn: LocalMutationExecutorFn | null;
  private _getIdentityKey: (() => string | null) | null;
  private _hasLocalDocumentId: LocalDocumentPresenceFn | null;
  private _schemaIdFields: Set<string>;

  private get _sysClient(): SystemPathClient {
    return this._localClient as unknown as SystemPathClient;
  }

  constructor(
    localClient: ConvexClient,
    queryFn?: LocalQueryExecutorFn,
    mutationFn?: LocalMutationExecutorFn,
    getIdentityKey?: () => string | null,
    hasLocalDocumentId?: LocalDocumentPresenceFn,
    schemaIdFields?: Set<string>,
  ) {
    this._localClient = localClient;
    this._queryFn = queryFn ?? null;
    this._mutationFn = mutationFn ?? null;
    this._getIdentityKey = getIdentityKey ?? null;
    this._hasLocalDocumentId = hasLocalDocumentId ?? null;
    this._schemaIdFields = schemaIdFields ?? new Set();
  }

  /**
   * Load all persisted mappings from the embedded DB into the cache.
   * Must be called (and awaited) before using `getRemoteId` or
   * `translateArgs`.
   */
  async hydrate(): Promise<void> {
    const identityKey = this._getIdentityKey?.() ?? null;
    try {
      const entries = await (async () => {
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
        return this._sysClient.query(SYS_ID_MAP_GET_ALL, {
          identityKey,
        }) as Promise<
          Array<{
            localId: string;
            remoteId: string;
            table: string;
            identityKey?: string;
          }>
        >;
      })();

      this._cache.clear();
      this._reverse.clear();
      for (const entry of entries) {
        this._cache.set(entry.localId, entry.remoteId);
        this._reverse.set(entry.remoteId, entry.localId);
      }
      log.info(`id-map: hydrated ${entries.length} mapping(s)`);
    } catch (err) {
      log.warn("id-map: hydration failed (starting with empty map)", err);
    }
  }

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

  get size(): number {
    return this._cache.size;
  }

  /**
   * Record a mapping from local UUID to remote Convex ID.
   *
   * Updates the in-memory cache immediately and persists to the
   * embedded DB's `_resolve_id_map` system table.
   */
  async set(localId: string, remoteId: string, table: string): Promise<void> {
    const previousRemoteId = this._cache.get(localId);
    if (previousRemoteId !== undefined && previousRemoteId !== remoteId) {
      this._reverse.delete(previousRemoteId);
    }

    this._cache.set(localId, remoteId);
    this._reverse.set(remoteId, localId);

    try {
      await (this._mutationFn
        ? this._mutationFn(SYS_ID_MAP_SET, {
            localId,
            remoteId,
            table,
            identityKey: this._getIdentityKey?.() ?? null,
          })
        : (this._sysClient.mutation(SYS_ID_MAP_SET, {
            localId,
            remoteId,
            table,
            identityKey: this._getIdentityKey?.() ?? null,
          }) as Promise<unknown>));

      log.debug(`id-map: set ${localId} → ${remoteId} (table: ${table})`);
    } catch (err) {
      log.warn("id-map: failed to persist mapping", err);
    }
  }

  /**
   * Remove a mapping by local ID.
   */
  async delete(localId: string): Promise<void> {
    const remoteId = this._cache.get(localId);
    this._cache.delete(localId);
    if (remoteId) {
      this._reverse.delete(remoteId);
    }

    try {
      await (this._mutationFn
        ? this._mutationFn(SYS_ID_MAP_DELETE, {
            localId,
            identityKey: this._getIdentityKey?.() ?? null,
          })
        : (this._sysClient.mutation(SYS_ID_MAP_DELETE, {
            localId,
            identityKey: this._getIdentityKey?.() ?? null,
          }) as Promise<unknown>));
    } catch (err) {
      log.warn("id-map: failed to delete mapping", err);
    }
  }

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

  private _getActiveLocalId(remoteId: string): string | undefined {
    if (this._hasLocalDocumentId?.(remoteId)) {
      return undefined;
    }
    const localId = this.getLocalId(remoteId) ?? undefined;
    if (!localId) {
      return undefined;
    }
    if (!this._hasLocalDocumentId || this._hasLocalDocumentId(localId)) {
      return localId;
    }
    return undefined;
  }

  translateRemoteIdsToLocal<T>(value: T): T {
    return this._translateValue(value, (candidate) =>
      this._getActiveLocalId(candidate),
    ) as T;
  }

  translateClientIdsToRuntime<T>(value: T): T {
    return this._translateValue(value, (candidate) => {
      const activeLocalId = this._getActiveLocalId(candidate);
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
    if (
      key === "_id" ||
      key === "id" ||
      key.endsWith("Id") ||
      key.endsWith("Ids")
    ) {
      return true;
    }
    return this._schemaIdFields.has(key);
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
      let changed = false;
      const translated = value.map((item) => {
        const result = this._translateValue(
          item,
          mapString,
          allowStringRewrite,
        );
        if (result !== item) changed = true;
        return result;
      });
      return changed ? translated : value;
    }

    if (
      this._isOpaqueValue(value) ||
      value === null ||
      typeof value !== "object"
    ) {
      return value;
    }

    const entries = Object.entries(value);
    let changed = false;
    const translated = entries.map(([key, entryValue]) => {
      const result = this._translateValue(
        entryValue,
        mapString,
        this._shouldTranslateKey(key),
      );
      if (result !== entryValue) changed = true;
      return [key, result] as const;
    });
    return changed ? Object.fromEntries(translated) : value;
  }

  private _isOpaqueValue(value: unknown): boolean {
    return value instanceof ArrayBuffer || value instanceof Uint8Array;
  }
}

function validatorContainsId(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "id" || v.type === "id") return true;
  if (v.kind === "union" || v.type === "union") {
    const members = (v.members ?? v.value) as unknown[] | undefined;
    return Array.isArray(members) && members.some(validatorContainsId);
  }
  if (v.kind === "array" || v.type === "array") {
    return validatorContainsId(v.value);
  }
  return false;
}

export function extractSchemaIdFields(
  shapes: Iterable<Record<string, unknown>>,
): Set<string> {
  const fields = new Set<string>();
  for (const shape of shapes) {
    for (const [name, value] of Object.entries(shape)) {
      if (validatorContainsId(value)) {
        fields.add(name);
      }
    }
  }
  return fields;
}
