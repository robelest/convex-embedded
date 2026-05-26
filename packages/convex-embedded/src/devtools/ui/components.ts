import { el, kindColor, palette, text } from "@/devtools/ui/dom";

export function kindGlyph(kind: string): HTMLElement {
  const letter =
    kind === "query"
      ? "Q"
      : kind === "mutation"
        ? "M"
        : kind === "action"
          ? "A"
          : "?";
  const color = kindColor(kind);
  return el("span", {
    text: letter,
    title: kind,
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "16px",
      height: "16px",
      borderRadius: "4px",
      font: `10px ${palette.mono}`,
      fontWeight: "700",
      color,
      border: `1px solid ${color}`,
      flexShrink: "0",
    },
  });
}

export function argsPreview(args: unknown): string {
  if (args === undefined || args === null) return "";
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
  if (serialized === "{}" || serialized === "") return "";
  return serialized.length > 64 ? `${serialized.slice(0, 64)}…` : serialized;
}

export function pathLabel(path: string, args: unknown): HTMLElement {
  const wrap = el("span", {
    style: {
      font: `12px ${palette.mono}`,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      display: "inline-block",
      maxWidth: "100%",
    },
  });
  wrap.appendChild(text(path || "(unknown)", { color: palette.fg }));
  const preview = argsPreview(args);
  wrap.appendChild(text("(", { color: palette.fgDim }));
  if (preview) wrap.appendChild(text(preview, { color: palette.fgMuted }));
  wrap.appendChild(text(")", { color: palette.fgDim }));
  return wrap;
}

export interface PillSpec {
  id: string;
  label: string;
}

export interface FilterPills {
  element: HTMLElement;
  setActive(id: string): void;
  setCounts(counts: Record<string, number>): void;
}

export function filterPills(
  specs: PillSpec[],
  initialActive: string,
  onChange: (id: string) => void,
): FilterPills {
  let active = initialActive;
  const countNodes = new Map<string, HTMLElement>();
  const pillNodes = new Map<string, HTMLButtonElement>();

  const element = el("div", {
    style: { display: "flex", gap: "4px", alignItems: "center" },
  });

  const paint = (): void => {
    for (const [id, node] of pillNodes) {
      const on = id === active;
      node.style.background = on ? palette.bgRaised : "transparent";
      node.style.color = on ? palette.fg : palette.fgMuted;
      node.style.borderColor = on ? palette.accent : palette.border;
    }
  };

  for (const spec of specs) {
    const countNode = el("span", {
      text: "",
      style: { color: palette.fgDim, fontWeight: "600" },
    });
    countNodes.set(spec.id, countNode);
    const pill = el(
      "button",
      {
        onClick: () => {
          active = spec.id;
          paint();
          onChange(spec.id);
        },
        style: {
          display: "inline-flex",
          gap: "5px",
          alignItems: "center",
          font: `11px ${palette.mono}`,
          fontWeight: "600",
          padding: "3px 8px",
          borderRadius: "5px",
          border: `1px solid ${palette.border}`,
          background: "transparent",
          color: palette.fgMuted,
          cursor: "pointer",
        },
      },
      [text(spec.label, {}), countNode],
    );
    pillNodes.set(spec.id, pill);
    element.appendChild(pill);
  }
  paint();

  return {
    element,
    setActive: (id) => {
      active = id;
      paint();
    },
    setCounts: (counts) => {
      for (const [id, node] of countNodes) {
        const value = counts[id];
        node.textContent = value === undefined ? "" : String(value);
      }
    },
  };
}

export interface CommandFilter {
  element: HTMLElement;
  getValue(): string;
  dispose(): void;
}

export function commandFilter(
  placeholder: string,
  onInput: (value: string) => void,
): CommandFilter {
  const node = el("input", {
    placeholder,
    onInput: (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement) onInput(target.value);
    },
    style: {
      font: `12px ${palette.mono}`,
      padding: "4px 8px",
      borderRadius: "5px",
      border: `1px solid ${palette.border}`,
      background: palette.bg,
      color: palette.fg,
      flex: "1",
      minWidth: "0",
    },
  });

  const onKeydown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      node.focus();
      node.select();
    }
  };
  document.addEventListener("keydown", onKeydown);

  return {
    element: node,
    getValue: () => node.value,
    dispose: () => document.removeEventListener("keydown", onKeydown),
  };
}

export type ContextMenuItem =
  | { label: string; onClick: () => void }
  | "separator";

export function showContextMenu(
  items: ContextMenuItem[],
  x: number,
  y: number,
): void {
  const existing = document.getElementById("convex-embedded-context-menu");
  if (existing) existing.remove();

  const menu = el("div", {
    style: {
      position: "fixed",
      top: `${y}px`,
      left: `${x}px`,
      zIndex: "2147483647",
      minWidth: "180px",
      padding: "4px",
      borderRadius: "6px",
      border: `1px solid ${palette.border}`,
      background: palette.bgRaised,
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      font: `12px ${palette.sans}`,
    },
  });
  menu.id = "convex-embedded-context-menu";

  const dismiss = (): void => {
    menu.remove();
    document.removeEventListener("click", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismiss();
  };

  for (const item of items) {
    if (item === "separator") {
      menu.appendChild(
        el("div", {
          style: {
            height: "1px",
            background: palette.border,
            margin: "4px 0",
          },
        }),
      );
      continue;
    }
    const entry = el("div", {
      text: item.label,
      onClick: () => {
        dismiss();
        item.onClick();
      },
      style: {
        padding: "6px 10px",
        borderRadius: "4px",
        color: palette.fg,
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
    });
    entry.addEventListener("mouseenter", () => {
      entry.style.background = palette.bgAlt;
    });
    entry.addEventListener("mouseleave", () => {
      entry.style.background = "transparent";
    });
    menu.appendChild(entry);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 8)}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 8)}px`;
  }

  setTimeout(() => {
    document.addEventListener("click", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

export interface FeedToolbar {
  element: HTMLElement;
  setPaused(paused: boolean): void;
  setThroughput(perSec: number): void;
  setInfo(label: string): void;
}

export function toolbarButton(
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  return el("button", {
    text: label,
    title,
    onClick,
    style: {
      font: `12px ${palette.mono}`,
      padding: "3px 8px",
      borderRadius: "5px",
      border: `1px solid ${palette.border}`,
      background: "transparent",
      color: palette.fgMuted,
      cursor: "pointer",
    },
  });
}

export function feedToolbar(opts: {
  onPauseToggle: () => void;
  onClear: () => void;
  onExport: () => void;
}): FeedToolbar {
  const info = el("span", {
    style: { color: palette.fgDim, font: `11px ${palette.mono}` },
  });
  const throughput = el("span", {
    style: { color: palette.fgMuted, font: `11px ${palette.mono}` },
  });

  const iconButton = toolbarButton;

  const pauseButton = iconButton("❚❚", "Pause", opts.onPauseToggle);
  const element = el(
    "div",
    {
      style: {
        display: "flex",
        gap: "6px",
        alignItems: "center",
        marginLeft: "auto",
      },
    },
    [
      info,
      throughput,
      pauseButton,
      iconButton("Clear", "Clear captured activity", opts.onClear),
      iconButton("Export", "Export as JSON", opts.onExport),
    ],
  );

  return {
    element,
    setPaused: (paused) => {
      pauseButton.textContent = paused ? "▶" : "❚❚";
      pauseButton.title = paused ? "Resume" : "Pause";
      pauseButton.style.color = paused ? palette.warn : palette.fgMuted;
      pauseButton.style.borderColor = paused ? palette.warn : palette.border;
    },
    setThroughput: (perSec) => {
      throughput.textContent = perSec > 0 ? `${perSec.toFixed(1)}/s` : "";
    },
    setInfo: (label) => {
      info.textContent = label;
    },
  };
}

export function downloadJson(filename: string, value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    serialized = String(value);
  }
  const blob = new Blob([serialized], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = el("a", {});
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
