import { v } from "convex/values";

import { mutation } from "../_generated/server.js";
import {
  DEFAULT_KEEP_CHECKPOINT_COUNT,
  DEFAULT_KEEP_TAIL_COUNT,
  DEFAULT_TAIL_BYTE_LIMIT,
  listPinnedCheckpoints,
  trimCheckpoints,
  trimDeltaTail,
} from "../helpers.js";

export const cleanupDoc = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    keepTailCount: v.optional(v.number()),
    tailByteLimit: v.optional(v.number()),
    keepCheckpointCount: v.optional(v.number()),
  },
  returns: v.object({
    tailDeleted: v.number(),
    tailKept: v.number(),
    checkpointDeleted: v.number(),
    checkpointKept: v.number(),
  }),
  handler: async (ctx: any, args) => {
    const tailResult = await trimDeltaTail(
      ctx,
      args.collection,
      args.docId,
      Math.max(0, args.keepTailCount ?? DEFAULT_KEEP_TAIL_COUNT),
      Math.max(0, args.tailByteLimit ?? DEFAULT_TAIL_BYTE_LIMIT),
    );
    const checkpointResult = await trimCheckpoints(
      ctx,
      args.collection,
      args.docId,
      Math.max(0, args.keepCheckpointCount ?? DEFAULT_KEEP_CHECKPOINT_COUNT),
    );
    const pinnedCheckpoints = await listPinnedCheckpoints(
      ctx,
      args.collection,
      args.docId,
    );

    return {
      tailDeleted: tailResult.deleted,
      tailKept: tailResult.kept,
      checkpointDeleted: checkpointResult.deleted,
      checkpointKept: checkpointResult.kept + pinnedCheckpoints.length,
    };
  },
});
