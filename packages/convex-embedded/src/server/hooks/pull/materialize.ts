import type { GenericDataModel, GenericQueryCtx } from "convex/server";
import type { GenericId } from "convex/values";

import { materializeDocumentFromUpdate } from "@/shared/yjs";

import { matchesScopeArgs } from "./scope";
import type { LiveStateRecord, PullSpec } from "./types";

export async function materializeStates(
  ctx: GenericQueryCtx<GenericDataModel>,
  spec: PullSpec,
  rawStates: LiveStateRecord[],
  scopeArgs?: Record<string, unknown>,
): Promise<
  Array<{
    docId: string;
    document: Record<string, unknown>;
    seq: number;
  }>
> {
  const canDbGet = typeof ctx.db?.get === "function";
  const documents: Array<Record<string, unknown> | null> = canDbGet
    ? await Promise.all(
        rawStates.map((state) => ctx.db.get(state.docId as GenericId<string>)),
      )
    : rawStates.map(() => null);

  return rawStates
    .map((state, i) => ({
      docId: state.docId,
      document:
        documents[i] ??
        materializeDocumentFromUpdate({
          schemaDef: spec.schemaDef,
          docId: state.docId,
          docCreationTime: state.docCreationTime ?? state._creationTime ?? 0,
          update: state.update,
        }),
      seq: state.seq,
    }))
    .filter((entry) =>
      scopeArgs
        ? matchesScopeArgs(entry.document as Record<string, unknown>, scopeArgs)
        : true,
    );
}
