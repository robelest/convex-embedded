import type { Definition } from "@/shared/schema";
import type { PendingReplayMeta } from "@/shared/symbols";

export type StoreMigrationScope = "global" | "identity";

export interface StoreVersionRecord {
  store: string;
  scope: StoreMigrationScope;
  identityKey?: string | null;
  version: number;
}

export interface StoreMigrationContext {
  identityKey: string | null;
}

export type StoreMigrationStep = (
  ctx: StoreMigrationContext,
) => Promise<void> | void;

export interface StoreMigrationManifest {
  store: string;
  scope: StoreMigrationScope;
  version: number;
  migrate?: Record<number, StoreMigrationStep>;
}

export interface MigrationCoordinatorOptions {
  identityKey: string | null;
  storeManifests: readonly StoreMigrationManifest[];
  tableDefinitions: ReadonlyMap<string, Definition>;
  replayMetadata: ReadonlyMap<string, PendingReplayMeta>;
}
