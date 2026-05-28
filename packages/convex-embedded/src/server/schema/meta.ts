import type { FunctionReference } from "convex/server";

import type { Definition } from "./core.js";

export { REMOTE_META, PENDING_REPLAY_META } from "@/shared/symbols";

/**
 * Metadata describing the remote-sync exports attached to a bound table.
 */
export interface RemoteMeta {
  readonly __brand: "convex-embedded:remoteMeta";
  readonly table: string;
  readonly schema: Definition;
  readonly resolveExport: string;
}

/**
 * Context passed to a pending-replay migration step.
 */
export interface PendingReplayMigrationContext {
  readonly ref: string;
  readonly localId: string | null;
}

/**
 * Result returned by a pending-replay migration step.
 */
export type PendingReplayMigrationResult = Record<string, unknown>;

/**
 * Migration step used to transform queued mutation arguments between replay
 * payload versions.
 */
export type PendingReplayMigrationStep = (
  args: Record<string, unknown>,
  ctx: PendingReplayMigrationContext,
) => PendingReplayMigrationResult | Promise<PendingReplayMigrationResult>;

/**
 * Metadata describing replay migration behavior for a mutation.
 */
export interface PendingReplayMeta {
  readonly __brand: "convex-embedded:pendingReplayMeta";
  readonly version: number;
  readonly migrate: Record<number, PendingReplayMigrationStep>;
}

interface ResolveComponentApi {
  public: {
    recordDelete: FunctionReference<"mutation">;
    recordUpdate: FunctionReference<"mutation">;
    getCollectionChanges: FunctionReference<"query">;
    getLiveState: FunctionReference<"query">;
    getLiveStates: FunctionReference<"query">;
    getLiveStatesPage: FunctionReference<"query">;
  };
}

/**
 * Bound component API required by the packaged remote runtime.
 * @internal
 */
export type ComponentBinding = ResolveComponentApi;
