import { v } from "convex/values";

/**
 * Shared constants, validators, and helper routines for the public component
 * API defined in `public.ts`.
 *
 * @internal
 */

export const DEFAULT_KEEP_TAIL_COUNT = 64;
export const DEFAULT_TAIL_BYTE_LIMIT = 256 * 1024;
export const DEFAULT_KEEP_CHECKPOINT_COUNT = 10;
const EMPTY_YJS_V2_UPDATE = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];

export const checkpointIdValidator = v.union(
  v.id("checkpoints"),
  v.id("pinnedCheckpoints"),
);

export const checkpointRecordValidator = v.object({
  checkpointId: checkpointIdValidator,
  seq: v.number(),
  byteLength: v.number(),
  createdAt: v.number(),
  label: v.optional(v.string()),
  reason: v.optional(v.string()),
  pinned: v.boolean(),
  actorId: v.optional(v.string()),
  source: v.optional(v.string()),
  metadata: v.optional(v.any()),
});

export const checkpointDetailValidator = v.object({
  checkpointId: checkpointIdValidator,
  update: v.bytes(),
  seq: v.number(),
  byteLength: v.number(),
  createdAt: v.number(),
  label: v.optional(v.string()),
  reason: v.optional(v.string()),
  pinned: v.boolean(),
  actorId: v.optional(v.string()),
  source: v.optional(v.string()),
  metadata: v.optional(v.any()),
});

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export function isEmptyUpdate(update: Uint8Array): boolean {
  return (
    update.byteLength === 0 ||
    (update.byteLength === EMPTY_YJS_V2_UPDATE.length &&
      update.every((value, index) => EMPTY_YJS_V2_UPDATE[index] === value))
  );
}

export async function getLatestLiveState(
  ctx: any,
  collection: string,
  docId: string,
) {
  return await ctx.db
    .query("liveStates")
    .withIndex("by_collection_doc", (q: any) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
}

export async function trimDeltaTail(
  ctx: any,
  collection: string,
  docId: string,
  keepTailCount: number,
  tailByteLimit: number,
) {
  const entries = await ctx.db
    .query("deltaTail")
    .withIndex("by_collection_doc_seq", (q: any) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .order("desc")
    .collect();

  let retainedBytes = 0;
  const toDelete: Array<string> = [];

  entries.forEach((entry: any, index: number) => {
    const nextBytes = retainedBytes + Number(entry.byteLength ?? 0);
    const withinCount = index < keepTailCount;
    const withinBytes = nextBytes <= tailByteLimit;

    if (withinCount && withinBytes) {
      retainedBytes = nextBytes;
      return;
    }

    toDelete.push(String(entry._id));
  });

  for (const id of toDelete) {
    await ctx.db.delete(id);
  }

  return {
    kept: entries.length - toDelete.length,
    deleted: toDelete.length,
    retainedBytes,
  };
}

export async function trimCheckpoints(
  ctx: any,
  collection: string,
  docId: string,
  keepCheckpointCount: number,
) {
  const checkpoints = await ctx.db
    .query("checkpoints")
    .withIndex("by_collection_doc_createdAt", (q: any) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .order("desc")
    .collect();

  let keptUnpinned = 0;
  const toDelete: Array<string> = [];

  checkpoints.forEach((checkpoint: any) => {
    if (keptUnpinned < keepCheckpointCount) {
      keptUnpinned += 1;
      return;
    }

    toDelete.push(String(checkpoint._id));
  });

  for (const id of toDelete) {
    await ctx.db.delete(id);
  }

  return {
    kept: checkpoints.length - toDelete.length,
    deleted: toDelete.length,
  };
}

export async function listPinnedCheckpoints(
  ctx: any,
  collection: string,
  docId: string,
) {
  return await ctx.db
    .query("pinnedCheckpoints")
    .withIndex("by_collection_doc_createdAt", (q: any) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .order("desc")
    .collect();
}

export function toCheckpointRecord(checkpoint: any, pinned: boolean) {
  return {
    checkpointId: checkpoint._id,
    seq: checkpoint.seq,
    byteLength: checkpoint.byteLength,
    createdAt: checkpoint.createdAt,
    label: checkpoint.label,
    reason: checkpoint.reason,
    pinned,
    actorId: checkpoint.actorId,
    source: checkpoint.source,
    metadata: checkpoint.metadata,
  };
}

export function toCheckpointDetail(checkpoint: any, pinned: boolean) {
  return {
    checkpointId: checkpoint._id,
    update: checkpoint.update,
    seq: checkpoint.seq,
    byteLength: checkpoint.byteLength,
    createdAt: checkpoint.createdAt,
    label: checkpoint.label,
    reason: checkpoint.reason,
    pinned,
    actorId: checkpoint.actorId,
    source: checkpoint.source,
    metadata: checkpoint.metadata,
  };
}

export async function listAllCheckpoints(
  ctx: any,
  collection: string,
  docId: string,
) {
  const [checkpoints, pinnedCheckpoints] = await Promise.all([
    ctx.db
      .query("checkpoints")
      .withIndex("by_collection_doc_createdAt", (q: any) =>
        q.eq("collection", collection).eq("docId", docId),
      )
      .order("desc")
      .collect(),
    listPinnedCheckpoints(ctx, collection, docId),
  ]);

  return [
    ...checkpoints.map((checkpoint: any) =>
      toCheckpointRecord(checkpoint, false),
    ),
    ...pinnedCheckpoints.map((checkpoint: any) =>
      toCheckpointRecord(checkpoint, true),
    ),
  ].sort((left, right) => right.createdAt - left.createdAt);
}

export async function getCheckpointById(ctx: any, checkpointId: string) {
  const unpinnedId = ctx.db.normalizeId?.("checkpoints", checkpointId) ?? null;
  if (unpinnedId) {
    const checkpoint = await ctx.db.get(unpinnedId);
    if (checkpoint) {
      return { checkpoint, pinned: false };
    }
  }

  const pinnedId =
    ctx.db.normalizeId?.("pinnedCheckpoints", checkpointId) ?? null;
  if (!pinnedId) {
    return null;
  }

  const checkpoint = await ctx.db.get(pinnedId);
  return checkpoint ? { checkpoint, pinned: true } : null;
}
