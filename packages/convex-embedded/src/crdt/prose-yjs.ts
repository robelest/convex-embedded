import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";

import { normalizeProseContent, type ProseContent } from "@/crdt/prose-lite";

const proseSchema = getSchema([StarterKit]);

export function proseContentToYDoc(value: unknown, fieldName: string): Y.Doc {
  return prosemirrorJSONToYDoc(
    proseSchema,
    normalizeProseContent(value),
    fieldName,
  ) as Y.Doc;
}

export function yDocToProseContent(
  doc: Y.Doc,
  fieldName: string,
): ProseContent {
  return normalizeProseContent(yDocToProsemirrorJSON(doc, fieldName));
}
