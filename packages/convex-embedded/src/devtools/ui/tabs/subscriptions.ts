import type { SubscriptionEntry } from "@/devtools/core/types";
import { kindGlyph, pathLabel } from "@/devtools/ui/components";
import { el, empty, field, formatTime, palette, text } from "@/devtools/ui/dom";
import { valueViewer } from "@/devtools/ui/jsonTree";
import type { DevtoolsTab } from "@/devtools/ui/tab";

function detailPane(entry: SubscriptionEntry): HTMLElement {
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
      kindGlyph("query"),
      el("span", {
        text: entry.path,
        style: { font: `13px ${palette.mono}`, color: palette.fg },
      }),
    ],
  );

  const meta = el("div", { style: { marginBottom: "10px" } }, [
    field("Updates", text(String(entry.updateCount), { color: palette.fg })),
    field(
      "Last update",
      text(formatTime(entry.lastUpdateMs), { color: palette.fg }),
    ),
  ]);

  const sections: HTMLElement[] = [head, meta];

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
      valueViewer(entry.args),
    ]),
  );

  sections.push(
    el("div", {}, [
      el("div", {
        text: "Value",
        style: {
          font: `11px ${palette.sans}`,
          color: palette.fgMuted,
          marginBottom: "4px",
        },
      }),
      entry.value === undefined
        ? empty("No value yet.")
        : valueViewer(entry.value),
    ]),
  );

  return el("div", { style: { padding: "12px" } }, sections);
}

export const subscriptionsTab: DevtoolsTab = {
  id: "subscriptions",
  name: "Subscriptions",
  countView: "subscriptions",
  count: (source) => source.getSnapshot("subscriptions").length,
  mount: (host, source) => {
    let entries: SubscriptionEntry[] = source.getSnapshot("subscriptions");
    let selectedId: string | null = null;

    const root = el("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "0",
      },
    });

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

    root.appendChild(body);
    host.appendChild(root);

    function renderDetail(): void {
      detail.textContent = "";
      const entry = entries.find((item) => item.id === selectedId);
      if (!entry) {
        detail.appendChild(empty("Select a subscription to inspect."));
        return;
      }
      detail.appendChild(detailPane(entry));
    }

    function buildRow(entry: SubscriptionEntry): HTMLElement {
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
          text(`↻${entry.updateCount}`, { color: palette.fgMuted }),
          text(formatTime(entry.lastUpdateMs), { color: palette.fgDim }),
        ],
      );

      const rowEl = el(
        "div",
        {
          onClick: () => {
            selectedId = entry.id;
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
            background:
              entry.id === selectedId ? palette.bgRaised : "transparent",
          },
        },
        [kindGlyph("query"), pathLabel(entry.path, entry.args), meta],
      );
      rowEl.addEventListener("mouseenter", () => {
        if (entry.id !== selectedId) rowEl.style.background = palette.bgAlt;
      });
      rowEl.addEventListener("mouseleave", () => {
        if (entry.id !== selectedId) rowEl.style.background = "transparent";
      });
      return rowEl;
    }

    function renderFeed(): void {
      const scrollTop = feed.scrollTop;
      feed.textContent = "";
      if (entries.length === 0) {
        feed.appendChild(empty("No active subscriptions."));
        return;
      }
      for (const entry of entries) feed.appendChild(buildRow(entry));
      feed.scrollTop = scrollTop;
    }

    renderFeed();
    renderDetail();

    const unsubscribe = source.subscribe("subscriptions", () => {
      entries = source.getSnapshot("subscriptions");
      renderFeed();
      renderDetail();
    });

    return () => {
      unsubscribe();
      root.remove();
    };
  },
};
