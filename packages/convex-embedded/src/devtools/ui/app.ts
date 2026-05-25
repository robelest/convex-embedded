import type { EmbeddedDevtoolsSource } from "@/devtools/core/types";
import { el, palette } from "@/devtools/ui/dom";
import type { DevtoolsTab } from "@/devtools/ui/tab";
import { tabs } from "@/devtools/ui/tabs";

const ACTIVE_TAB_KEY = "convex-embedded-devtools:activeTab";

function readActiveTab(fallback: string): string {
  try {
    return window.localStorage.getItem(ACTIVE_TAB_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeActiveTab(id: string): void {
  try {
    window.localStorage.setItem(ACTIVE_TAB_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function mountDevtoolsApp(
  host: HTMLElement,
  source: EmbeddedDevtoolsSource,
): () => void {
  const first = tabs[0];
  if (!first) return () => {};

  const root = el("div", {
    style: { height: "100%", width: "100%", minHeight: "0" },
  });

  const shell = el("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      height: "100%",
      width: "100%",
      minHeight: "0",
      background: palette.bg,
      color: palette.fg,
      font: `13px ${palette.sans}`,
    },
  });

  const tabBar = el("div", {
    style: {
      display: "flex",
      gap: "2px",
      padding: "0 8px",
      borderBottom: `1px solid ${palette.border}`,
      background: palette.bgAlt,
      flexShrink: "0",
      overflowX: "auto",
    },
  });

  const content = el("div", {
    style: { flex: "1", minHeight: "0", overflow: "hidden", display: "flex" },
  });

  shell.appendChild(tabBar);
  shell.appendChild(content);
  root.appendChild(shell);
  host.appendChild(root);

  let activeId = readActiveTab(first.id);
  if (!tabs.some((tab) => tab.id === activeId)) activeId = first.id;

  let activeCleanup: (() => void) | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  const countBadges = new Map<string, HTMLElement>();
  const countUnsubscribers: Array<() => void> = [];

  const paintTabs = (): void => {
    for (const [id, node] of buttons) {
      const on = id === activeId;
      node.style.color = on ? palette.fg : palette.fgMuted;
      node.style.borderBottomColor = on ? palette.accent : "transparent";
    }
  };

  const select = (tab: DevtoolsTab): void => {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    content.textContent = "";
    activeId = tab.id;
    writeActiveTab(tab.id);
    paintTabs();
    const slot = el("div", {
      style: { flex: "1", minHeight: "0", minWidth: "0", overflow: "auto" },
    });
    content.appendChild(slot);
    activeCleanup = tab.mount(slot, source);
  };

  const refreshCount = (tab: DevtoolsTab): void => {
    const badge = countBadges.get(tab.id);
    if (!badge || !tab.count) return;
    const value = tab.count(source);
    badge.textContent = value === undefined ? "" : String(value);
  };

  for (const tab of tabs) {
    const badge = el("span", {
      style: {
        font: `10px ${palette.mono}`,
        fontWeight: "700",
        color: palette.fgDim,
        background: palette.bgRaised,
        borderRadius: "8px",
        padding: "0 5px",
        minWidth: "8px",
        textAlign: "center",
      },
    });
    countBadges.set(tab.id, badge);

    const button = el(
      "button",
      {
        onClick: () => select(tab),
        style: {
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          font: `12px ${palette.sans}`,
          fontWeight: "500",
          padding: "9px 10px",
          border: "none",
          borderBottom: "2px solid transparent",
          background: "transparent",
          color: palette.fgMuted,
          cursor: "pointer",
        },
      },
      tab.count ? [el("span", { text: tab.name }), badge] : tab.name,
    );
    buttons.set(tab.id, button);
    tabBar.appendChild(button);

    if (tab.count) {
      refreshCount(tab);
      if (tab.countView) {
        countUnsubscribers.push(
          source.subscribe(tab.countView, () => refreshCount(tab)),
        );
      }
    }
  }

  const initial = tabs.find((tab) => tab.id === activeId) ?? first;
  select(initial);

  return () => {
    if (activeCleanup) activeCleanup();
    for (const unsubscribe of countUnsubscribers) unsubscribe();
    root.remove();
  };
}
