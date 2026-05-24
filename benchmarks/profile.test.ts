import type { BufferedLog, BufferedSpan } from "@embedded/tracing/buffer";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import { expect, it } from "@tests/testkit";

import {
  closeTrackedResources,
  makeRow,
  seededSqliteRuntime,
  sizeByLabel,
} from "./helpers";

const MUTATIONS = 300;
const QUERIES = 300;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
}

function report(spans: BufferedSpan[]): void {
  const byName = new Map<string, number[]>();
  for (const span of spans) {
    const list = byName.get(span.name);
    if (list) {
      list.push(span.durMs);
    } else {
      byName.set(span.name, [span.durMs]);
    }
  }

  const rows = [...byName.entries()]
    .map(([name, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const total = sorted.reduce((sum, value) => sum + value, 0);
      return {
        name,
        count: sorted.length,
        mean: total / sorted.length,
        p50: percentile(sorted, 50),
        p99: percentile(sorted, 99),
        total,
      };
    })
    .sort((a, b) => b.total - a.total);

  const header = `${"span".padEnd(42)}${"count".padStart(7)}${"mean".padStart(9)}${"p50".padStart(9)}${"p99".padStart(9)}${"total".padStart(10)}`;
  console.log(`\n[PROFILE] span breakdown (ms)\n${header}`);
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(42)}${String(row.count).padStart(7)}${row.mean.toFixed(3).padStart(9)}${row.p50.toFixed(3).padStart(9)}${row.p99.toFixed(3).padStart(9)}${row.total.toFixed(1).padStart(10)}`,
    );
  }
}

function logCategory(entry: BufferedLog): string {
  const category = entry.attributes.category;
  if (typeof category === "string") return category;
  const source = entry.attributes.source;
  if (typeof source === "string") return source;
  return "unknown";
}

function reportLogs(logs: BufferedLog[]): void {
  const byKey = new Map<string, number>();
  for (const entry of logs) {
    const key = `${entry.severity}\t${logCategory(entry)}`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  console.log(`\n[PROFILE] log records (${logs.length} total)`);
  console.log(
    `${"severity".padEnd(10)}${"category".padEnd(24)}${"count".padStart(7)}`,
  );
  for (const [key, count] of [...byKey.entries()].sort((a, b) => b[1] - a[1])) {
    const [severity, category] = key.split("\t");
    console.log(
      `${(severity ?? "").padEnd(10)}${(category ?? "").padEnd(24)}${String(count).padStart(7)}`,
    );
  }
}

it("profiles executeLocal hot path via in-memory OTel spans", async () => {
  const seeded = await seededSqliteRuntime(sizeByLabel("medium"));
  const runtime = seeded.runtime;

  const handle = installInMemoryTracing({ capacity: 100_000 });
  let counter = 9_000_000;

  const runMutation = (): Promise<unknown> => {
    counter += 1;
    return runtime.executeLocal({
      kind: "mutation",
      path: "tasks:insert",
      args: { row: makeRow(counter) as unknown as Record<string, unknown> },
      applyLocalEffects: false,
    });
  };
  const runQuery = (): Promise<unknown> =>
    runtime.executeLocal({
      kind: "query",
      path: "tasks:byStatusLimit",
      args: { status: "active", limit: 20 },
    });

  for (let i = 0; i < 20; i += 1) {
    await runMutation();
    await runQuery();
  }
  handle.clearSpans();
  handle.clearLogs();

  for (let i = 0; i < MUTATIONS; i += 1) {
    await runMutation();
  }
  for (let i = 0; i < QUERIES; i += 1) {
    await runQuery();
  }

  const spans = handle.getSpans();
  report(spans);
  reportLogs(handle.getLogs());

  const mutationSpans = spans.filter(
    (span) => span.name === "convex-embedded.executeLocal.mutation",
  );
  const indexSpans = spans.filter(
    (span) => span.name === "convex-embedded.db.applyIndexChanges",
  );
  expect(mutationSpans.length).toBe(MUTATIONS);
  expect(indexSpans.length).toBeGreaterThanOrEqual(MUTATIONS);

  await runtime.db.waitForPersistence();
  await handle.close();
  await closeTrackedResources();
});
