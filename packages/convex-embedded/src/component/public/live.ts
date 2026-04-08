import { v } from "convex/values";
import * as Y from "yjs";

import { mutation, query } from "../_generated/server.js";
import {
  DEFAULT_KEEP_TAIL_COUNT,
  DEFAULT_TAIL_BYTE_LIMIT,
  getLatestLiveState,
  isEmptyUpdate,
  toArrayBuffer,
  trimDeltaTail,
} from "../helpers.js";

export const recordUpdate = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    keepTailCount: v.optional(v.number()),
    tailByteLimit: v.optional(v.number()),
  },
  returns: v.object({
    seq: v.number(),
    tailKept: v.number(),
    tailDeleted: v.number(),
  }),
  handler: async (ctx: any, args) => {
    const now = Date.now();
    const keepTailCount = Math.max(
      0,
      args.keepTailCount ?? DEFAULT_KEEP_TAIL_COUNT,
    );
    const tailByteLimit = Math.max(
      0,
      args.tailByteLimit ?? DEFAULT_TAIL_BYTE_LIMIT,
    );

    const current = await getLatestLiveState(ctx, args.collection, args.docId);
    const seq = current ? Number(current.seq) + 1 : 0;
    const nextUpdate = new Uint8Array(args.update);

    let tailUpdate: Uint8Array = nextUpdate;
    if (current?.update) {
      const previousVector = Y.encodeStateVectorFromUpdateV2(
        new Uint8Array(current.update),
      );
      tailUpdate = Y.diffUpdateV2(nextUpdate, previousVector);
    }

    if (current) {
      await ctx.db.patch(current._id, {
        update: args.update,
        seq,
        byteLength: args.update.byteLength,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("liveStates", {
        collection: args.collection,
        docId: args.docId,
        update: args.update,
        seq,
        byteLength: args.update.byteLength,
        updatedAt: now,
      });
    }

    if (!isEmptyUpdate(tailUpdate)) {
      await ctx.db.insert("deltaTail", {
        collection: args.collection,
        docId: args.docId,
        update: toArrayBuffer(tailUpdate),
        seq,
        byteLength: tailUpdate.byteLength,
        createdAt: now,
      });
    }

    const tailResult = await trimDeltaTail(
      ctx,
      args.collection,
      args.docId,
      keepTailCount,
      tailByteLimit,
    );

    return {
      seq,
      tailKept: tailResult.kept,
      tailDeleted: tailResult.deleted,
    };
  },
});

export const getLiveState = query({
  args: { collection: v.string(), docId: v.string() },
  returns: v.union(v.object({ update: v.bytes(), seq: v.number() }), v.null()),
  handler: async (ctx: any, args) => {
    const state = await getLatestLiveState(ctx, args.collection, args.docId);
    return state ? { update: state.update, seq: state.seq } : null;
  },
});

export const getLiveStates = query({
  args: { collection: v.string(), docIds: v.optional(v.array(v.string())) },
  returns: v.array(
    v.union(
      v.object({ docId: v.string(), update: v.bytes(), seq: v.number() }),
      v.null(),
    ),
  ),
  handler: async (ctx: any, args) => {
    if (args.docIds === undefined) {
      const states = await ctx.db
        .query("liveStates")
        .withIndex("by_collection_doc", (q: any) =>
          q.eq("collection", args.collection),
        )
        .collect();

      return states.map((state: any) => ({
        docId: state.docId,
        update: state.update,
        seq: state.seq,
      }));
    }

    const results: Array<{
      docId: string;
      update: ArrayBuffer;
      seq: number;
    } | null> = [];
    for (const docId of args.docIds) {
      const state = await getLatestLiveState(ctx, args.collection, docId);
      results.push(
        state ? { docId, update: state.update, seq: state.seq } : null,
      );
    }
    return results;
  },
});
