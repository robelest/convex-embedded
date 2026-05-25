import { el, palette, text } from "@/devtools/ui/dom";

const jsonColors = {
  key: "#d2a8ff",
  string: "#a5d6ff",
  number: "#79c0ff",
  boolean: "#ff7b72",
  nullish: "#8b949e",
  index: "#6e7681",
} as const;

const MAX_CHILDREN = 100;
const MAX_STRING = 240;

interface Entry {
  label: string;
  value: unknown;
  isIndex: boolean;
}

function isExpandable(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return (
    value !== null &&
    typeof value === "object" &&
    (Array.isArray(value) || Object.getPrototypeOf(value) !== null)
  );
}

function entriesOf(value: Record<string, unknown> | unknown[]): Entry[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({
      label: String(index),
      value: item,
      isIndex: true,
    }));
  }
  return Object.keys(value).map((key) => ({
    label: key,
    value: value[key],
    isIndex: false,
  }));
}

function primitiveSpan(value: unknown): HTMLElement {
  if (value === null) return text("null", { color: jsonColors.nullish });
  if (value === undefined)
    return text("undefined", { color: jsonColors.nullish });
  if (typeof value === "string") {
    const truncated =
      value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    const node = text(JSON.stringify(truncated), { color: jsonColors.string });
    if (value.length > MAX_STRING) node.title = value;
    return node;
  }
  if (typeof value === "number") {
    return text(String(value), { color: jsonColors.number });
  }
  if (typeof value === "bigint") {
    return text(`${value.toString()}n`, { color: jsonColors.number });
  }
  if (typeof value === "boolean") {
    return text(String(value), { color: jsonColors.boolean });
  }
  if (typeof value === "symbol") {
    return text(value.toString(), { color: jsonColors.nullish });
  }
  if (typeof value === "function") {
    return text("ƒ()", { color: jsonColors.nullish });
  }
  try {
    return text(JSON.stringify(value) ?? "[unserializable]", {
      color: palette.fg,
    });
  } catch {
    return text("[unserializable]", { color: palette.fg });
  }
}

function summaryText(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  return `{${Object.keys(value).length}}`;
}

function labelSpan(entry: Entry): HTMLElement {
  return text(`${entry.label}: `, {
    color: entry.isIndex ? jsonColors.index : jsonColors.key,
  });
}

function rowContainer(depth: number): HTMLElement {
  return el("div", {
    style: {
      paddingLeft: `${depth * 14}px`,
      whiteSpace: "nowrap",
    },
  });
}

function renderEntry(
  label: HTMLElement | null,
  value: unknown,
  depth: number,
  expandDepth: number,
): HTMLElement {
  if (!isExpandable(value)) {
    const node = rowContainer(depth);
    if (label) node.appendChild(label);
    node.appendChild(primitiveSpan(value));
    return node;
  }

  const items = entriesOf(value);
  const wrapper = el("div");
  let expanded = depth < expandDepth;

  const triangle = el("span", {
    text: expanded ? "▾" : "▸",
    style: {
      display: "inline-block",
      width: "12px",
      color: palette.fgDim,
      cursor: "pointer",
    },
  });
  const header = rowContainer(depth);
  header.style.cursor = "pointer";
  header.appendChild(triangle);
  if (label) header.appendChild(label);
  header.appendChild(text(summaryText(value), { color: jsonColors.nullish }));

  const childrenBox = el("div", {
    style: { display: expanded ? "block" : "none" },
  });
  const cap = Math.min(items.length, MAX_CHILDREN);
  for (let index = 0; index < cap; index += 1) {
    const entry = items[index];
    if (!entry) continue;
    childrenBox.appendChild(
      renderEntry(labelSpan(entry), entry.value, depth + 1, expandDepth),
    );
  }
  if (items.length > cap) {
    const more = rowContainer(depth + 1);
    more.appendChild(
      text(`… ${items.length - cap} more`, { color: palette.fgDim }),
    );
    childrenBox.appendChild(more);
  }

  header.addEventListener("click", () => {
    expanded = !expanded;
    triangle.textContent = expanded ? "▾" : "▸";
    childrenBox.style.display = expanded ? "block" : "none";
  });

  wrapper.appendChild(header);
  wrapper.appendChild(childrenBox);
  return wrapper;
}

export interface JsonTreeOptions {
  expandDepth?: number;
}

export function jsonTree(
  value: unknown,
  options: JsonTreeOptions = {},
): HTMLElement {
  return el(
    "div",
    {
      style: {
        font: `12px ${palette.mono}`,
        color: palette.fg,
        lineHeight: "1.55",
        overflow: "auto",
      },
    },
    renderEntry(null, value, 0, options.expandDepth ?? 1),
  );
}

export function rawJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, val) => (typeof val === "bigint" ? `${val.toString()}n` : val),
      2,
    );
  } catch {
    return String(value);
  }
}

export function valueViewer(value: unknown): HTMLElement {
  const wrapper = el("div");
  const content = el("div", { style: { marginTop: "6px" } });
  let mode: "tree" | "raw" = "tree";

  const toggleButton = (label: string, target: "tree" | "raw") => {
    const node = el("button", {
      text: label,
      onClick: () => {
        if (mode === target) return;
        mode = target;
        sync();
      },
      style: {
        font: `10px ${palette.sans}`,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "2px 8px",
        border: `1px solid ${palette.border}`,
        background: "transparent",
        color: palette.fgMuted,
        cursor: "pointer",
      },
    });
    return node;
  };

  const treeButton = toggleButton("Tree", "tree");
  const rawButton = toggleButton("Raw", "raw");
  treeButton.style.borderTopLeftRadius = "5px";
  treeButton.style.borderBottomLeftRadius = "5px";
  rawButton.style.borderTopRightRadius = "5px";
  rawButton.style.borderBottomRightRadius = "5px";
  rawButton.style.borderLeft = "none";

  const toggle = el("div", { style: { display: "inline-flex" } }, [
    treeButton,
    rawButton,
  ]);

  const rawBlock = (): HTMLElement =>
    el("pre", {
      text: rawJson(value),
      style: {
        font: `12px ${palette.mono}`,
        color: palette.fg,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: "5px",
        padding: "10px",
        margin: "0",
        overflow: "auto",
        maxHeight: "320px",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      },
    });

  function sync(): void {
    const active = mode === "tree" ? treeButton : rawButton;
    const inactive = mode === "tree" ? rawButton : treeButton;
    active.style.background = palette.bgRaised;
    active.style.color = palette.fg;
    inactive.style.background = "transparent";
    inactive.style.color = palette.fgMuted;
    content.textContent = "";
    content.appendChild(mode === "tree" ? jsonTree(value) : rawBlock());
  }

  sync();
  wrapper.appendChild(toggle);
  wrapper.appendChild(content);
  return wrapper;
}
