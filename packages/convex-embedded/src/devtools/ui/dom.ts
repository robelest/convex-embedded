export const palette = {
  bg: "#0d1117",
  bgAlt: "#161b22",
  bgRaised: "#1c2128",
  fg: "#e6edf3",
  fgMuted: "#8b949e",
  fgDim: "#6e7681",
  border: "#30363d",
  accent: "#58a6ff",
  ok: "#3fb950",
  error: "#f85149",
  warn: "#d29922",
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
} as const;

export type Child = string | Node | null | undefined;
export type Children = Child | Child[];

export interface ElProps {
  text?: string;
  className?: string;
  style?: Partial<CSSStyleDeclaration>;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  rows?: number;
  onClick?: (event: Event) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
}

function appendChild(parent: HTMLElement, child: Child): void {
  if (child === null || child === undefined) return;
  if (typeof child === "string") {
    parent.appendChild(document.createTextNode(child));
    return;
  }
  parent.appendChild(child);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  children?: Children,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.text !== undefined) node.textContent = props.text;
    if (props.className !== undefined) node.className = props.className;
    if (props.title !== undefined) node.title = props.title;
    if (props.style) Object.assign(node.style, props.style);
    if (props.onClick) node.addEventListener("click", props.onClick);
    if (props.onInput) node.addEventListener("input", props.onInput);
    if (props.onChange) node.addEventListener("change", props.onChange);
    if (node instanceof HTMLInputElement) {
      if (props.type !== undefined) node.type = props.type;
      if (props.value !== undefined) node.value = props.value;
      if (props.placeholder !== undefined) node.placeholder = props.placeholder;
    }
    if (node instanceof HTMLTextAreaElement) {
      if (props.value !== undefined) node.value = props.value;
      if (props.placeholder !== undefined) node.placeholder = props.placeholder;
      if (props.rows !== undefined) node.rows = props.rows;
    }
    if (node instanceof HTMLSelectElement && props.value !== undefined) {
      node.value = props.value;
    }
  }
  if (children !== undefined) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) appendChild(node, child);
  }
  return node;
}

export function text(
  value: string,
  style?: Partial<CSSStyleDeclaration>,
): HTMLSpanElement {
  return el("span", { text: value, style });
}

export function section(title: string, body: Children): HTMLElement {
  const heading = el("div", {
    text: title,
    style: {
      fontSize: "11px",
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      color: palette.fgMuted,
      margin: "0 0 8px 0",
    },
  });
  return el(
    "section",
    {
      style: {
        padding: "12px",
        border: `1px solid ${palette.border}`,
        borderRadius: "6px",
        background: palette.bgAlt,
        marginBottom: "12px",
      },
    },
    [heading, ...(Array.isArray(body) ? body : [body])],
  );
}

export function button(
  label: string,
  onClick: (event: Event) => void,
  variant: "default" | "danger" | "ghost" = "default",
): HTMLButtonElement {
  const colors =
    variant === "danger"
      ? { bg: "transparent", fg: palette.error, border: palette.error }
      : variant === "ghost"
        ? { bg: "transparent", fg: palette.fgMuted, border: palette.border }
        : { bg: palette.bgRaised, fg: palette.fg, border: palette.border };
  return el("button", {
    text: label,
    onClick,
    style: {
      font: `12px ${palette.sans}`,
      padding: "5px 10px",
      borderRadius: "5px",
      border: `1px solid ${colors.border}`,
      background: colors.bg,
      color: colors.fg,
      cursor: "pointer",
    },
  });
}

export function badge(value: string, color: string): HTMLSpanElement {
  return el("span", {
    text: value,
    style: {
      display: "inline-block",
      font: `10px ${palette.mono}`,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      padding: "2px 6px",
      borderRadius: "4px",
      color,
      border: `1px solid ${color}`,
      background: "transparent",
      whiteSpace: "nowrap",
    },
  });
}

export function field(label: string, valueNode: Children): HTMLElement {
  return el(
    "div",
    {
      style: {
        display: "flex",
        gap: "8px",
        alignItems: "baseline",
        padding: "3px 0",
        font: `12px ${palette.sans}`,
      },
    },
    [
      el("span", {
        text: label,
        style: { color: palette.fgMuted, minWidth: "110px", flexShrink: "0" },
      }),
      el(
        "span",
        {
          style: {
            color: palette.fg,
            fontFamily: palette.mono,
            wordBreak: "break-word",
          },
        },
        valueNode,
      ),
    ],
  );
}

export function empty(message: string): HTMLElement {
  return el("div", {
    text: message,
    style: {
      color: palette.fgDim,
      font: `12px ${palette.sans}`,
      fontStyle: "italic",
      padding: "12px 4px",
    },
  });
}

export function table(headers: string[], rows: Children[][]): HTMLElement {
  const headerRow = el(
    "tr",
    {},
    headers.map((header) =>
      el("th", {
        text: header,
        style: {
          textAlign: "left",
          padding: "6px 8px",
          color: palette.fgMuted,
          fontWeight: "600",
          fontSize: "11px",
          borderBottom: `1px solid ${palette.border}`,
          position: "sticky",
          top: "0",
          background: palette.bgAlt,
          whiteSpace: "nowrap",
        },
      }),
    ),
  );
  const bodyRows = rows.map((cells) =>
    el(
      "tr",
      {},
      cells.map((cell) =>
        el(
          "td",
          {
            style: {
              padding: "5px 8px",
              borderBottom: `1px solid ${palette.border}`,
              color: palette.fg,
              verticalAlign: "top",
            },
          },
          cell,
        ),
      ),
    ),
  );
  return el(
    "table",
    {
      style: {
        width: "100%",
        borderCollapse: "collapse",
        font: `12px ${palette.mono}`,
      },
    },
    [el("thead", {}, headerRow), el("tbody", {}, bodyRows)],
  );
}

export function row(children: Child[], gap = "8px"): HTMLElement {
  return el(
    "div",
    {
      style: { display: "flex", gap, alignItems: "center", flexWrap: "wrap" },
    },
    children,
  );
}

export function input(props: ElProps): HTMLInputElement {
  const baseStyle: Partial<CSSStyleDeclaration> = {
    font: `12px ${palette.mono}`,
    padding: "5px 8px",
    borderRadius: "5px",
    border: `1px solid ${palette.border}`,
    background: palette.bg,
    color: palette.fg,
  };
  return el("input", {
    ...props,
    style: Object.assign(baseStyle, props.style),
  });
}

export function textarea(props: ElProps): HTMLTextAreaElement {
  const baseStyle: Partial<CSSStyleDeclaration> = {
    font: `12px ${palette.mono}`,
    padding: "8px",
    borderRadius: "5px",
    border: `1px solid ${palette.border}`,
    background: palette.bg,
    color: palette.fg,
    resize: "vertical",
    width: "100%",
    boxSizing: "border-box",
  };
  return el("textarea", {
    ...props,
    style: Object.assign(baseStyle, props.style),
  });
}

export function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el("select", {
    onChange: (event) => {
      const target = event.target;
      if (target instanceof HTMLSelectElement) onChange(target.value);
    },
    style: {
      font: `12px ${palette.mono}`,
      padding: "5px 8px",
      borderRadius: "5px",
      border: `1px solid ${palette.border}`,
      background: palette.bg,
      color: palette.fg,
    },
  });
  for (const option of options) {
    node.appendChild(el("option", { text: option.label, value: option.value }));
  }
  node.value = value;
  return node;
}

export function statusColor(status: string): string {
  if (status === "ok" || status === "online" || status === "synced")
    return palette.ok;
  if (status === "error" || status === "failed" || status === "offline")
    return palette.error;
  if (status === "pending" || status === "syncing") return palette.warn;
  return palette.fgMuted;
}

export function kindColor(kind: string): string {
  if (kind === "query") return palette.accent;
  if (kind === "mutation") return palette.warn;
  if (kind === "action") return palette.ok;
  return palette.fgMuted;
}

export function severityColor(severity: string): string {
  const lower = severity.toLowerCase();
  if (lower.includes("error")) return palette.error;
  if (lower.includes("warn")) return palette.warn;
  if (lower.includes("debug")) return palette.fgDim;
  return palette.fgMuted;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleTimeString();
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCell(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return formatCell(error);
}
