import type { GenericDataModel, GenericQueryCtx } from "convex/server";
import type { GenericId } from "convex/values";

import type { PullResponse } from "@/shared/types";
import { computeDiff, isDiffEmpty } from "@/shared/yjs";

import { matchesScopeArgs } from "./scope";
import type { PullHandlerArgs, PullSpec } from "./types";

interface CollectionChanges {
  mode: "full" | "incremental";
  collectionSeq: number;
  changes: Array<{ docId: string; kind: "upsert" | "delete" }>;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

export async function runPullIncremental(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  args: PullHandlerArgs,
  collectionChanges: CollectionChanges,
  log: { error: (msg: string, error: unknown) => void },
): Promise<PullResponse> {
  const requestedIds = new Set(args.documents.map((doc) => doc.docId));
  const changedById = new Map(
    collectionChanges.changes.map(
      (change) => [change.docId, change.kind] as const,
    ),
  );

  const remoteOnlyChanges =
    typeof ctx.db?.get !== "function"
      ? []
      : collectionChanges.changes.filter(
          (change) =>
            change.kind === "upsert" && !requestedIds.has(change.docId),
        );

  const needsStateDocIds: string[] = [];
  for (const doc of args.documents) {
    const changeKind = changedById.get(doc.docId);
    if (changeKind !== "delete") {
      needsStateDocIds.push(doc.docId);
    }
  }
  for (const change of remoteOnlyChanges) {
    needsStateDocIds.push(change.docId);
  }

  const rawBatchStates =
    needsStateDocIds.length === 0
      ? []
      : ((await ctx.runQuery(spec.component.public.getLiveStates, {
          collection: spec.tableName,
          docIds: needsStateDocIds,
        })) as Array<{
          docId: string;
          update: ArrayBuffer;
          seq: number;
        } | null>);

  const liveStateMap = new Map<string, { update: ArrayBuffer; seq: number }>();
  for (const state of rawBatchStates) {
    if (state && typeof state.docId === "string") {
      liveStateMap.set(state.docId, state);
    }
  }

  const scopeDocCache = new Map<string, Record<string, unknown> | null>();
  if (args.scopeArgs && typeof ctx.db?.get === "function") {
    const upsertDocIds = args.documents
      .filter((doc) => changedById.get(doc.docId) === "upsert")
      .map((doc) => doc.docId);
    const scopeDocs = await Promise.all(
      upsertDocIds.map((id) => ctx.db.get(id as GenericId<string>)),
    );
    upsertDocIds.forEach((id, i) =>
      scopeDocCache.set(id, scopeDocs[i] ?? null),
    );
  }

  const requestedResults = args.documents.map((doc) => {
    const changeKind = changedById.get(doc.docId);
    if (changeKind === undefined) {
      const latest = liveStateMap.get(doc.docId) ?? null;
      if (!latest || latest.seq <= (doc.lastSeq ?? -1)) {
        return { docId: doc.docId, seq: doc.lastSeq };
      }
      try {
        const diff = computeDiff(
          new Uint8Array(latest.update),
          new Uint8Array(doc.vector),
        );
        if (isDiffEmpty(diff)) {
          return { docId: doc.docId, seq: latest.seq };
        }
        return {
          docId: doc.docId,
          diff: toArrayBuffer(diff),
          seq: latest.seq,
        };
      } catch (error) {
        log.error(
          `pull: failed to compute diff for ${spec.tableName}/${doc.docId}`,
          error,
        );
        return { docId: doc.docId, seq: latest.seq };
      }
    }

    if (changeKind === "delete") {
      return { docId: doc.docId, deleted: true as const, seq: null };
    }

    if (args.scopeArgs && scopeDocCache.has(doc.docId)) {
      const currentDocument = scopeDocCache.get(doc.docId);
      if (
        !currentDocument ||
        !matchesScopeArgs(
          currentDocument as Record<string, unknown>,
          args.scopeArgs as Record<string, unknown>,
        )
      ) {
        return { docId: doc.docId, deleted: true as const, seq: null };
      }
    }

    const latest = liveStateMap.get(doc.docId) ?? null;
    if (!latest) {
      return { docId: doc.docId, deleted: true as const, seq: null };
    }

    try {
      const diff = computeDiff(
        new Uint8Array(latest.update),
        new Uint8Array(doc.vector),
      );
      if (isDiffEmpty(diff)) {
        return { docId: doc.docId, seq: latest.seq };
      }
      return {
        docId: doc.docId,
        diff: toArrayBuffer(diff),
        seq: latest.seq,
      };
    } catch (error) {
      log.error(
        `pull: failed to compute diff for ${spec.tableName}/${doc.docId}`,
        error,
      );
      return { docId: doc.docId, seq: latest.seq };
    }
  });

  const remoteOnlyDocuments =
    remoteOnlyChanges.length === 0
      ? []
      : await Promise.all(
          remoteOnlyChanges.map((change) =>
            ctx.db.get(change.docId as GenericId<string>),
          ),
        );
  const remoteOnlyResults = remoteOnlyChanges
    .map((change, i) => {
      const document = remoteOnlyDocuments[i];
      if (
        document &&
        !matchesScopeArgs(
          document as Record<string, unknown>,
          args.scopeArgs as Record<string, unknown> | undefined,
        )
      ) {
        return null;
      }
      const latest = liveStateMap.get(change.docId) ?? null;
      return document
        ? { docId: change.docId, document, seq: latest?.seq ?? null }
        : { docId: change.docId, deleted: true as const, seq: null };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null);

  return {
    mode: collectionChanges.mode,
    collectionSeq: collectionChanges.collectionSeq,
    documents: [...requestedResults, ...remoteOnlyResults],
  };
}
