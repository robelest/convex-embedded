/**
 * Cross-package discovery symbols and metadata interfaces.
 *
 * @module
 */

import type { Definition } from "@/shared/schema";

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/**
 * Global symbol used to tag the `resolve` export with remote metadata.
 *
 * @deprecated — The registry-based discovery in `embeddedTable()` +
 * `setup()` replaces symbol scanning. Kept for backward compatibility
 * with existing deployed modules.
 *
 * @internal
 */
export const REMOTE_META = Symbol.for("convex-embedded:remoteMeta");
export const RESOLVE_QUERY_META = Symbol.for(
  "convex-embedded:resolveQueryMeta",
);
export const PENDING_REPLAY_META = Symbol.for(
  "convex-embedded:pendingReplayMeta",
);

// ---------------------------------------------------------------------------
// RouteMode
// ---------------------------------------------------------------------------

export type { RouteMode } from "@/client/routing/metadata";

// ---------------------------------------------------------------------------
// Metadata interfaces
// ---------------------------------------------------------------------------

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
  /** Optional export name for a list query used during discovery. */
  readonly listExport: string | null;
}

/**
 * Metadata attached to queries that participate in resolve-driven refetch.
 *
 * The client-side sync engine reads this marker to know which query should be
 * invalidated after CRDT reconciliation finishes for a table.
 */
export interface ResolveQueryMeta {
  readonly __brand: "convex-embedded:resolveQueryMeta";
  /** Embedded table name associated with the query. */
  readonly table: string;
  /** Optional callback returning query args to refetch after resolve. */
  readonly getArgs?: () => Record<string, unknown>;
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
