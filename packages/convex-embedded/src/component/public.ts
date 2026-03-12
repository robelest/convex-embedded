/**
 * Public component functions exposed to the consuming app.
 *
 * The consuming app calls these via:
 *   ctx.runMutation(components.resolve.public.insertDelta, { ... })
 *   ctx.runQuery(components.resolve.public.getLatestDelta, { ... })
 *
 * In a deployed component, these import from "./_generated/server.js".
 * During development/build, we type them using convex/server generics.
 */
import { v } from "convex/values";

import { mutation, query } from "./_generated/server.js";

// ---------------------------------------------------------------------------
// insertDelta — records a Yjs state snapshot after a mutation
// ---------------------------------------------------------------------------

/**
 * Records a full Yjs state snapshot for a document.
 * Called by the builders() mutation wrapper via ctx.scheduler.runAfter(0, ...).
 */
export const insertDelta = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx: any, args) => {
    const latest = await ctx.db
      .query("deltas")
      .withIndex("by_collection_doc_seq", (q: any) =>
        q.eq("collection", args.collection).eq("docId", args.docId),
      )
      .order("desc")
      .first();

    const seq = latest ? latest.seq + 1 : 0;

    await ctx.db.insert("deltas", {
      collection: args.collection,
      docId: args.docId,
      update: args.update,
      seq,
      createdAt: Date.now(),
    });

    return null;
  },
});

// ---------------------------------------------------------------------------
// getLatestDelta — reads the most recent delta for a single document
// ---------------------------------------------------------------------------

export const getLatestDelta = query({
  args: {
    collection: v.string(),
    docId: v.string(),
  },
  returns: v.union(
    v.object({
      update: v.bytes(),
      seq: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx: any, args) => {
    const delta = await ctx.db
      .query("deltas")
      .withIndex("by_collection_doc_seq", (q: any) =>
        q.eq("collection", args.collection).eq("docId", args.docId),
      )
      .order("desc")
      .first();

    if (!delta) return null;
    return { update: delta.update, seq: delta.seq };
  },
});

// ---------------------------------------------------------------------------
// getLatestDeltas — batch read for multi-document resolve
// ---------------------------------------------------------------------------

export const getLatestDeltas = query({
  args: {
    collection: v.string(),
    docIds: v.array(v.string()),
  },
  returns: v.array(
    v.union(
      v.object({
        docId: v.string(),
        update: v.bytes(),
        seq: v.number(),
      }),
      v.null(),
    ),
  ),
  handler: async (ctx: any, args) => {
    const results: Array<{
      docId: string;
      update: ArrayBuffer;
      seq: number;
    } | null> = [];

    for (const docId of args.docIds) {
      const delta = await ctx.db
        .query("deltas")
        .withIndex("by_collection_doc_seq", (q: any) =>
          q.eq("collection", args.collection).eq("docId", docId),
        )
        .order("desc")
        .first();

      if (delta) {
        results.push({ docId, update: delta.update, seq: delta.seq });
      } else {
        results.push(null);
      }
    }

    return results;
  },
});

// ---------------------------------------------------------------------------
// cleanup — removes old deltas, keeping only the latest N per document
// ---------------------------------------------------------------------------

export const cleanup = mutation({
  args: {
    collection: v.string(),
    docId: v.string(),
    keepLatest: v.optional(v.number()),
  },
  returns: v.object({
    deleted: v.number(),
    kept: v.number(),
  }),
  handler: async (ctx: any, args) => {
    const keep = args.keepLatest ?? 1;

    const allDeltas = await ctx.db
      .query("deltas")
      .withIndex("by_collection_doc_seq", (q: any) =>
        q.eq("collection", args.collection).eq("docId", args.docId),
      )
      .order("desc")
      .collect();

    const toDelete = allDeltas.slice(keep);
    for (const delta of toDelete) {
      await ctx.db.delete(delta._id);
    }

    return { deleted: toDelete.length, kept: Math.min(allDeltas.length, keep) };
  },
});
