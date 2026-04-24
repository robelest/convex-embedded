import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Component schema for convex-embedded.
 *
 * Storage roles are intentionally separated:
 * - `liveStates`: one authoritative merged Yjs state per document used by resolve.
 * - `deltaTail`: a bounded recent update log for diagnostics and operational context.
 *
 * `docId` remains a plain string on purpose. These tables are generic across
 * collections/components, so Convex `v.id(...)` validators would be misleading
 * here: cross-component document references are not typed foreign keys.
 */
export default defineSchema({
  collectionHeads: defineTable({
    collection: v.string(),
    seq: v.number(),
    updatedAt: v.number(),
  }).index("by_collection", ["collection"]),

  collectionTail: defineTable({
    collection: v.string(),
    seq: v.number(),
    docId: v.string(),
    kind: v.union(v.literal("upsert"), v.literal("delete")),
    createdAt: v.number(),
  }).index("by_collection_seq", ["collection", "seq"]),

  liveStates: defineTable({
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    seq: v.number(),
    docCreationTime: v.optional(v.number()),
    byteLength: v.number(),
    updatedAt: v.number(),
  }).index("by_collection_doc", ["collection", "docId"]),

  deltaTail: defineTable({
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    seq: v.number(),
    byteLength: v.number(),
    createdAt: v.number(),
  }).index("by_collection_doc_seq", ["collection", "docId", "seq"]),
});
