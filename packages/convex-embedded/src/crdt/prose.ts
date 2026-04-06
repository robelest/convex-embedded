export type { ProseContent } from "@/crdt/prose-lite";

export {
  cloneProseContent,
  createEmptyProseContent,
  normalizeProseContent,
  proseContentToPlainText,
} from "@/crdt/prose-lite";

export { proseContentToYDoc, yDocToProseContent } from "@/crdt/prose-yjs";
