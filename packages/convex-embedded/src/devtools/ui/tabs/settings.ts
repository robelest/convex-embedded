import { button, el, palette, row, section } from "@/devtools/ui/dom";
import type { DevtoolsTab } from "@/devtools/ui/tab";

function note(message: string): HTMLElement {
  return el("div", {
    text: message,
    style: {
      color: palette.fgMuted,
      font: `12px ${palette.sans}`,
      lineHeight: "1.6",
    },
  });
}

export const settingsTab: DevtoolsTab = {
  id: "settings",
  name: "Settings",
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

    const clear = async (): Promise<void> => {
      clearStatus = null;
      clearError = null;
      render();
      try {
        await source.clearLocalData();
        clearStatus = "Local data cleared.";
      } catch (error) {
        clearError =
          error instanceof Error ? error.message : "Failed to clear data.";
      } finally {
        render();
      }
    };

    function renderAbout(): HTMLElement {
      return el("div", {}, [
        el("div", {
          text: "Convex Embedded devtools",
          style: {
            font: `13px ${palette.mono}`,
            color: palette.fg,
            fontWeight: "600",
            marginBottom: "6px",
          },
        }),
        note(
          "Position and theme are controlled by the TanStack toolbar that hosts these devtools.",
        ),
      ]);
    }

    function renderBuffer(): HTMLElement {
      return el("div", {}, [
        note(
          "Activity is captured in an in-memory ring buffer with a capacity of roughly 2000 entries. Older entries are evicted as new ones arrive.",
        ),
        el(
          "div",
          { style: { marginTop: "8px" } },
          button(
            "Clear activity",
            () => {
              source.clearActivity();
            },
            "ghost",
          ),
        ),
      ]);
    }

    function renderDanger(): HTMLElement {
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
          el("div", {}, [
            note("Permanently remove all locally persisted data."),
            el(
              "div",
              { style: { marginTop: "8px" } },
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
            ),
          ]),
        );
      }
      return wrap;
    }

    function render(): void {
      root.textContent = "";
      root.appendChild(section("About", renderAbout()));
      root.appendChild(section("Activity buffer", renderBuffer()));
      root.appendChild(section("Danger zone", renderDanger()));
    }

    render();

    return () => {
      root.remove();
    };
  },
};
