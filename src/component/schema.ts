import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Component schema for convex-resolve.
 *
 * The `deltas` table stores full Yjs state snapshots recorded after each
 * mutation on a registered table. Each delta is a complete
 * Y.encodeStateAsUpdateV2(doc), not an incremental diff.
 *
 * The `resolve` action only needs the latest delta per document to compute
 * a diff against the client's state vector.
 */
export default defineSchema({
  deltas: defineTable({
    /** The app table this delta belongs to (e.g. "tasks"). */
    collection: v.string(),
    /** The document ID within that table. */
    docId: v.string(),
    /** Full Yjs state snapshot as binary (Y.encodeStateAsUpdateV2). */
    update: v.bytes(),
    /** Monotonically increasing sequence number per (collection, docId). */
    seq: v.number(),
    /** Timestamp when this delta was recorded. */
    createdAt: v.number(),
  })
    .index("by_collection_doc", ["collection", "docId"])
    .index("by_collection_doc_seq", ["collection", "docId", "seq"]),
});
