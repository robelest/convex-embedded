import * as Y from "yjs";

import {
  normalizeProseContent,
  type ProseContent,
  type ProseMark,
} from "@/crdt/prose/content";

const ATTRS_KEY = "convex_attrs";
const META_KEY = "convex_meta";
const MARKS_KEY = "convex_marks";

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function getNodeMeta(node: ProseContent): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (
      key === "type" ||
      key === "content" ||
      key === "text" ||
      key === "attrs" ||
      key === "marks"
    ) {
      continue;
    }
    meta[key] = value;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

function appendChildren(
  parent: Y.XmlElement | Y.XmlFragment,
  children: Array<Y.XmlElement | Y.XmlText>,
): void {
  if (children.length === 0) {
    return;
  }

  parent.insert(0, children);
}

function contentNodeToXmlNodes(
  node: ProseContent,
): Array<Y.XmlElement | Y.XmlText> {
  if (node.type === "text") {
    const textNode = new Y.XmlText();

    const attributes: Record<string, unknown> = {};
    if (Array.isArray(node.marks) && node.marks.length > 0) {
      attributes[MARKS_KEY] = JSON.stringify(node.marks);
    }
    const meta = getNodeMeta(node);
    if (meta) {
      attributes[META_KEY] = JSON.stringify(meta);
    }
    textNode.insert(
      0,
      node.text ?? "",
      Object.keys(attributes).length > 0 ? attributes : undefined,
    );
    return [textNode];
  }

  const element = new Y.XmlElement(node.type);

  if (node.attrs && Object.keys(node.attrs).length > 0) {
    element.setAttribute(ATTRS_KEY, JSON.stringify(node.attrs));
  }
  const meta = getNodeMeta(node);
  if (meta) {
    element.setAttribute(META_KEY, JSON.stringify(meta));
  }

  appendChildren(
    element,
    (Array.isArray(node.content) ? node.content : []).flatMap((child) =>
      contentNodeToXmlNodes(child),
    ),
  );

  return [element];
}

function xmlTextToContent(textNode: Y.XmlText): ProseContent[] {
  const delta = textNode.toDelta() as Array<{
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }>;

  if (delta.length === 0) {
    return [];
  }

  return delta.flatMap((part) => {
    if (typeof part.insert !== "string" || part.insert.length === 0) {
      return [];
    }

    const node: ProseContent = { type: "text", text: part.insert };
    const marks = parseJson<ProseMark[]>(part.attributes?.[MARKS_KEY]);
    if (marks && marks.length > 0) {
      node.marks = marks;
    }
    const meta = parseJson<Record<string, unknown>>(
      part.attributes?.[META_KEY],
    );
    if (meta) {
      const { type: _t, text: _x, marks: _m, ...safe } = meta;
      Object.assign(node, safe);
    }
    return [node];
  });
}

function xmlChildrenToContent(
  parent: Y.XmlElement | Y.XmlFragment,
): ProseContent[] {
  return parent.toArray().flatMap((child) => {
    if (child instanceof Y.XmlText) {
      return xmlTextToContent(child);
    }

    if (child instanceof Y.XmlElement) {
      const node: ProseContent = {
        type: child.nodeName,
      };
      const attrs = parseJson<Record<string, unknown>>(
        child.getAttribute(ATTRS_KEY),
      );
      if (attrs && Object.keys(attrs).length > 0) {
        node.attrs = attrs;
      }
      Object.assign(
        node,
        parseJson<Record<string, unknown>>(child.getAttribute(META_KEY)),
      );
      const content = xmlChildrenToContent(child);
      if (content.length > 0) {
        node.content = content;
      }
      return [node];
    }

    return [];
  });
}

export function proseContentToYDoc(value: unknown, fieldName: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(fieldName);
  const normalized = normalizeProseContent(value);

  appendChildren(
    fragment,
    (Array.isArray(normalized.content) ? normalized.content : []).flatMap(
      (child) => contentNodeToXmlNodes(child),
    ),
  );

  return doc;
}

export function yDocToProseContent(
  doc: Y.Doc,
  fieldName: string,
): ProseContent {
  return {
    type: "doc",
    content: xmlChildrenToContent(doc.getXmlFragment(fieldName)),
  };
}
