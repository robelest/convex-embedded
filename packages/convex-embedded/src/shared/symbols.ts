/**
 * Cross-package discovery symbols and metadata interfaces.
 *
 * @module
 */

import type { Definition } from "@/shared/schema";

/**
 * Global symbol used to tag the `resolve` export with remote metadata.
 *
 * Tagged metadata used by the sync engine to discover per-table resolve/bind
 * exports.
 *
 * @internal
 */
export const REMOTE_META = Symbol.for("convex-embedded:remoteMeta");
export const PENDING_REPLAY_META = Symbol.for(
  "convex-embedded:pendingReplayMeta",
);
export const STORAGE_UPLOAD_URL_META = Symbol.for(
  "convex-embedded:storageUploadUrlMeta",
);

export type { RouteMode } from "@/shared/route";

/**
 * Sync metadata attached to the `resolve` export.
 *
 * @internal — consumed by the client-side resolve engine during
 * auto-discovery. App code never reads this directly.
 */
export interface RemoteMeta {
  readonly __brand: "convex-embedded:remoteMeta";
  /** Embedded table name associated with the exported resolve query. */
  readonly table: string;
  /** Versioned CRDT schema definition for the table. */
  readonly schema: Definition;
  /** Export name of the generated resolve query. */
  readonly resolveExport: string;
}

export interface PendingReplayMigrationContext {
  ref: string;
  fromVersion: number;
  toVersion: number;
  args: Record<string, unknown>;
  localResult: unknown;
}

export interface PendingReplayMigrationResult {
  args: Record<string, unknown>;
  localResult: unknown;
}

export type PendingReplayMigrationStep = (
  ctx: PendingReplayMigrationContext,
) => Promise<PendingReplayMigrationResult> | PendingReplayMigrationResult;

export interface PendingReplayMeta {
  readonly __brand: "convex-embedded:pendingReplayMeta";
  readonly version: number;
  readonly migrate: Record<number, PendingReplayMigrationStep>;
}

export interface StorageUploadUrlMeta {
  readonly __brand: "convex-embedded:storageUploadUrlMeta";
}
