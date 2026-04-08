/**
 * Platform-agnostic embedded client factory.
 *
 * This module contains the lower-level client bootstrap used by the browser
 * entry point. It accepts an {@link EmbeddedPlatformAdapter}, wires together
 * persistence, embedded transport, auth, and remote sync, then returns a
 * standard `ConvexClient` instance.
 */

import { Fx } from "@robelest/fx";
import { ConvexClient } from "convex/browser";
import type { BaseConvexClientOptions } from "convex/browser";

import { patchRoutedConvexClient } from "@/client/adapter";
import {
  type AuthEntry,
  type AuthOptions,
  AUTH_STATE_STORE_MIGRATIONS,
  deleteAuthEntry,
  initializeActiveIdentityKey,
  installAuthController,
  refreshAuthFromSource,
  registerAuthEntry,
} from "@/client/auth";
import {
  deleteEmbeddedClientEntry,
  extractEmbeddedTableDefinitions,
  registerEmbeddedClientEntry,
} from "@/client/entry";
import { ID_MAP_STORE_MIGRATIONS } from "@/client/ids";
import { PENDING_STORE_MIGRATIONS } from "@/client/pending";
import {
  attachResolve,
  deleteResolveEntry,
  type RemoteOptions,
} from "@/client/remote";
import { discoverPendingReplayMetadata } from "@/client/replay";
import type { Replica } from "@/client/replica";
import { asError, getFunctionRefName } from "@/client/routing/refs";
import {
  type ConvexModule,
  type ConvexModuleRegistry,
  normalizeModuleRegistry,
} from "@/kernel/modules";
import { STORAGE_METADATA_STORE_MIGRATIONS } from "@/kernel/syscalls";
import { createAmbientCryptoProvider } from "@/runtime/crypto";
import { EmbeddedRuntime } from "@/runtime/embedded";
import type { EmbeddedRuntimeOptions } from "@/runtime/embedded";
import { runLocalMigrations } from "@/runtime/migrations/coordinator";
import { attachPlatformPersistence } from "@/runtime/persistence";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import { SCHEDULED_FUNCTIONS_STORE_MIGRATIONS } from "@/scheduler/executor";
import { createLogger } from "@/shared/logger";
import type { PendingReplayMeta } from "@/shared/symbols";
import type { EncryptionOptions } from "@/storage/encrypted";

const log = createLogger("setup");

/**
 * Platform-agnostic options for {@link createEmbeddedClient}.
 *
 * Use this shape when you are building a custom environment wrapper such as
 * Electron, React Native, or a browser-specific helper.
 *
 * @example
 * ```ts
 * const client = createEmbeddedClient({
 *   options: {
 *     modules,
 *     remote: { url: import.meta.env.CONVEX_URL },
 *   },
 *   platform,
 * });
 * ```
 */
export interface EmbeddedClientOptions {
  /** Lazy ESM registry of Convex modules keyed by canonical module id. */
  modules: ConvexModuleRegistry;

  /** Optional schema export used for local validation and storage layout. */
  schema?: unknown;

  /** Options forwarded to the underlying `ConvexClient` constructor. */
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;

  /** Persistent database name shared by tabs or windows using the same store. */
  name?: string;

  /** Enable local-first remote sync against a hosted Convex deployment. */
  remote?: RemoteOptions;

  /** Optional embedded auth hooks used to mirror remote identity state. */
  auth?: AuthOptions;

  /**
   * Optional remote-backed replica used to seed the embedded database.
   *
   * Pass the value returned by `createReplica(...)` to start the embedded
   * client from authoritative table data before local reads begin.
   */
  replica?: Replica;

  /** Optional at-rest encryption for platform persistence adapters. */
  encryption?: Omit<EncryptionOptions, "getIdentityKey">;
}

/**
 * Create an embedded Convex client using injected platform services.
 *
 * This is the core factory behind browser-specific wrappers. Future platforms
 * like Electron or Expo should supply an {@link EmbeddedPlatformAdapter}
 * instead of re-implementing client/runtime orchestration.
 *
 * @param input - Factory inputs including user-facing options and a platform adapter.
 * @param input.options - Embedded client configuration.
 * @param input.platform - Platform services for persistence, broadcasting, and connectivity.
 * @returns A standard `ConvexClient` instance backed by an embedded runtime.
 *
 * @example
 * ```ts
 * const client = createEmbeddedClient({
 *   options: { modules, name: "app-cache" },
 *   platform,
 * });
 * ```
 */
export function createEmbeddedClient(input: {
  options: EmbeddedClientOptions;
  platform: EmbeddedPlatformAdapter;
}): ConvexClient {
  const { options, platform } = input;
  const dbName = options.name ?? "convex-embedded";
  const modules = normalizeModuleRegistry(
    options.modules as Record<string, () => Promise<ConvexModule>>,
  );

  const sessionBroadcast = platform.createSessionBroadcast?.({ name: dbName });
  const writeBroadcast = platform.createWriteBroadcast?.({ name: dbName });
  const replayMetadata = new Map<string, PendingReplayMeta>();
  const replayMetadataReady = Fx.run(
    Fx.from({
      ok: () => discoverPendingReplayMetadata(modules),
      err: (error) => error as Error,
    }).pipe(
      Fx.tap((discovered) =>
        Fx.sync(() => {
          replayMetadata.clear();
          for (const [key, value] of discovered) {
            replayMetadata.set(key, value);
          }
        }),
      ),
      Fx.map(() => replayMetadata),
    ),
  );

  const runtime = new EmbeddedRuntime({
    modules,
    schema: options.schema as EmbeddedRuntimeOptions["schema"],
    replica: options.replica,
    crypto: platform.crypto ?? createAmbientCryptoProvider(),
    verifyToken: options.auth?.verifyToken,
    writeBroadcast,
  });

  const storageReady = attachPlatformPersistence({
    runtime,
    platform,
    name: dbName,
    encryption: options.encryption,
  });
  const tableDefinitions = extractEmbeddedTableDefinitions(options.schema);
  let clientClosed = false;
  let installedStorageSurface: {
    close(): void;
  } | null = null;

  runtime.setStorageSurface(null);
  Fx.detach(
    () =>
      Fx.run(
        Fx.from({
          ok: () => storageReady,
          err: (error) => error as Error,
        }).pipe(
          Fx.tap(() =>
            Fx.sync(() => {
              if (clientClosed) {
                log.info("skipping storage surface install after client close");
                return;
              }

              const storageSurface =
                platform.createStorageSurface?.({
                  runtime,
                  name: dbName,
                  crypto: runtime.crypto,
                }) ?? null;

              if (clientClosed) {
                storageSurface?.close();
                return;
              }

              installedStorageSurface = storageSurface;
              runtime.setStorageSurface(storageSurface);
              log.info(
                `storage surface installed after persistence bootstrap (${storageSurface ? "enabled" : "none"})`,
              );
            }),
          ),
          Fx.inspect((error) =>
            Fx.sync(() => {
              log.error(
                "storage surface install skipped after persistence failure",
                error,
              );
            }),
          ),
          Fx.recover(() => Fx.unit),
        ),
      ),
    "[factory] storage surface install:",
  );

  const transport = runtime.createTransport();
  const client = new ConvexClient(transport.url, {
    ...options.clientOptions,
    webSocketConstructor:
      transport.webSocketConstructor as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
  });

  registerEmbeddedClientEntry(client, {
    runtime,
    tableDefinitions,
    fieldHandles: new Map(),
  });

  const authEntry: AuthEntry = {
    runtime,
    getIdentityKey: options.auth?.getIdentityKey,
    getPendingCount: () => 0,
    refreshSync: () => Promise.resolve(),
    activeIdentityKey: null,
    sessionBroadcast,
    state: { status: "idle" },
    listeners: new Set(),
  };
  registerAuthEntry(client, authEntry);

  const storageHydrated = storageReady.then(() =>
    runtime.waitForStorageHydration(),
  );

  const identityReady = Fx.run(
    Fx.from({
      ok: () => storageHydrated,
      err: (error) => error as Error,
    }).pipe(
      Fx.chain(() =>
        Fx.from({
          ok: () => initializeActiveIdentityKey(runtime),
          err: (error) => error as Error,
        }),
      ),
      Fx.map(
        (identityKey) => identityKey ?? options.replica?.identityKey ?? null,
      ),
      Fx.tap((resolvedIdentityKey) =>
        Fx.sync(() => {
          runtime.setActiveIdentityKey(resolvedIdentityKey);
          authEntry.activeIdentityKey = resolvedIdentityKey;
        }),
      ),
      Fx.recover(() =>
        Fx.sync(() => {
          authEntry.activeIdentityKey = null;
          runtime.setActiveIdentityKey(null);
          return null;
        }),
      ),
    ),
  );

  const startupReady = identityReady.then((identityKey) =>
    replayMetadataReady.then(() =>
      runLocalMigrations(runtime, {
        identityKey,
        tableDefinitions,
        replayMetadata,
        storeManifests: [
          AUTH_STATE_STORE_MIGRATIONS,
          STORAGE_METADATA_STORE_MIGRATIONS,
          SCHEDULED_FUNCTIONS_STORE_MIGRATIONS,
          ID_MAP_STORE_MIGRATIONS,
          PENDING_STORE_MIGRATIONS,
        ],
      }),
    ),
  );

  runtime.setHydrationGate(startupReady);
  Fx.detach(
    () =>
      Fx.run(
        Fx.from({
          ok: () => startupReady,
          err: (error) => error as Error,
        }).pipe(
          Fx.tap(() =>
            Fx.from({
              ok: () => runtime.refreshLocalQueryWatches(),
              err: (error) => error as Error,
            }),
          ),
          Fx.recover(() => Fx.unit),
        ),
      ),
    "[factory] refresh local watches:",
  );

  const resolveAttachment = options.remote
    ? attachResolve({
        client,
        runtime,
        authEntry,
        resolveOpts: options.remote,
        modules,
        getIdentityKeyForSync: () => authEntry.activeIdentityKey,
        getReplayPayloadVersion: (refName) =>
          replayMetadata.get(refName)?.version ?? 1,
        connectivity: platform.connectivity,
        processorId: platform.processorIdentity?.getProcessorId({
          name: dbName,
        }),
      })
    : null;

  if (!options.remote) {
    patchRoutedConvexClient({
      client,
      runtime,
      getRefName: getFunctionRefName,
      asError,
      resolveMutationPlan: () => ({ kind: "local", enqueueForReplay: false }),
      resolveReadPlan: () => ({ kind: "local" }),
      resolveReadPlanByName: () => ({ kind: "local" }),
      executeLocalMutation: (ref, args) =>
        runtime.executeLocal({
          kind: "mutation",
          path: getFunctionRefName(ref),
          args,
          applyLocalEffects: true,
        }),
      connectivity: platform.connectivity,
    });
  }

  authEntry.getPendingCount = () => resolveAttachment?.getPendingCount?.() ?? 0;
  authEntry.refreshSync = () =>
    resolveAttachment?.refresh?.() ?? Promise.resolve();
  authEntry.getUserIdentitySource = options.auth?.getUserIdentity;

  installAuthController(client, runtime, authEntry, {
    authOptions: options.auth,
    forwardSetAuth: resolveAttachment?.forwardSetAuth,
    forwardClearAuth: resolveAttachment?.forwardClearAuth,
    forwardSetAdminAuth: resolveAttachment?.forwardSetAdminAuth,
  });

  const unsubscribeSessionFanout =
    sessionBroadcast?.onNotification(() => {
      void refreshAuthFromSource(authEntry);
    }) ?? (() => {});

  const originalClose = client.close.bind(client);
  let closePromise: Promise<void> | null = null;
  (client as any).close = async function patchedClose(): Promise<void> {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      clientClosed = true;
      deleteEmbeddedClientEntry(client);
      deleteAuthEntry(client);
      if (resolveAttachment) {
        await resolveAttachment.close();
        deleteResolveEntry(client);
      }
      unsubscribeSessionFanout();
      sessionBroadcast?.close();
      writeBroadcast?.close();
      platform.connectivity?.close?.();
      installedStorageSurface?.close();
      installedStorageSurface = null;
      runtime.setStorageSurface(null);
      runtime.shutdown();
      await originalClose();
    })();

    return closePromise;
  };

  return client;
}
