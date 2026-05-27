import type { EmbeddedRuntime } from "@/runtime/embedded";
import { runLocalMigrations } from "@/runtime/migrations/coordinator";
import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import type { Definition } from "@/server/schema/core";
import { createLogger } from "@/shared/logger";
import type { PendingReplayMeta } from "@/shared/symbols";
import { withSpan } from "@/tracing/spans";

const log = createLogger("storage-attach");

const now = () => globalThis.performance?.now?.() ?? Date.now();

export interface LoadCoordinatorInput {
  runtime: EmbeddedRuntime;
  platform: EmbeddedPlatformAdapter;
  name: string;
  fallbackIdentityKey: string | null;
  readActiveIdentityKey: () => Promise<string | null>;
  setActiveIdentityKey: (identityKey: string | null) => void;
  tableDefinitions: ReadonlyMap<string, Definition>;
  replayMetadata: Map<string, PendingReplayMeta>;
  loadReplayMetadata: () => Promise<Map<string, PendingReplayMeta>>;
  storeManifests: StoreMigrationManifest[];
  withMigrationLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  onIdentityError: (error: unknown) => void;
  onLoadError: (error: unknown) => void;
  onRefreshError: (error: unknown) => void;
  onTiming: (timing: {
    replayMetadataMs: number;
    migrationsMs: number;
    totalMs: number;
  }) => void;
}

export async function attachPlatformStorage(input: {
  runtime: EmbeddedRuntime;
  platform: EmbeddedPlatformAdapter;
  name: string;
}): Promise<void> {
  return withSpan(
    "convex-embedded.attachPlatformStorage",
    async (span) => {
      const started = now();

      const storage = await withSpan(
        "convex-embedded.platform.openStorage",
        () =>
          input.platform.openStorage({
            name: input.name,
            runtime: input.runtime,
          }),
      );

      if (storage) {
        input.runtime.setStorage(storage);
        input.runtime.db.setStorage(storage);

        const hydrationStarted = now();
        await withSpan("convex-embedded.db.hydrate", () =>
          input.runtime.db.hydrateSystemTables(),
        );
        await withSpan("convex-embedded.resumePersistedState", () =>
          input.runtime.resumePersistedState(),
        );
        const ended = now();
        span.setAttributes({
          "convex.attach.open_ms": +(hydrationStarted - started).toFixed(1),
          "convex.attach.hydrate_ms": +(ended - hydrationStarted).toFixed(1),
          "convex.attach.total_ms": +(ended - started).toFixed(1),
          "convex.attach.has_storage": true,
        });
        log.debug(
          `attach for ${input.name}: open=${(hydrationStarted - started).toFixed(1)}ms hydrate=${(ended - hydrationStarted).toFixed(1)}ms total=${(ended - started).toFixed(1)}ms`,
        );
      } else {
        span.setAttributes({ "convex.attach.has_storage": false });
        log.debug(
          `attach for ${input.name}: unavailable after ${(now() - started).toFixed(1)}ms`,
        );
      }
    },
    { attributes: { "convex.attach.name": input.name } },
  );
}

export interface LoadCoordinator {
  readonly identityReady: Promise<string | null>;
  readonly ready: Promise<void>;
  readonly storageReady: Promise<void>;
}

export function createLoadCoordinator(
  input: LoadCoordinatorInput,
): LoadCoordinator {
  const storageReady = attachPlatformStorage({
    runtime: input.runtime,
    platform: input.platform,
    name: input.name,
  });

  function initializeIdentity(): Promise<string | null> {
    return withSpan("convex-embedded.initializeIdentity", async () => {
      try {
        const identityKey = await input.readActiveIdentityKey();
        const resolvedIdentityKey = identityKey ?? input.fallbackIdentityKey;
        input.runtime.setActiveIdentityKey(resolvedIdentityKey);
        input.setActiveIdentityKey(resolvedIdentityKey);
        return resolvedIdentityKey;
      } catch (error) {
        input.runtime.setActiveIdentityKey(null);
        input.setActiveIdentityKey(null);
        input.onIdentityError(error);
        return null;
      }
    });
  }

  const identityReady = storageReady.then(() => initializeIdentity());

  async function runLoadPass(): Promise<void> {
    return withSpan("convex-embedded.runLoadPass", async (span) => {
      const started = now();
      const identityKey = await identityReady;

      let hasPendingEntries = false;
      await withSpan("convex-embedded.checkPendingReplay", async () => {
        const qid = input.runtime.db.startQueryAsync({
          source: {
            type: "IndexRange",
            indexName: "_resolve_pending.by_identity_key_and_creation_time",
            range: [
              { type: "Eq", fieldPath: "identityKey", value: identityKey },
            ],
            order: "asc",
          } as never,
          operators: [{ limit: 1 }],
        });
        try {
          const next = await input.runtime.db.queryNextAsync(qid);
          hasPendingEntries = !next.done;
        } finally {
          input.runtime.db.queryCleanup(qid);
        }
      });

      if (hasPendingEntries) {
        await withSpan("convex-embedded.loadReplayMetadata", () =>
          input.loadReplayMetadata(),
        );
      }

      const replayReady = now();

      await withSpan("convex-embedded.runLocalMigrations", () =>
        runLocalMigrations(input.runtime, {
          identityKey,
          tableDefinitions: input.tableDefinitions,
          replayMetadata: input.replayMetadata,
          storeManifests: input.storeManifests,
          withMigrationLock: input.withMigrationLock,
        }),
      );

      const ended = now();
      span.setAttributes({
        "convex.load.has_pending": hasPendingEntries,
        "convex.load.replay_ms": +(replayReady - started).toFixed(1),
        "convex.load.migrations_ms": +(ended - replayReady).toFixed(1),
        "convex.load.total_ms": +(ended - started).toFixed(1),
      });
      input.onTiming({
        replayMetadataMs: replayReady - started,
        migrationsMs: ended - replayReady,
        totalMs: ended - started,
      });
    });
  }

  const loadReady = runLoadPass().catch((error) => {
    input.onLoadError(error);
  });

  const ready = loadReady.then(() =>
    input.runtime.refreshLocalQueryWatches().catch((error) => {
      input.onRefreshError(error);
    }),
  );

  return { identityReady, ready, storageReady };
}
