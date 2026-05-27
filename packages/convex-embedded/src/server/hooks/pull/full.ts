import type { GenericDataModel, GenericQueryCtx } from "convex/server";

import type { PullResponse } from "@/shared/types";

import { materializeStates } from "./materialize";
import {
  encodeScopeCursor,
  getRangeDocIds,
  getScopedDocIds,
  parseScopeCursor,
} from "./scope";
import type { LiveStateRecord, PullHandlerArgs, PullSpec } from "./types";

interface CollectionChanges {
  mode: "full" | "incremental";
  collectionSeq: number;
  changes: Array<{ docId: string; kind: "upsert" | "delete" }>;
}

export async function runPullFull(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  args: PullHandlerArgs,
  collectionChanges: CollectionChanges,
  log: { warn: (msg: string, error: unknown) => void },
): Promise<PullResponse> {
  const scoped = args.scopeArgs && Object.keys(args.scopeArgs).length > 0;
  const knownDocIds = args.documents.map((doc) => doc.docId);
  const scopeArgs = scoped
    ? (args.scopeArgs as Record<string, unknown>)
    : undefined;

  if (args.queryPageRange) {
    const ranged = await getRangeDocIds(ctx, spec, args.queryPageRange, log);
    if (ranged !== null) {
      const rawLiveStates =
        ranged.orderedDocIds.length === 0
          ? []
          : ((await ctx.runQuery(spec.component.public.getLiveStates, {
              collection: spec.tableName,
              docIds: ranged.orderedDocIds,
            })) as Array<LiveStateRecord | null>);
      const sliceStates = rawLiveStates.filter(
        (state): state is LiveStateRecord =>
          Boolean(state && typeof state.docId === "string"),
      );
      const hydrated = await materializeStates(
        ctx,
        spec,
        sliceStates,
        scopeArgs,
      );
      const hydratedById = new Map(
        hydrated.map((entry) => [entry.docId, entry] as const),
      );
      const documents = ranged.orderedDocIds.flatMap((docId) => {
        const entry = hydratedById.get(docId);
        return entry ? [entry] : [];
      });
      return {
        mode: "full",
        collectionSeq: collectionChanges.collectionSeq,
        continueCursor: ranged.continueCursor,
        isDone: ranged.isDone,
        documents,
      };
    }
  }

  let docIdsToHydrate: string[] | null = null;
  if (scoped && scopeArgs) {
    docIdsToHydrate = await getScopedDocIds(ctx, spec, scopeArgs, log);
  }

  if (docIdsToHydrate !== null) {
    const SCOPE_FETCH_PAGE = 32;
    const fullCursor = args.fullCursor ?? null;
    const cursorOffset = parseScopeCursor(fullCursor);
    const sliceStart = cursorOffset;
    const sliceEnd = Math.min(
      docIdsToHydrate.length,
      sliceStart + SCOPE_FETCH_PAGE,
    );
    const sliceIds = docIdsToHydrate.slice(sliceStart, sliceEnd);

    const rawLiveStates =
      sliceIds.length === 0
        ? []
        : ((await ctx.runQuery(spec.component.public.getLiveStates, {
            collection: spec.tableName,
            docIds: sliceIds,
          })) as Array<LiveStateRecord | null>);
    const sliceStates = rawLiveStates.filter(
      (state): state is LiveStateRecord =>
        Boolean(state && typeof state.docId === "string"),
    );
    const documents = await materializeStates(
      ctx,
      spec,
      sliceStates,
      scopeArgs,
    );

    const isDone = sliceEnd >= docIdsToHydrate.length;
    const continueCursor = isDone ? null : encodeScopeCursor(sliceEnd);

    return {
      mode: "full",
      collectionSeq: collectionChanges.collectionSeq,
      continueCursor,
      isDone,
      documents,
    };
  }

  const page = (await ctx.runQuery(spec.component.public.getLiveStatesPage, {
    collection: spec.tableName,
    cursor: args.fullCursor ?? null,
    limit: 64,
  })) as {
    page: Array<LiveStateRecord>;
    continueCursor: string | null;
    isDone: boolean;
  };
  const scopedDocuments = await materializeStates(
    ctx,
    spec,
    page.page,
    scopeArgs,
  );

  const missingRequestedDeletes =
    scoped && knownDocIds.length > 0 && page.isDone
      ? args.documents
          .filter(
            (doc) =>
              !scopedDocuments.some((entry) => entry.docId === doc.docId),
          )
          .map((doc) => ({
            docId: doc.docId,
            deleted: true as const,
            seq: null,
          }))
      : [];

  return {
    mode: collectionChanges.mode,
    collectionSeq: collectionChanges.collectionSeq,
    continueCursor: page.continueCursor,
    isDone: page.isDone,
    documents: [...scopedDocuments, ...missingRequestedDeletes],
  };
}
