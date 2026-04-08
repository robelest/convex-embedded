import { v } from "convex/values";

import { mutation, query } from "../_generated/server.js";
import {
  checkpointDetailValidator,
  checkpointIdValidator,
  checkpointRecordValidator,
  DEFAULT_KEEP_CHECKPOINT_COUNT,
  getCheckpointById,
  getLatestLiveState,
  listAllCheckpoints,
  toCheckpointDetail,
  trimCheckpoints,
} from "../helpers.js";

export const createCheckpoint = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    label: v.optional(v.string()),
    reason: v.optional(v.string()),
    pinned: v.optional(v.boolean()),
    actorId: v.optional(v.string()),
    source: v.optional(v.string()),
    metadata: v.optional(v.any()),
    keepCheckpointCount: v.optional(v.number()),
  },
  returns: v.object({ checkpointId: checkpointIdValidator, seq: v.number() }),
  handler: async (ctx: any, args) => {
    const liveState = await getLatestLiveState(
      ctx,
      args.collection,
      args.docId,
    );
    if (!liveState) {
      throw new Error(
        `[convex-embedded] Cannot create checkpoint for ${args.collection}/${args.docId} without live state.`,
      );
    }

    const tableName = args.pinned ? "pinnedCheckpoints" : "checkpoints";
    const checkpointId = await ctx.db.insert(tableName, {
      collection: args.collection,
      docId: args.docId,
      update: liveState.update,
      seq: liveState.seq,
      byteLength: liveState.byteLength,
      createdAt: Date.now(),
      label: args.label,
      reason: args.reason,
      actorId: args.actorId,
      source: args.source,
      metadata: args.metadata,
    });

    if (!args.pinned) {
      await trimCheckpoints(
        ctx,
        args.collection,
        args.docId,
        Math.max(0, args.keepCheckpointCount ?? DEFAULT_KEEP_CHECKPOINT_COUNT),
      );
    }

    return { checkpointId, seq: liveState.seq };
  },
});

export const listCheckpoints = query({
  args: { collection: v.string(), docId: v.string() },
  returns: v.array(checkpointRecordValidator),
  handler: async (ctx: any, args) => {
    return await listAllCheckpoints(ctx, args.collection, args.docId);
  },
});

export const getCheckpoint = query({
  args: {
    collection: v.string(),
    docId: v.string(),
    checkpointId: checkpointIdValidator,
  },
  returns: v.union(checkpointDetailValidator, v.null()),
  handler: async (ctx: any, args) => {
    const entry = await getCheckpointById(ctx, String(args.checkpointId));
    if (!entry) {
      return null;
    }

    const { checkpoint, pinned } = entry;
    if (
      checkpoint.collection !== args.collection ||
      checkpoint.docId !== args.docId
    ) {
      return null;
    }

    return toCheckpointDetail(checkpoint, pinned);
  },
});
