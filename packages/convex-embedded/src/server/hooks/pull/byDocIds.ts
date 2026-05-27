import type { GenericDataModel, GenericQueryCtx } from "convex/server";

import type { PullResponse } from "@/shared/types";

import { materializeStates } from "./materialize";
import type { LiveStateRecord, PullSpec } from "./types";

export async function runPullByDocIds(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  docIds: string[],
): Promise<PullResponse> {
  const rawLiveStates = (await ctx.runQuery(
    spec.component.public.getLiveStates,
    {
      collection: spec.tableName,
      docIds,
    },
  )) as Array<LiveStateRecord | null>;
  const liveStatesById = new Map(
    rawLiveStates
      .filter((state): state is LiveStateRecord =>
        Boolean(state && typeof state.docId === "string"),
      )
      .map((state) => [state.docId, state] as const),
  );
  const hydrated = await materializeStates(
    ctx,
    spec,
    Array.from(liveStatesById.values()),
  );
  const hydratedById = new Map(
    hydrated.map((entry) => [entry.docId, entry] as const),
  );

  return {
    mode: "full",
    collectionSeq: -1,
    documents: docIds.map((docId: string) => {
      const entry = hydratedById.get(docId);
      return entry ?? { docId, deleted: true as const, seq: null };
    }),
    isDone: true,
    continueCursor: null,
  };
}
