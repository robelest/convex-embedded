import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Component schema for convex-embedded.
 *
 * Storage roles are intentionally separated:
 * - `liveStates`: one authoritative merged Yjs state per document used by resolve.
 * - `deltaTail`: a bounded recent update log for diagnostics and operational context.
 * - `checkpoints`: bounded recent restore points kept by retention policy.
 * - `pinnedCheckpoints`: explicit archival restore points kept off the hot path.
 */
export default defineSchema({
  liveStates: defineTable({
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    seq: v.number(),
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

  checkpoints: defineTable({
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    seq: v.number(),
    byteLength: v.number(),
    createdAt: v.number(),
    label: v.optional(v.string()),
    reason: v.optional(v.string()),
    actorId: v.optional(v.string()),
    source: v.optional(v.string()),
    metadata: v.optional(v.any()),
  }).index("by_collection_doc_createdAt", ["collection", "docId", "createdAt"]),

  pinnedCheckpoints: defineTable({
    collection: v.string(),
    docId: v.string(),
    update: v.bytes(),
    seq: v.number(),
    byteLength: v.number(),
    createdAt: v.number(),
    label: v.optional(v.string()),
    reason: v.optional(v.string()),
    actorId: v.optional(v.string()),
    source: v.optional(v.string()),
    metadata: v.optional(v.any()),
  }).index("by_collection_doc_createdAt", ["collection", "docId", "createdAt"]),
});
