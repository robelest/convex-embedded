export type { ProseContent, ProseMark } from "@/crdt/prose/content";

export {
  cloneProseContent,
  createEmptyProseContent,
  normalizeProseContent,
  proseContentToPlainText,
} from "@/crdt/prose/content";

export { proseContentToYDoc, yDocToProseContent } from "@/crdt/prose/yjs";
