import type { DevtoolsLogLine } from "@/devtools/core/types";
import { commandFilter, filterPills } from "@/devtools/ui/components";
import {
  el,
  empty,
  formatTime,
  palette,
  severityColor,
  text,
} from "@/devtools/ui/dom";
import type { DevtoolsTab } from "@/devtools/ui/tab";

const MAX_ROWS = 500;

interface LogsState {
  severity: string;
  search: string;
}

function matches(line: DevtoolsLogLine, state: LogsState): boolean {
  if (state.severity !== "all") {
    if (!line.severity.toLowerCase().includes(state.severity)) return false;
  }
  if (state.search.length > 0) {
    if (!line.body.toLowerCase().includes(state.search.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export const logsTab: DevtoolsTab = {
  id: "logs",
  name: "Logs",
  countView: "logs",
  count: (source) => source.getSnapshot("logs").length,
  mount: (host, source) => {
    const state: LogsState = { severity: "all", search: "" };
    let lines: DevtoolsLogLine[] = source.getSnapshot("logs");

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
        { id: "info", label: "INFO" },
        { id: "warn", label: "WARN" },
        { id: "error", label: "ERROR" },
        { id: "debug", label: "DEBUG" },
      ],
      "all",
      (id) => {
        state.severity = id;
        render();
      },
    );

    const search = commandFilter("Filter logs… (⌘K)", (value) => {
      state.search = value;
      render();
    });

    const header = el(
      "div",
      {
        style: {
          flexShrink: "0",
          display: "flex",
          gap: "8px",
          alignItems: "center",
          padding: "8px",
          borderBottom: `1px solid ${palette.border}`,
          background: palette.bgAlt,
        },
      },
      [pills.element, search.element],
    );

    const feed = el("div", {
      style: { flex: "1", minHeight: "0", overflow: "auto" },
    });

    root.appendChild(header);
    root.appendChild(feed);
    host.appendChild(root);

    function makeRow(line: DevtoolsLogLine): HTMLElement {
      const children: HTMLElement[] = [
        text(formatTime(line.timeMs), { color: palette.fgDim }),
        text(line.severity, { color: severityColor(line.severity) }),
      ];
      if (line.category) {
        children.push(text(line.category, { color: palette.fgDim }));
      }
      children.push(
        el("span", {
          text: line.body,
          style: { color: palette.fg, wordBreak: "break-word" },
        }),
      );
      return el(
        "div",
        {
          style: {
            display: "flex",
            gap: "10px",
            alignItems: "baseline",
            padding: "3px 10px",
            borderBottom: `1px solid ${palette.bgAlt}`,
            font: `11px ${palette.mono}`,
          },
        },
        children,
      );
    }

    function render(): void {
      const counts: Record<string, number> = {
        all: lines.length,
        info: 0,
        warn: 0,
        error: 0,
        debug: 0,
      };
      for (const line of lines) {
        const lower = line.severity.toLowerCase();
        if (lower.includes("error")) counts.error = (counts.error ?? 0) + 1;
        else if (lower.includes("warn")) counts.warn = (counts.warn ?? 0) + 1;
        else if (lower.includes("debug"))
          counts.debug = (counts.debug ?? 0) + 1;
        else counts.info = (counts.info ?? 0) + 1;
      }
      pills.setCounts(counts);

      const scrollTop = feed.scrollTop;
      feed.textContent = "";
      const visible = lines
        .filter((line) => matches(line, state))
        .slice(-MAX_ROWS)
        .reverse();
      if (visible.length === 0) {
        feed.appendChild(empty("No logs captured yet."));
        return;
      }
      for (const line of visible) feed.appendChild(makeRow(line));
      feed.scrollTop = scrollTop;
    }

    render();

    const unsubscribe = source.subscribe("logs", () => {
      lines = source.getSnapshot("logs");
      render();
    });

    return () => {
      unsubscribe();
      search.dispose();
      root.remove();
    };
  },
};
