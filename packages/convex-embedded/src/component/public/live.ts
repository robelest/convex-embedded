import { v } from "convex/values";
import * as Y from "yjs";

import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server.js";
import {
  bumpCollectionSeq,
  DEFAULT_KEEP_COLLECTION_TAIL_COUNT,
  DEFAULT_KEEP_TAIL_COUNT,
  DEFAULT_TAIL_BYTE_LIMIT,
  getCollectionHead,
  getLatestLiveState,
  isEmptyUpdate,
  listCollectionTail,
  toArrayBuffer,
  trimCollectionTail,
  trimDeltaTail,
} from "../helpers.js";

export const recordUpdate = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    docCreationTime: v.number(),
    keepTailCount: v.optional(v.number()),
    keepCollectionTailCount: v.optional(v.number()),
    tailByteLimit: v.optional(v.number()),
  },
  returns: v.object({
    collectionSeq: v.number(),
    collectionTailDeleted: v.number(),
    seq: v.number(),
    tailKept: v.number(),
    tailDeleted: v.number(),
  }),
  handler: async (ctx: MutationCtx, args) => {
    const now = Date.now();
    const keepTailCount = Math.max(
      0,
      args.keepTailCount ?? DEFAULT_KEEP_TAIL_COUNT,
    );
    const tailByteLimit = Math.max(
      0,
      args.tailByteLimit ?? DEFAULT_TAIL_BYTE_LIMIT,
    );
    const keepCollectionTailCount = Math.max(
      0,
      args.keepCollectionTailCount ?? DEFAULT_KEEP_COLLECTION_TAIL_COUNT,
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
        docCreationTime: args.docCreationTime,
        byteLength: args.update.byteLength,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("liveStates", {
        collection: args.collection,
        docId: args.docId,
        update: args.update,
        seq,
        docCreationTime: args.docCreationTime,
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

    const collectionSeq = await bumpCollectionSeq(ctx, args.collection, {
      docId: args.docId,
      kind: "upsert",
      now,
    });
    const collectionTailResult = await trimCollectionTail(
      ctx,
      args.collection,
      keepCollectionTailCount,
    );

    const tailResult = await trimDeltaTail(
      ctx,
      args.collection,
      args.docId,
      keepTailCount,
      tailByteLimit,
    );

    return {
      collectionSeq,
      collectionTailDeleted: collectionTailResult.deleted,
      seq,
      tailKept: tailResult.kept,
      tailDeleted: tailResult.deleted,
    };
  },
});

export const recordDelete = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    keepCollectionTailCount: v.optional(v.number()),
  },
  returns: v.object({
    collectionSeq: v.number(),
    collectionTailDeleted: v.number(),
    deletedLiveState: v.boolean(),
    deletedDeltaCount: v.number(),
  }),
  handler: async (ctx: MutationCtx, args) => {
    const now = Date.now();
    const keepCollectionTailCount = Math.max(
      0,
      args.keepCollectionTailCount ?? DEFAULT_KEEP_COLLECTION_TAIL_COUNT,
    );
    const current = await getLatestLiveState(ctx, args.collection, args.docId);
    if (current) {
      await ctx.db.delete(current._id);
    }

    let deletedDeltaEntries = 0;
    let tailCursor: string | null = null;
    let tailDone = false;
    while (!tailDone) {
      const tailPage = await ctx.db
        .query("deltaTail")
        .withIndex("by_collection_doc_seq", (q) =>
          q.eq("collection", args.collection).eq("docId", args.docId),
        )
        .paginate({ cursor: tailCursor, numItems: 100 });
      for (const entry of tailPage.page) {
        await ctx.db.delete(entry._id);
        deletedDeltaEntries++;
      }
      tailDone = tailPage.isDone;
      tailCursor = tailPage.continueCursor;
    }

    const collectionSeq = await bumpCollectionSeq(ctx, args.collection, {
      docId: args.docId,
      kind: "delete",
      now,
    });
    const collectionTailResult = await trimCollectionTail(
      ctx,
      args.collection,
      keepCollectionTailCount,
    );

    return {
      collectionSeq,
      collectionTailDeleted: collectionTailResult.deleted,
      deletedLiveState: current !== null,
      deletedDeltaCount: deletedDeltaEntries,
    };
  },
});

export const getLiveState = query({
  args: { collection: v.string(), docId: v.string() },
  returns: v.union(
    v.object({
      update: v.bytes(),
      seq: v.number(),
      docCreationTime: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx: QueryCtx, args) => {
    const state = await getLatestLiveState(ctx, args.collection, args.docId);
    return state
      ? {
          update: state.update,
          seq: state.seq,
          docCreationTime: state.docCreationTime,
        }
      : null;
  },
});

export const getLiveStates = query({
  args: { collection: v.string(), docIds: v.optional(v.array(v.string())) },
  returns: v.array(
    v.union(
      v.object({
        docId: v.string(),
        update: v.bytes(),
        seq: v.number(),
        docCreationTime: v.optional(v.number()),
      }),
      v.null(),
    ),
  ),
  handler: async (ctx: QueryCtx, args) => {
    if (args.docIds === undefined) {
      const results: Array<{
        docId: string;
        update: ArrayBuffer;
        seq: number;
        docCreationTime?: number;
      }> = [];
      let cursor: string | null = null;
      let isDone = false;
      while (!isDone) {
        const page = await ctx.db
          .query("liveStates")
          .withIndex("by_collection_doc", (q) =>
            q.eq("collection", args.collection),
          )
          .paginate({ cursor, numItems: 100 });
        for (const state of page.page) {
          results.push({
            docId: state.docId,
            update: state.update,
            seq: state.seq,
            docCreationTime: state.docCreationTime,
          });
        }
        isDone = page.isDone;
        cursor = page.continueCursor;
      }
      return results;
    }

    if (args.docIds.length === 0) {
      return [];
    }

    const results = await Promise.all(
      args.docIds.map(async (docId) => {
        const state = await ctx.db
          .query("liveStates")
          .withIndex("by_collection_doc", (q) =>
            q.eq("collection", args.collection).eq("docId", docId),
          )
          .unique();
        return state
          ? {
              docId,
              update: state.update,
              seq: state.seq,
              docCreationTime: state.docCreationTime,
            }
          : null;
      }),
    );
    return results;
  },
});

export const getLiveStatesPage = query({
  args: {
    collection: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    page: v.array(
      v.object({
        docId: v.string(),
        update: v.bytes(),
        seq: v.number(),
        docCreationTime: v.optional(v.number()),
      }),
    ),
    continueCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx: QueryCtx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 64, 128));
    const query = ctx.db
      .query("liveStates")
      .withIndex("by_collection_doc", (q) => {
        const builder = q.eq("collection", args.collection);
        return args.cursor ? builder.gt("docId", args.cursor) : builder;
      });
    const rows = await query.take(limit + 1);
    const pageRows = rows.slice(0, limit);
    const lastRow = pageRows[pageRows.length - 1] ?? null;

    return {
      page: pageRows.map((state) => ({
        docId: String(state.docId),
        update: state.update,
        seq: state.seq,
        docCreationTime: state.docCreationTime,
      })),
      continueCursor:
        rows.length > limit && lastRow ? String(lastRow.docId) : null,
      isDone: rows.length <= limit,
    };
  },
});

export const getCollectionChanges = query({
  args: {
    collection: v.string(),
    sinceSeq: v.union(v.number(), v.null()),
  },
  returns: v.object({
    mode: v.union(v.literal("full"), v.literal("incremental")),
    collectionSeq: v.number(),
    isGapDetected: v.boolean(),
    changes: v.array(
      v.object({
        docId: v.string(),
        kind: v.union(v.literal("upsert"), v.literal("delete")),
      }),
    ),
  }),
  handler: async (ctx: QueryCtx, args) => {
    const head = await getCollectionHead(ctx, args.collection);
    const collectionSeq = head ? Number(head.seq) : -1;

    if (args.sinceSeq === null) {
      return {
        mode: "full" as const,
        collectionSeq,
        isGapDetected: false,
        changes: [],
      };
    }

    const tail = await listCollectionTail(ctx, args.collection, args.sinceSeq);
    const firstTailSeq = tail.length > 0 ? Number(tail[0].seq) : null;
    const isGapDetected =
      args.sinceSeq > collectionSeq ||
      (args.sinceSeq < collectionSeq &&
        (firstTailSeq === null || firstTailSeq !== args.sinceSeq + 1));

    if (isGapDetected) {
      return {
        mode: "full" as const,
        collectionSeq,
        isGapDetected: true,
        changes: [],
      };
    }

    const latestByDoc = new Map<string, "upsert" | "delete">();
    for (const entry of tail) {
      latestByDoc.set(String(entry.docId), entry.kind);
    }

    return {
      mode: "incremental" as const,
      collectionSeq,
      isGapDetected: false,
      changes: Array.from(latestByDoc.entries()).map(([docId, kind]) => ({
        docId,
        kind,
      })),
    };
  },
});
