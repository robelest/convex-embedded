import type { Prefetch } from "@/client/prefetch";
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
  prefetch?: Prefetch;
  hasPrefetch: boolean;
  fallbackIdentityKey: string | null;
  readActiveIdentityKey: () => Promise<string | null>;
  setActiveIdentityKey: (identityKey: string | null) => void;
  tableDefinitions: ReadonlyMap<string, Definition>;
  replayMetadata: Map<string, PendingReplayMeta>;
  loadReplayMetadata: () => Promise<Map<string, PendingReplayMeta>>;
  storeManifests: StoreMigrationManifest[];
  onIdentityError: (error: unknown) => void;
  onLoadError: (error: unknown) => void;
  onRefreshError: (
    stage: "after-storage" | "after-load",
    error: unknown,
  ) => void;
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
  prefetch?: Prefetch;
}): Promise<void> {
  return withSpan(
    "convex-embedded.attachPlatformStorage",
    async (span) => {
      const started = now();

      const storage = await withSpan("convex-embedded.platform.openStorage", () =>
        input.platform.openStorage({
          name: input.name,
          runtime: input.runtime,
        }),
      );

      if (storage) {
        input.runtime.setStorage(storage);
        input.runtime.db.setStorage(storage);

        const prefetchTableNames = input.prefetch
          ? Object.keys(input.prefetch.tables)
          : [];
        const hydrationStarted = now();
        await withSpan("convex-embedded.db.hydrate", () =>
          input.runtime.db.hydrate(),
        );
        const hasPersistedRows =
          prefetchTableNames.length > 0 &&
          prefetchTableNames.some((tableName) =>
            input.runtime.db.hasDocumentsForTable(tableName),
          );
        if (input.prefetch && !hasPersistedRows) {
          await withSpan("convex-embedded.ingestPrefetchUngated", () =>
            input.runtime.ingestPrefetchUngated(input.prefetch!),
          );
        }
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
        if (input.prefetch) {
          await withSpan("convex-embedded.ingestPrefetchUngated", () =>
            input.runtime.ingestPrefetchUngated(input.prefetch!),
          );
        }
        log.debug(
          `attach for ${input.name}: unavailable after ${(now() - started).toFixed(1)}ms`,
        );
      }
    },
    { attributes: { "convex.attach.name": input.name } },
  );
}

export class LoadCoordinator {
  readonly identityReady: Promise<string | null>;
  readonly ready: Promise<void>;
  readonly storageReady: Promise<void>;

  constructor(private readonly input: LoadCoordinatorInput) {
    this.storageReady = attachPlatformStorage({
      runtime: this.input.runtime,
      platform: this.input.platform,
      name: this.input.name,
      prefetch: this.input.prefetch,
    });

    this.identityReady = this.storageReady.then(() =>
      this.initializeIdentity(),
    );

    const loadReady = this.runLoadPass().catch((error) => {
      this.input.onLoadError(error);
    });

    this.ready = this.bindReadiness(loadReady);
  }

  private initializeIdentity(): Promise<string | null> {
    return withSpan("convex-embedded.initializeIdentity", async () => {
      try {
        const identityKey = await this.input.readActiveIdentityKey();
        const resolvedIdentityKey =
          identityKey ?? this.input.fallbackIdentityKey;
        this.input.runtime.setActiveIdentityKey(resolvedIdentityKey);
        this.input.setActiveIdentityKey(resolvedIdentityKey);
        return resolvedIdentityKey;
      } catch (error) {
        this.input.runtime.setActiveIdentityKey(null);
        this.input.setActiveIdentityKey(null);
        this.input.onIdentityError(error);
        return null;
      }
    });
  }

  private runLoadPass(): Promise<void> {
    return withSpan("convex-embedded.runLoadPass", async (span) => {
      const started = now();
      const identityKey = await this.identityReady;

      let hasPendingEntries = false;
      await withSpan("convex-embedded.checkPendingReplay", async () => {
        const qid = this.input.runtime.db.startQueryAsync({
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
          const next = await this.input.runtime.db.queryNextAsync(qid);
          hasPendingEntries = !next.done;
        } finally {
          this.input.runtime.db.queryCleanup(qid);
        }
      });

      if (hasPendingEntries) {
        await withSpan("convex-embedded.loadReplayMetadata", () =>
          this.input.loadReplayMetadata(),
        );
      }

      const replayReady = now();

      await withSpan("convex-embedded.runLocalMigrations", () =>
        runLocalMigrations(this.input.runtime, {
          identityKey,
          tableDefinitions: this.input.tableDefinitions,
          replayMetadata: this.input.replayMetadata,
          storeManifests: this.input.storeManifests,
        }),
      );

      const ended = now();
      span.setAttributes({
        "convex.load.has_pending": hasPendingEntries,
        "convex.load.replay_ms": +(replayReady - started).toFixed(1),
        "convex.load.migrations_ms": +(ended - replayReady).toFixed(1),
        "convex.load.total_ms": +(ended - started).toFixed(1),
      });
      this.input.onTiming({
        replayMetadataMs: replayReady - started,
        migrationsMs: ended - replayReady,
        totalMs: ended - started,
      });
    });
  }

  private bindReadiness(loadReady: Promise<void>): Promise<void> {
    if (this.input.hasPrefetch) {
      return this.storageReady.then(() =>
        this.input.runtime.refreshLocalQueryWatches().catch((error) => {
          this.input.onRefreshError("after-storage", error);
        }),
      );
    }

    return loadReady.then(() =>
      this.input.runtime.refreshLocalQueryWatches().catch((error) => {
        this.input.onRefreshError("after-load", error);
      }),
    );
  }
}
