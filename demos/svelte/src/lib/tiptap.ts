import { prose, type ProseContent } from "@robelest/convex-embedded/crdt";
import { type Extensions } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { generateHTML } from "@tiptap/html";
import StarterKit from "@tiptap/starter-kit";

export const tiptapExtensions: Extensions = [
  StarterKit,
  Placeholder.configure({
    placeholder: ({ node }) =>
      node.type.name === "paragraph" ? "Write something..." : "",
  }),
];

export function createEmptyRichTextContent(): ProseContent {
  return prose.empty();
}

export function normalizeRichTextContent(value: unknown): ProseContent {
  return prose.normalize(value);
}

export function richTextToPlainText(value: unknown): string {
  return prose.text(value);
}

export function cloneRichTextContent(value: unknown): ProseContent {
  return JSON.parse(JSON.stringify(prose.normalize(value))) as ProseContent;
}

export function renderRichTextHtml(value: unknown): string {
  return generateHTML(normalizeRichTextContent(value), tiptapExtensions);
}
