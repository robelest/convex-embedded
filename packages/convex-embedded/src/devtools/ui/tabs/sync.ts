import {
  badge,
  button,
  el,
  empty,
  errorMessage,
  field,
  formatBytes,
  formatCell,
  formatTime,
  palette,
  row,
  section,
  statusColor,
  table,
  text,
} from "@/devtools/ui/dom";
import type { DevtoolsTab } from "@/devtools/ui/tab";

export const syncTab: DevtoolsTab = {
  id: "sync",
  name: "Sync",
  countView: "pending",
  count: (source) => source.getSnapshot("pending").length,
  mount: (host, source) => {
    let confirmingClear = false;
    let clearStatus: string | null = null;
    let clearError: string | null = null;

    const root = el("div", {
      style: {
        height: "100%",
        minHeight: "0",
        overflow: "auto",
        padding: "12px",
      },
    });
    host.appendChild(root);

    function renderSync(): HTMLElement {
      const sync = source.getSnapshot("sync");
      const children: HTMLElement[] = [
        field("Status", badge(sync.status, statusColor(sync.status))),
        field(
          "Online",
          badge(
            sync.online ? "online" : "offline",
            sync.online ? palette.ok : palette.error,
          ),
        ),
      ];
      if (sync.detail && Object.keys(sync.detail).length > 0) {
        for (const [key, value] of Object.entries(sync.detail)) {
          children.push(
            field(key, text(formatCell(value), { color: palette.fg })),
          );
        }
      }
      return el("div", {}, children);
    }

    function renderAuth(): HTMLElement {
      const auth = source.getSnapshot("auth");
      return el("div", {}, [
        field("Status", badge(auth.status, statusColor(auth.status))),
        field(
          "Identity",
          text(auth.identityKey ?? "(none)", { color: palette.fg }),
        ),
      ]);
    }

    function renderPending(): HTMLElement {
      const pending = source.getSnapshot("pending");
      if (pending.length === 0) return empty("No pending operations.");
      return table(
        ["ID", "Ref", "Table", "Status", "Created"],
        pending.map((entry) => [
          text(entry.id, { color: palette.fgMuted }),
          text(entry.ref, { color: palette.fg }),
          text(entry.table ?? "-", { color: palette.fgMuted }),
          badge(entry.status, statusColor(entry.status)),
          text(formatTime(entry.createdAt), { color: palette.fgMuted }),
        ]),
      );
    }

    function renderCrdt(): HTMLElement {
      const crdt = source.getSnapshot("crdt");
      if (crdt.length === 0) return empty("No CRDT documents.");
      return table(
        ["Collection", "Doc ID", "Seq", "Size"],
        crdt.map((entry) => [
          text(entry.collection, { color: palette.fg }),
          text(entry.docId, { color: palette.fgMuted }),
          text(String(entry.seq), { color: palette.fgMuted }),
          text(formatBytes(entry.byteLength), { color: palette.fgMuted }),
        ]),
      );
    }

    const clear = async (): Promise<void> => {
      clearStatus = null;
      clearError = null;
      render();
      try {
        await source.clearLocalData();
        clearStatus = "Local data cleared.";
      } catch (error) {
        clearError = errorMessage(error);
      } finally {
        render();
      }
    };

    function renderClear(): HTMLElement {
      const wrap = el("div", {});
      if (clearStatus) {
        wrap.appendChild(
          el("div", {
            text: clearStatus,
            style: {
              color: palette.ok,
              font: `12px ${palette.mono}`,
              marginBottom: "6px",
            },
          }),
        );
      }
      if (clearError) {
        wrap.appendChild(
          el("div", {
            text: clearError,
            style: {
              color: palette.error,
              font: `12px ${palette.mono}`,
              marginBottom: "6px",
            },
          }),
        );
      }
      if (confirmingClear) {
        wrap.appendChild(
          el("div", {}, [
            el("div", {
              text: "This deletes all local data. Are you sure?",
              style: {
                color: palette.warn,
                font: `12px ${palette.sans}`,
                marginBottom: "8px",
              },
            }),
            row([
              button(
                "Confirm clear",
                () => {
                  confirmingClear = false;
                  void clear();
                },
                "danger",
              ),
              button(
                "Cancel",
                () => {
                  confirmingClear = false;
                  render();
                },
                "ghost",
              ),
            ]),
          ]),
        );
      } else {
        wrap.appendChild(
          button(
            "Clear local data",
            () => {
              clearStatus = null;
              clearError = null;
              confirmingClear = true;
              render();
            },
            "danger",
          ),
        );
      }
      return wrap;
    }

    function render(): void {
      root.textContent = "";
      root.appendChild(section("Sync state", renderSync()));
      root.appendChild(section("Auth", renderAuth()));
      root.appendChild(section("Pending queue", renderPending()));
      root.appendChild(section("CRDT documents", renderCrdt()));
      root.appendChild(section("Danger zone", renderClear()));
    }

    render();

    const unsubs = [
      source.subscribe("sync", render),
      source.subscribe("auth", render),
      source.subscribe("pending", render),
      source.subscribe("crdt", render),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
      root.remove();
    };
  },
};
