import type { RunFunctionInput } from "@/devtools/core/types";
import {
  button,
  el,
  errorMessage,
  input,
  palette,
  select,
  textarea,
} from "@/devtools/ui/dom";
import { valueViewer } from "@/devtools/ui/jsonTree";
import type { DevtoolsTab } from "@/devtools/ui/tab";

export const functionsTab: DevtoolsTab = {
  id: "functions",
  name: "Functions",
  mount: (host, source) => {
    let kind: RunFunctionInput["kind"] = "query";
    let running = false;

    const root = el("div", {
      style: {
        height: "100%",
        overflow: "auto",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
    });

    const kindSelect = select(
      [
        { value: "query", label: "query" },
        { value: "mutation", label: "mutation" },
        { value: "action", label: "action" },
      ],
      kind,
      (value) => {
        kind = value as RunFunctionInput["kind"];
      },
    );
    const pathInput = input({
      placeholder: "module:function  (e.g. issues:list)",
    });
    pathInput.style.flex = "1";
    const argsArea = textarea({ value: "{}", rows: 6 });

    const status = el("div", {
      style: { font: `11px ${palette.mono}`, minHeight: "14px" },
    });
    const output = el("div", { style: { marginTop: "4px" } });

    const setStatus = (message: string, color: string): void => {
      status.textContent = message;
      status.style.color = color;
    };

    const runButton = button("Run", () => void run());

    async function run(): Promise<void> {
      if (running) return;
      const path = pathInput.value.trim();
      if (path.length === 0) {
        setStatus("Enter a function path.", palette.error);
        return;
      }
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(argsArea.value.trim() || "{}");
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          setStatus("Arguments must be a JSON object.", palette.error);
          return;
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        setStatus(`Invalid JSON: ${errorMessage(error)}`, palette.error);
        return;
      }

      running = true;
      runButton.textContent = "Running…";
      setStatus(`Running ${kind} ${path}…`, palette.fgMuted);
      output.textContent = "";
      const startedAt = performance.now();
      try {
        const result = await source.runFunction({ kind, path, args });
        const ms = performance.now() - startedAt;
        setStatus(`ok · ${ms.toFixed(1)}ms`, palette.ok);
        output.appendChild(
          el("div", {
            text: "Result",
            style: {
              font: `11px ${palette.sans}`,
              color: palette.fgMuted,
              margin: "8px 0 4px",
            },
          }),
        );
        output.appendChild(valueViewer(result));
      } catch (error) {
        setStatus(`error: ${errorMessage(error)}`, palette.error);
      } finally {
        running = false;
        runButton.textContent = "Run";
      }
    }

    root.appendChild(
      el(
        "div",
        { style: { display: "flex", gap: "8px", alignItems: "center" } },
        [kindSelect, pathInput, runButton],
      ),
    );
    root.appendChild(
      el("div", {
        text: "Arguments (JSON)",
        style: { font: `11px ${palette.sans}`, color: palette.fgMuted },
      }),
    );
    root.appendChild(argsArea);
    root.appendChild(status);
    root.appendChild(output);
    host.appendChild(root);

    return () => {
      root.remove();
    };
  },
};
