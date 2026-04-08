import type { FunctionReference } from "convex/server";

import type { Definition } from "./core.js";

export const REMOTE_META = Symbol.for("convex-embedded:remoteMeta");
export const RESOLVE_QUERY_META = Symbol.for(
  "convex-embedded:resolveQueryMeta",
);
export const PENDING_REPLAY_META = Symbol.for(
  "convex-embedded:pendingReplayMeta",
);

export interface RemoteMeta {
  readonly __brand: "convex-embedded:remoteMeta";
  readonly table: string;
  readonly schema: Definition;
  readonly resolveExport: string;
  readonly listExport: string | null;
}

export interface ResolveQueryMeta {
  readonly __brand: "convex-embedded:resolveQueryMeta";
  readonly table: string;
  readonly getArgs?: () => Record<string, unknown>;
}

export interface PendingReplayMigrationContext {
  readonly ref: string;
  readonly localId: string | null;
}

export type PendingReplayMigrationResult = Record<string, unknown>;

export type PendingReplayMigrationStep = (
  args: Record<string, unknown>,
  ctx: PendingReplayMigrationContext,
) => PendingReplayMigrationResult | Promise<PendingReplayMigrationResult>;

export interface PendingReplayMeta {
  readonly __brand: "convex-embedded:pendingReplayMeta";
  readonly version: number;
  readonly migrate: Record<number, PendingReplayMigrationStep>;
}

interface ResolveComponentApi {
  public: {
    recordUpdate: FunctionReference<"mutation", any>;
    getLiveState: FunctionReference<"query", any>;
    getLiveStates: FunctionReference<"query", any>;
    createCheckpoint: FunctionReference<"mutation", any>;
    listCheckpoints: FunctionReference<"query", any>;
    getCheckpoint: FunctionReference<"query", any>;
    cleanupDoc: FunctionReference<"mutation", any>;
  };
}

export type ComponentBinding = ResolveComponentApi;
