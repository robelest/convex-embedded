import {
  createEmptyProseContent,
  normalizeProseContent,
  proseContentToPlainText,
} from "@robelest/convex-embedded/server/schema";

export const prose = {
  empty: createEmptyProseContent,
  normalize: normalizeProseContent,
  text: proseContentToPlainText,
} as const;
