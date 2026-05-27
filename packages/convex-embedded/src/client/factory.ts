/**
 * Platform-agnostic embedded client factory.
 *
 * This module composes runtime, storage, auth, and remote sync into a
 * standard `ConvexClient` instance.
 */

import type { ConvexClient } from "convex/browser";
import type { BaseConvexClientOptions } from "convex/browser";

import {
  type AuthEntry,
  type AuthOptions,
  type AuthState,
  AUTH_STATE_STORE_MIGRATIONS,
  deleteAuthEntry,
  initializeActiveIdentityKey,
  installAuthController,
  refreshAuthFromSource,
  registerAuthEntry,
} from "@/client/auth";
import { createEmbeddedQueryCache, type EmbeddedQueryCache } from "@/client/cache";
import { EmbeddedClient } from "@/client/embedded";
import {
  deleteEmbeddedClientEntry,
  registerEmbeddedClientEntry,
} from "@/client/entry";
import { ID_MAP_STORE_MIGRATIONS } from "@/client/ids";
import {
  attachResolve,
  deletePullEntry,
  type RemoteOptions,
  type PullAttachment,
} from "@/client/remote";
import { discoverPendingReplayMetadata } from "@/client/replay";
import { asError, getFunctionRefName } from "@/client/routing/refs";
import { type ConvexInput, normalizeModuleRegistry } from "@/kernel/modules";
import { STORAGE_METADATA_STORE_MIGRATIONS } from "@/kernel/syscalls";
import { createAmbientCryptoProvider } from "@/runtime/crypto";
import { createEmbeddedRuntime } from "@/runtime/embedded";
import type {
  EmbeddedRuntime,
  EmbeddedRuntimeOptions,
} from "@/runtime/embedded";
import { createLoadCoordinator } from "@/runtime/load";
import {
  PENDING_STORE_MIGRATIONS,
  PENDING_UPLOADS_STORE_MIGRATIONS,
} from "@/runtime/migrations/pending";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import { createQueryCacheStorage } from "@/runtime/sqlite/cache";
import type { QueryCacheStorage } from "@/runtime/sqlite/cache";
import { SCHEDULED_FUNCTIONS_STORE_MIGRATIONS } from "@/scheduler/executor";
import { createLogger } from "@/shared/logger";
import { extractEmbeddedTableDefinitions } from "@/shared/schema";
import type { PendingReplayMeta } from "@/shared/symbols";
import type { StorageAdapter } from "@/storage/adapter";
import type { SqliteDriver } from "@/storage/sqlite/driver";
import { createPubSub, type PubSub } from "@/utils/pubsub";
import { createDisposableScope } from "@/utils/scope";

const log = createLogger("setup");

/**
 * Pull the raw SQLite driver out of a storage adapter when one is present.
 *
 * The embedded `SqliteAdapter` exposes `getDriver()` so callers can reuse
 * the same SQLite connection for sibling persistence concerns (here: the
 * disk-backed query result cache). Non-SQLite adapters omit the method and
 * we fall back to a memory-only cache.
 */
function trySqliteDriverFor(
  adapter: StorageAdapter | null,
): SqliteDriver | null {
  if (!adapter) return null;
  const getDriver = (adapter as { getDriver?: () => SqliteDriver }).getDriver;
  if (typeof getDriver !== "function") return null;
  try {
    return getDriver.call(adapter);
  } catch {
    return null;
  }
}

interface PlatformConfig {
  readonly runtime: EmbeddedRuntime;
  readonly platform: EmbeddedPlatformAdapter;
  readonly name: string;
  readonly sessionBroadcast: ReturnType<
    NonNullable<EmbeddedPlatformAdapter["createSessionBroadcast"]>
  > | null;
  readonly writeBroadcast: ReturnType<
    NonNullable<EmbeddedPlatformAdapter["createWriteBroadcast"]>
  > | null;
  readonly connectivity: EmbeddedPlatformAdapter["connectivity"];
  readonly processorId: string | undefined;
  readonly clientClosed: () => boolean;
}

function installStorageSurface(
  platformConfig: PlatformConfig,
): { close(): void } | null {
  const { runtime, platform, name, clientClosed } = platformConfig;

  if (clientClosed()) {
    log.info("skipping storage surface install after client close");
    return null;
  }

  const storageSurface =
    platform.createStorageSurface?.({
      runtime,
      name,
      crypto: runtime.crypto,
    }) ?? null;

  if (clientClosed()) {
    storageSurface?.close();
    return null;
  }

  runtime.setStorageSurface(storageSurface);
  log.info(
    `storage surface installed after storage attach (${storageSurface ? "enabled" : "none"})`,
  );
  return storageSurface;
}

function createAuthEntry(
  platformConfig: PlatformConfig,
): Pick<
  AuthEntry,
  | "runtime"
  | "getPendingCount"
  | "refreshSync"
  | "activeIdentityKey"
  | "sessionBroadcast"
  | "state"
  | "stateHub"
> {
  const { runtime, sessionBroadcast } = platformConfig;
  return {
    runtime,
    getPendingCount: () => 0,
    refreshSync: () => Promise.resolve(),
    activeIdentityKey: null,
    sessionBroadcast: sessionBroadcast ?? undefined,
    state: { status: "idle" } as AuthState,
    stateHub: createPubSub<AuthState>(),
  };
}

function createPullAttachment(input: {
  client: ConvexClient;
  authEntry: AuthEntry;
  resolveOpts: RemoteOptions;
  convex: ConvexInput;
  getIdentityKeyForSync: () => string | null;
  getReplayPayloadVersion: (refName: string) => number;
  platformConfig: PlatformConfig;
  cache: EmbeddedQueryCache;
  getCacheStorage: () => QueryCacheStorage | null;
  knownTables: ReadonlySet<string>;
  uploadFetch?: typeof globalThis.fetch;
  leaderLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}): PullAttachment {
  const { runtime, connectivity, processorId } = input.platformConfig;

  return attachResolve({
    client: input.client,
    runtime,
    authEntry: input.authEntry,
    resolveOpts: input.resolveOpts,
    convex: input.convex,
    getIdentityKeyForSync: input.getIdentityKeyForSync,
    getReplayPayloadVersion: input.getReplayPayloadVersion,
    connectivity,
    processorId,
    cache: input.cache,
    getCacheStorage: input.getCacheStorage,
    knownTables: input.knownTables,
    uploadFetch: input.uploadFetch,
    leaderLock: input.leaderLock,
  });
}

function installSessionFanout(
  authEntry: AuthEntry,
  platformConfig: PlatformConfig,
): () => void {
  const { sessionBroadcast } = platformConfig;
  if (!sessionBroadcast) {
    return () => {};
  }

  return sessionBroadcast.onNotification(() => {
    void refreshAuthFromSource(authEntry);
  });
}

export interface EmbeddedClientOptions {
  convex: ConvexInput;
  schema?: unknown;
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;
  name?: string;
  remote?: RemoteOptions;
  auth?: AuthOptions;
}

export function createEmbeddedClient(input: {
  options: EmbeddedClientOptions;
  platform: EmbeddedPlatformAdapter;
}): ConvexClient {
  const { options, platform } = input;
  const dbName = options.name ?? "convex-embedded";
  const tableDefinitions = extractEmbeddedTableDefinitions(options.schema);
  const convex = {
    ...options.convex,
    modules: normalizeModuleRegistry(options.convex.modules),
  } satisfies ConvexInput;

  const sessionBroadcast =
    platform.createSessionBroadcast?.({ name: dbName }) ?? null;
  const writeBroadcast =
    platform.createWriteBroadcast?.({ name: dbName }) ?? null;
  const processorId = platform.processorIdentity?.getProcessorId({
    name: dbName,
  });

  const runtime = createEmbeddedRuntime({
    convex,
    schema: options.schema as EmbeddedRuntimeOptions["schema"],
    crypto: platform.crypto ?? createAmbientCryptoProvider(),
    verifyToken: options.auth?.verifyToken,
    writeBroadcast: writeBroadcast ?? undefined,
  });

  let clientClosed = false;
  let installedStorageSurface: { close(): void } | null = null;
  let client!: EmbeddedClient;
  const rootScope = createDisposableScope();

  const platformConfig: PlatformConfig = {
    runtime,
    platform,
    name: dbName,
    sessionBroadcast,
    writeBroadcast,
    connectivity: platform.connectivity,
    processorId,
    clientClosed: () => clientClosed,
  };

  runtime.setStorageSurface(null);

  const replayMetadata = new Map<string, PendingReplayMeta>();
  let replayMetadataReady: Promise<Map<string, PendingReplayMeta>> | null =
    null;
  const loadReplayMetadata = () => {
    replayMetadataReady ??= discoverPendingReplayMetadata(convex.modules).then(
      (discovered) => {
        replayMetadata.clear();
        for (const [key, value] of discovered) {
          replayMetadata.set(key, value);
        }
        return replayMetadata;
      },
    );
    return replayMetadataReady;
  };

  const authEntry: AuthEntry = {
    ...(createAuthEntry(platformConfig) as Omit<
      AuthEntry,
      "getIdentityKey" | "getUserIdentitySource" | "currentAuthFetcher"
    >),
    getIdentityKey: options.auth?.getIdentityKey,
  };

  const load = createLoadCoordinator({
    runtime,
    platform,
    name: dbName,
    fallbackIdentityKey: null,
    readActiveIdentityKey: () => initializeActiveIdentityKey(runtime),
    setActiveIdentityKey: (identityKey) => {
      authEntry.activeIdentityKey = identityKey;
    },
    tableDefinitions,
    replayMetadata,
    loadReplayMetadata,
    storeManifests: [
      AUTH_STATE_STORE_MIGRATIONS,
      STORAGE_METADATA_STORE_MIGRATIONS,
      SCHEDULED_FUNCTIONS_STORE_MIGRATIONS,
      ID_MAP_STORE_MIGRATIONS,
      PENDING_STORE_MIGRATIONS,
      PENDING_UPLOADS_STORE_MIGRATIONS,
    ],
    withMigrationLock: platform.createMigrationLock?.({ name: dbName }),
    onIdentityError: (error) => {
      log.warn(
        "[factory] initialize identity failed, falling back to null",
        error,
      );
    },
    onLoadError: (error) => {
      log.error("[factory] load migrations:", error);
    },
    onRefreshError: (error) => {
      log.error("[factory] refresh local watches:", error);
    },
    onTiming: ({ replayMetadataMs, migrationsMs, totalMs }) => {
      log.info(
        `open: replayMetadata=${replayMetadataMs.toFixed(1)}ms migrations=${migrationsMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
      );
    },
  });

  runtime.extendStorageReady(load.storageReady);

  let queryCacheStorage: QueryCacheStorage | null = null;

  void load.storageReady
    .then(() => {
      const storageSurface = installStorageSurface(platformConfig);
      installedStorageSurface = storageSurface;
      // Reuse the embedded storage adapter's SQLite driver to back the
      // persistent query-result cache. Adapters that don't expose a driver
      // (in-memory test doubles, future remote-only modes) just leave the
      // cache disk-less — the in-memory EmbeddedQueryCache still applies.
      const driver = trySqliteDriverFor(runtime.getStorage());
      if (driver) {
        queryCacheStorage = createQueryCacheStorage(driver);
      }
    })
    .catch((error) => {
      log.error("storage surface install skipped after storage failure", error);
    });

  const transport = runtime.createTransport(load.ready);
  client = new EmbeddedClient(transport.url, {
    ...options.clientOptions,
    webSocketConstructor:
      transport.webSocketConstructor as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  });

  const queryCache = createEmbeddedQueryCache();

  registerEmbeddedClientEntry(client, {
    runtime,
    tableDefinitions,
    fieldHandles: new Map(),
  });
  registerAuthEntry(client, authEntry);

  rootScope.addFinalizer(() => {
    deleteEmbeddedClientEntry(client);
    deleteAuthEntry(client);
  });
  rootScope.addFinalizer(() => {
    (authEntry.stateHub as PubSub<AuthState>).shutdown();
  });
  rootScope.addFinalizer(() => {
    installedStorageSurface?.close();
    installedStorageSurface = null;
    runtime.setStorageSurface(null);
  });
  rootScope.addFinalizer(() => {
    sessionBroadcast?.close();
    platform.connectivity?.close?.();
  });
  rootScope.addFinalizer(() => {
    runtime.shutdown();
  });

  const pullAttachment: PullAttachment | null = options.remote
    ? createPullAttachment({
        client,
        authEntry,
        resolveOpts: options.remote,
        convex,
        getIdentityKeyForSync: () => authEntry.activeIdentityKey,
        getReplayPayloadVersion: (refName) =>
          replayMetadata.get(refName)?.version ?? 1,
        platformConfig,
        cache: queryCache,
        getCacheStorage: () => queryCacheStorage,
        knownTables: new Set(tableDefinitions.keys()),
        uploadFetch: platform.uploadFetch,
        leaderLock: platform.createLeaderLock?.({ name: dbName }),
      })
    : null;

  if (pullAttachment) {
    rootScope.addFinalizer(async () => {
      try {
        await pullAttachment.close();
        deletePullEntry(client);
      } catch (err) {
        log.warn("error during resolve teardown", err);
      }
    });
  }

  if (!options.remote) {
    const patchHandle = client.installRouting({
      runtime,
      getRefName: getFunctionRefName,
      asError,
      planMutation: () => ({ kind: "local", enqueueForReplay: false }),
      planRead: () => ({ kind: "local" }),
      planReadByName: () => ({ kind: "local" }),
      executeLocalMutation: (ref, args) =>
        runtime.executeLocal({
          kind: "mutation",
          path: getFunctionRefName(ref),
          args,
          applyLocalEffects: true,
        }),
      connectivity: platform.connectivity,
      cache: queryCache,
      getCacheStorage: () => queryCacheStorage,
      knownTables: new Set(tableDefinitions.keys()),
    });
    rootScope.addFinalizer(() => patchHandle.dispose());
  }

  authEntry.getPendingCount = () => pullAttachment?.getPendingCount?.() ?? 0;
  authEntry.refreshSync = () =>
    pullAttachment?.refresh?.() ?? Promise.resolve();
  authEntry.getUserIdentitySource = options.auth?.getUserIdentity;

  installAuthController(client, runtime, authEntry, {
    authOptions: options.auth,
    forwardSetAuth: pullAttachment?.forwardSetAuth
      ? (...args) => pullAttachment.forwardSetAuth(...args)
      : undefined,
    forwardClearAuth: pullAttachment?.forwardClearAuth
      ? () => pullAttachment.forwardClearAuth()
      : undefined,
    forwardSetAdminAuth: pullAttachment?.forwardSetAdminAuth
      ? (...args) => pullAttachment.forwardSetAdminAuth(...args)
      : undefined,
  });

  const unsubscribeSessionFanout = installSessionFanout(
    authEntry,
    platformConfig,
  );
  rootScope.addFinalizer(() => unsubscribeSessionFanout());

  if (platform.workScheduler) {
    const setWorkScheduler = (
      client as unknown as {
        setWorkScheduler?: (s: unknown) => void;
      }
    ).setWorkScheduler;
    if (typeof setWorkScheduler === "function") {
      setWorkScheduler.call(client, platform.workScheduler);
    }
  }

  const originalClose = client.close.bind(client);
  let closePromise: Promise<void> | null = null;
  (client as { close: () => Promise<void> }).close =
    async function patchedClose(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }

      closePromise = (async () => {
        clientClosed = true;
        await rootScope.close();
        await originalClose();
      })();

      return closePromise;
    };

  return client;
}
