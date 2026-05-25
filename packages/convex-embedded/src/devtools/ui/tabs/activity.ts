import type { OperationEntry } from "@/devtools/core/types";
import {
  argsPreview,
  commandFilter,
  downloadJson,
  feedToolbar,
  filterPills,
  kindGlyph,
  pathLabel,
  showContextMenu,
  type ContextMenuItem,
} from "@/devtools/ui/components";
import {
  badge,
  el,
  empty,
  field,
  formatMs,
  formatTime,
  kindColor,
  palette,
  statusColor,
  text,
} from "@/devtools/ui/dom";
import { rawJson, valueViewer } from "@/devtools/ui/jsonTree";
import type { DevtoolsTab } from "@/devtools/ui/tab";

const MAX_ROWS = 500;
const THROUGHPUT_WINDOW_MS = 5000;

interface ActivityState {
  kind: string;
  search: string;
  minMs: number;
}

function matches(op: OperationEntry, state: ActivityState): boolean {
  if (state.kind !== "all" && op.kind !== state.kind) return false;
  if (op.durationMs < state.minMs) return false;
  if (state.search.length > 0) {
    const haystack = `${op.path} ${argsPreview(op.args)}`.toLowerCase();
    if (!haystack.includes(state.search.toLowerCase())) return false;
  }
  return true;
}

function throughput(operations: OperationEntry[]): number {
  if (operations.length === 0) return 0;
  const now = operations[operations.length - 1]?.startMs ?? Date.now();
  const cutoff = now - THROUGHPUT_WINDOW_MS;
  const recent = operations.filter((op) => op.startMs >= cutoff).length;
  return (recent / THROUGHPUT_WINDOW_MS) * 1000;
}

function copy(value: string): void {
  void navigator.clipboard?.writeText(value).catch(() => undefined);
}

function detailPane(op: OperationEntry): HTMLElement {
  const head = el(
    "div",
    {
      style: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
        marginBottom: "10px",
        flexWrap: "wrap",
      },
    },
    [
      badge(op.kind, kindColor(op.kind)),
      el("span", {
        text: op.path,
        style: { font: `13px ${palette.mono}`, color: palette.fg },
      }),
      badge(op.status, statusColor(op.status)),
    ],
  );

  const meta = el("div", { style: { marginBottom: "10px" } }, [
    field("Duration", text(formatMs(op.durationMs), { color: palette.fg })),
    field("Started", text(formatTime(op.startMs), { color: palette.fg })),
    op.resultSize !== undefined
      ? field(
          "Result size",
          text(`${op.resultSize} chars`, { color: palette.fgMuted }),
        )
      : null,
  ]);

  const sections: Array<HTMLElement | null> = [head, meta];

  if (op.error) {
    sections.push(
      el("div", { style: { marginBottom: "10px" } }, [
        el("div", {
          text: "Error",
          style: {
            font: `11px ${palette.sans}`,
            color: palette.fgMuted,
            marginBottom: "4px",
          },
        }),
        el("pre", {
          text: op.error,
          style: {
            font: `12px ${palette.mono}`,
            color: palette.error,
            background: palette.bg,
            border: `1px solid ${palette.border}`,
            borderRadius: "5px",
            padding: "8px",
            margin: "0",
            whiteSpace: "pre-wrap",
          },
        }),
      ]),
    );
  }

  if (op.args !== undefined) {
    sections.push(
      el("div", { style: { marginBottom: "10px" } }, [
        el("div", {
          text: "Arguments",
          style: {
            font: `11px ${palette.sans}`,
            color: palette.fgMuted,
            marginBottom: "4px",
          },
        }),
        valueViewer(op.args),
      ]),
    );
  }

  if (op.result !== undefined) {
    sections.push(
      el("div", { style: { marginBottom: "10px" } }, [
        el("div", {
          text: "Result",
          style: {
            font: `11px ${palette.sans}`,
            color: palette.fgMuted,
            marginBottom: "4px",
          },
        }),
        valueViewer(op.result),
      ]),
    );
  }

  if (op.logs.length > 0) {
    const lines = op.logs.map((line) =>
      el(
        "div",
        {
          style: {
            display: "flex",
            gap: "8px",
            font: `11px ${palette.mono}`,
            padding: "2px 0",
          },
        },
        [
          text(formatTime(line.timeMs), { color: palette.fgDim }),
          text(line.severity, { color: palette.fgMuted }),
          text(line.body, { color: palette.fg }),
        ],
      ),
    );
    sections.push(
      el("div", {}, [
        el("div", {
          text: `Logs (${op.logs.length})`,
          style: {
            font: `11px ${palette.sans}`,
            color: palette.fgMuted,
            marginBottom: "4px",
          },
        }),
        ...lines,
      ]),
    );
  }

  return el(
    "div",
    { style: { padding: "12px" } },
    sections.filter((node): node is HTMLElement => node !== null),
  );
}

export const activityTab: DevtoolsTab = {
  id: "activity",
  name: "Activity",
  countView: "operations",
  count: (source) => source.getSnapshot("operations").length,
  mount: (host, source) => {
    const state: ActivityState = { kind: "all", search: "", minMs: 0 };
    let paused = false;
    let frozen: OperationEntry[] = source.getSnapshot("operations");
    let selectedId: string | null = null;
    let newWhilePaused = 0;

    const root = el("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "0",
      },
    });

    const pills = filterPills(
      [
        { id: "all", label: "ALL" },
        { id: "query", label: "Q" },
        { id: "mutation", label: "M" },
        { id: "action", label: "A" },
      ],
      "all",
      (id) => {
        state.kind = id;
        renderFeed();
      },
    );

    const toolbar = feedToolbar({
      onPauseToggle: () => {
        paused = !paused;
        toolbar.setPaused(paused);
        if (!paused) {
          newWhilePaused = 0;
          frozen = source.getSnapshot("operations");
          renderFeed();
        }
      },
      onClear: () => {
        source.clearActivity();
        selectedId = null;
        frozen = [];
        renderFeed();
        renderDetail();
      },
      onExport: () => downloadJson("convex-embedded-activity.json", frozen),
    });

    const topRow = el(
      "div",
      {
        style: {
          display: "flex",
          gap: "8px",
          alignItems: "center",
          padding: "8px",
        },
      },
      [pills.element, toolbar.element],
    );

    const search = commandFilter("Filter… (⌘K)", (value) => {
      state.search = value;
      renderFeed();
    });
    const durationInput = el("input", {
      type: "number",
      placeholder: ">ms",
      onInput: (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement) {
          state.minMs = Number(target.value) || 0;
          renderFeed();
        }
      },
      style: {
        font: `12px ${palette.mono}`,
        padding: "4px 8px",
        borderRadius: "5px",
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.fg,
        width: "72px",
      },
    });

    const filterRow = el(
      "div",
      {
        style: {
          display: "flex",
          gap: "8px",
          alignItems: "center",
          padding: "0 8px 8px",
        },
      },
      [search.element, durationInput],
    );

    const header = el(
      "div",
      {
        style: {
          flexShrink: "0",
          borderBottom: `1px solid ${palette.border}`,
          background: palette.bgAlt,
        },
      },
      [topRow, filterRow],
    );

    const feed = el("div", {
      style: { flex: "1", minWidth: "0", overflow: "auto" },
    });
    const detail = el("div", {
      style: {
        width: "44%",
        maxWidth: "560px",
        flexShrink: "0",
        overflow: "auto",
        borderLeft: `1px solid ${palette.border}`,
        background: palette.bg,
      },
    });
    const body = el(
      "div",
      { style: { flex: "1", minHeight: "0", display: "flex" } },
      [feed, detail],
    );

    root.appendChild(header);
    root.appendChild(body);
    host.appendChild(root);

    function renderDetail(): void {
      detail.textContent = "";
      const op = frozen.find((entry) => entry.id === selectedId);
      if (!op) {
        detail.appendChild(empty("Select an operation to inspect."));
        return;
      }
      detail.appendChild(detailPane(op));
    }

    function rowContextMenu(op: OperationEntry, event: MouseEvent): void {
      event.preventDefault();
      const items: ContextMenuItem[] = [
        { label: "Copy Function Path", onClick: () => copy(op.path) },
        {
          label: "Copy as convex run",
          onClick: () =>
            copy(`npx convex run ${op.path} '${rawJson(op.args ?? {})}'`),
        },
        { label: "Copy Arguments", onClick: () => copy(rawJson(op.args)) },
        { label: "Copy Result", onClick: () => copy(rawJson(op.result)) },
        { label: "Copy as JSON", onClick: () => copy(rawJson(op)) },
        "separator",
        {
          label: "Filter by Function",
          onClick: () => {
            state.search = op.path;
            if (search.element instanceof HTMLInputElement) {
              search.element.value = op.path;
            }
            renderFeed();
          },
        },
        {
          label: `Filter by Type: ${op.kind}`,
          onClick: () => {
            state.kind = op.kind;
            pills.setActive(op.kind);
            renderFeed();
          },
        },
      ];
      showContextMenu(items, event.clientX, event.clientY);
    }

    function makeRow(op: OperationEntry): HTMLElement {
      const meta = el(
        "div",
        {
          style: {
            display: "flex",
            gap: "10px",
            alignItems: "center",
            marginLeft: "auto",
            flexShrink: "0",
            font: `11px ${palette.mono}`,
            color: palette.fgDim,
          },
        },
        [
          op.status === "error"
            ? text("error", { color: palette.error })
            : text(formatMs(op.durationMs), { color: palette.fgMuted }),
          text(formatTime(op.startMs), { color: palette.fgDim }),
        ],
      );

      const rowEl = el(
        "div",
        {
          onClick: () => {
            selectedId = op.id;
            renderFeed();
            renderDetail();
          },
          style: {
            display: "flex",
            gap: "8px",
            alignItems: "center",
            padding: "5px 10px",
            borderBottom: `1px solid ${palette.bgAlt}`,
            cursor: "pointer",
            background: op.id === selectedId ? palette.bgRaised : "transparent",
          },
        },
        [kindGlyph(op.kind), pathLabel(op.path, op.args), meta],
      );
      rowEl.addEventListener("contextmenu", (event) =>
        rowContextMenu(op, event),
      );
      rowEl.addEventListener("mouseenter", () => {
        if (op.id !== selectedId) rowEl.style.background = palette.bgAlt;
      });
      rowEl.addEventListener("mouseleave", () => {
        if (op.id !== selectedId) rowEl.style.background = "transparent";
      });
      return rowEl;
    }

    function renderFeed(): void {
      const counts: Record<string, number> = {
        all: frozen.length,
        query: 0,
        mutation: 0,
        action: 0,
      };
      for (const op of frozen) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
      pills.setCounts(counts);
      toolbar.setThroughput(throughput(frozen));
      toolbar.setInfo(paused ? `paused · ${newWhilePaused} new` : "");

      const scrollTop = feed.scrollTop;
      feed.textContent = "";
      const visible = frozen
        .filter((op) => matches(op, state))
        .slice(-MAX_ROWS)
        .reverse();
      if (visible.length === 0) {
        feed.appendChild(empty("No operations captured yet."));
        return;
      }
      for (const op of visible) feed.appendChild(makeRow(op));
      feed.scrollTop = scrollTop;
    }

    renderFeed();
    renderDetail();

    const unsubscribe = source.subscribe("operations", () => {
      const latest = source.getSnapshot("operations");
      if (paused) {
        newWhilePaused = Math.max(0, latest.length - frozen.length);
        toolbar.setInfo(`paused · ${newWhilePaused} new`);
        return;
      }
      frozen = latest;
      renderFeed();
      renderDetail();
    });

    return () => {
      unsubscribe();
      search.dispose();
      root.remove();
    };
  },
};
