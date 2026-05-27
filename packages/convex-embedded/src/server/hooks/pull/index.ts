import type { GenericDataModel, GenericQueryCtx } from "convex/server";

import { createLogger } from "@/shared/logger";
import type { PullResponse } from "@/shared/types";

import { runPullByDocIds } from "./byDocIds";
import { runPullFull } from "./full";
import { runPullIncremental } from "./incremental";
import type { PullHandlerArgs, PullSpec } from "./types";

const log = createLogger("server-runtime");

interface CollectionChanges {
  mode: "full" | "incremental";
  collectionSeq: number;
  changes: Array<{ docId: string; kind: "upsert" | "delete" }>;
}

/**
 * Pull dispatcher: picks the correct mode (docIds / full / incremental)
 * based on `args` and the collection-changes window the component reports.
 *
 * Callers must pre-check that the component runtime is available
 * (see hooks/detect.ts). If the component is unavailable, the caller
 * should short-circuit with a no-op pull response.
 */
export async function runPull(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  args: PullHandlerArgs,
): Promise<PullResponse> {
  if (args.docIds && args.docIds.length > 0) {
    return runPullByDocIds(ctx, spec, args.docIds);
  }

  const collectionChanges = (await ctx.runQuery(
    spec.component.public.getCollectionChanges,
    {
      collection: spec.tableName,
      sinceSeq: args.collectionSeq ?? null,
    },
  )) as CollectionChanges;

  if (collectionChanges.mode === "full") {
    return runPullFull(ctx, spec, args, collectionChanges, log);
  }

  return runPullIncremental(ctx, spec, args, collectionChanges, log);
}

export type { PullSpec } from "./types";
