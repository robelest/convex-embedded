export type ProseContent = {
  type: string;
  content?: ProseContent[];
  text?: string;
};

export function createEmptyProseContent(): ProseContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function normalizeProseContent(value: unknown): ProseContent {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "doc"
  ) {
    return value as ProseContent;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return createEmptyProseContent();
    }
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: value }],
        },
      ],
    };
  }

  return createEmptyProseContent();
}

export function cloneProseContent(value: unknown): ProseContent {
  return JSON.parse(
    JSON.stringify(normalizeProseContent(value)),
  ) as ProseContent;
}

function nodeText(node: unknown): string {
  if (!node || typeof node !== "object") {
    return "";
  }

  const current = node as {
    type?: string;
    text?: string;
    content?: unknown[];
  };

  if (current.type === "text") {
    return current.text ?? "";
  }

  const children = Array.isArray(current.content) ? current.content : [];
  const childText = children.map((child) => nodeText(child)).join("");

  switch (current.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
    case "listItem":
      return childText.length > 0 ? `${childText}\n` : "";
    case "hardBreak":
      return "\n";
    default:
      return childText;
  }
}

export function proseContentToPlainText(value: unknown): string {
  return nodeText(normalizeProseContent(value))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
