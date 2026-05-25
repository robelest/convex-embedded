import type { OperationEntry, PerfBucket } from "@/devtools/core/types";
import { kindGlyph, pathLabel } from "@/devtools/ui/components";
import {
  el,
  empty,
  formatMs,
  formatTime,
  palette,
  section,
  table,
  text,
} from "@/devtools/ui/dom";
import type { DevtoolsTab } from "@/devtools/ui/tab";

function bucketRow(bucket: PerfBucket): Array<HTMLElement> {
  return [
    text(bucket.kind, { color: palette.fg }),
    text(String(bucket.count), { color: palette.fgMuted }),
    text(formatMs(bucket.meanMs), { color: palette.fg }),
    text(formatMs(bucket.p50), { color: palette.fgMuted }),
    text(formatMs(bucket.p99), { color: palette.fgMuted }),
  ];
}

function slowestRow(op: OperationEntry): Array<HTMLElement> {
  const head = el(
    "div",
    { style: { display: "flex", gap: "8px", alignItems: "center" } },
    [kindGlyph(op.kind), pathLabel(op.path, op.args)],
  );
  return [
    head,
    text(formatMs(op.durationMs), {
      color: op.status === "error" ? palette.error : palette.fg,
    }),
    text(formatTime(op.startMs), { color: palette.fgDim }),
  ];
}

export const performanceTab: DevtoolsTab = {
  id: "performance",
  name: "Performance",
  mount: (host, source) => {
    const root = el("div", {
      style: {
        height: "100%",
        minHeight: "0",
        overflow: "auto",
        padding: "12px",
      },
    });
    host.appendChild(root);

    function render(): void {
      const summary = source.getSnapshot("performance");
      root.textContent = "";

      const latency =
        summary.buckets.length === 0
          ? empty("No operations recorded yet.")
          : table(
              ["Kind", "Count", "Mean", "p50", "p99"],
              summary.buckets.map(bucketRow),
            );
      root.appendChild(section("Latency by kind", latency));

      const slowest =
        summary.slowest.length === 0
          ? empty("No operations recorded yet.")
          : table(
              ["Operation", "Duration", "Started"],
              summary.slowest.map(slowestRow),
            );
      root.appendChild(section("Slowest operations", slowest));
    }

    render();

    const unsubscribe = source.subscribe("performance", render);

    return () => {
      unsubscribe();
      root.remove();
    };
  },
};
