import type { Prefetch } from "@/client/prefetch";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import { runLocalMigrations } from "@/runtime/migrations/coordinator";
import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import { attachPlatformPersistence } from "@/runtime/persistence";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import type { Definition } from "@/server/schema/core";
import type { PendingReplayMeta } from "@/shared/symbols";
import type { EncryptionOptions } from "@/storage/encrypted";

const now = () => globalThis.performance?.now?.() ?? Date.now();

export interface LoadCoordinatorInput {
  runtime: EmbeddedRuntime;
  platform: EmbeddedPlatformAdapter;
  name: string;
  encryption?: Omit<EncryptionOptions, "getIdentityKey">;
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
    stage: "after-persistence" | "after-load",
    error: unknown,
  ) => void;
  onTiming: (timing: {
    replayMetadataMs: number;
    migrationsMs: number;
    totalMs: number;
  }) => void;
}

export class LoadCoordinator {
  readonly identityReady: Promise<string | null>;
  readonly ready: Promise<void>;
  readonly storageReady: Promise<void>;

  constructor(private readonly input: LoadCoordinatorInput) {
    this.storageReady = attachPlatformPersistence({
      runtime: this.input.runtime,
      platform: this.input.platform,
      name: this.input.name,
      encryption: this.input.encryption,
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

  private async initializeIdentity(): Promise<string | null> {
    try {
      const identityKey = await this.input.readActiveIdentityKey();
      const resolvedIdentityKey = identityKey ?? this.input.fallbackIdentityKey;
      this.input.runtime.setActiveIdentityKey(resolvedIdentityKey);
      this.input.setActiveIdentityKey(resolvedIdentityKey);
      return resolvedIdentityKey;
    } catch (error) {
      this.input.runtime.setActiveIdentityKey(null);
      this.input.setActiveIdentityKey(null);
      this.input.onIdentityError(error);
      return null;
    }
  }

  private async runLoadPass(): Promise<void> {
    const started = now();
    const identityKey = await this.identityReady;

    const qid = this.input.runtime.db.startQueryAsync({
      source: {
        type: "IndexRange",
        indexName: "_resolve_pending.by_identity_key_and_creation_time",
        range: [{ type: "Eq", fieldPath: "identityKey", value: identityKey }],
        order: "asc",
      } as never,
      operators: [{ limit: 1 }],
    });

    let hasPendingEntries = false;
    try {
      const next = await this.input.runtime.db.queryNextAsync(qid);
      hasPendingEntries = !next.done;
    } finally {
      this.input.runtime.db.queryCleanup(qid);
    }

    if (hasPendingEntries) {
      await this.input.loadReplayMetadata();
    }

    const replayReady = now();

    await runLocalMigrations(this.input.runtime, {
      identityKey,
      tableDefinitions: this.input.tableDefinitions,
      replayMetadata: this.input.replayMetadata,
      storeManifests: this.input.storeManifests,
    });

    const ended = now();
    this.input.onTiming({
      replayMetadataMs: replayReady - started,
      migrationsMs: ended - replayReady,
      totalMs: ended - started,
    });
  }

  private bindReadiness(loadReady: Promise<void>): Promise<void> {
    if (this.input.hasPrefetch) {
      return this.storageReady.then(() =>
        this.input.runtime.refreshLocalQueryWatches().catch((error) => {
          this.input.onRefreshError("after-persistence", error);
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
