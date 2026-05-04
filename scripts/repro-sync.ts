/**
 * Node reproducer for the Expo demo's "few issues land" sync bug.
 *
 * Usage:
 *   vp dlx tsx scripts/repro-sync.ts
 *   vp dlx tsx scripts/repro-sync.ts --db=/tmp/repro.db
 *   vp dlx tsx scripts/repro-sync.ts --watch
 *   CONVEX_URL=https://… vp dlx tsx scripts/repro-sync.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { DEMO_WORKSPACE_ID } from "../convex/workspace";
import { installInMemoryTracing } from "@robelest/convex-embedded";
import { createConvexClient } from "@robelest/convex-embedded/node";
import type { ConvexModuleRegistry } from "@robelest/convex-embedded";

const CONVEX_URL =
  process.env.CONVEX_URL ?? "https://academic-pigeon-835.convex.cloud";

const args = parseArgs();
const tracing = installInMemoryTracing({ capacity: 5000 });

interface BufferedSpan {
  name: string;
  durMs: number;
  attributes: Record<string, unknown>;
}

interface ProjectRow {
  _id: string;
  identifier: string;
  name: string;
  issueCounter?: number;
}

interface IssueListResult {
  page: Array<{ _id: string }>;
  isDone: boolean;
  continueCursor: string | null;
}

type Unsub = (() => void) & { unsubscribe: () => void };

function parseArgs(): {
  dbPath: string | undefined;
  watch: boolean;
  waitMs: number;
  maxProjects: number;
} {
  let dbPath: string | undefined;
  let watch = false;
  let waitMs = 30_000;
  let maxProjects = Number.POSITIVE_INFINITY;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--watch") watch = true;
    else if (arg.startsWith("--db=")) dbPath = arg.slice(5);
    else if (arg.startsWith("--wait=")) waitMs = Number(arg.slice(7)) * 1000;
    else if (arg.startsWith("--max=")) maxProjects = Number(arg.slice(6));
  }
  return { dbPath, watch, waitMs, maxProjects };
}

function createModules(): ConvexModuleRegistry {
  return {
    "_generated/api": () => import("../convex/_generated/api.js"),
    "_generated/server": () => import("../convex/_generated/server.js"),
    schema: () => import("../convex/schema"),
    projects: () => import("../convex/projects"),
    issues: () => import("../convex/issues"),
    comments: () => import("../convex/comments"),
    workspace: () => import("../convex/workspace"),
  } satisfies ConvexModuleRegistry;
}

interface SpanAggRow {
  name: string;
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
  max: number;
}

function aggregateSpans(spans: BufferedSpan[]): SpanAggRow[] {
  const groups = new Map<string, number[]>();
  for (const span of spans) {
    const arr = groups.get(span.name);
    if (arr) arr.push(span.durMs);
    else groups.set(span.name, [span.durMs]);
  }
  const rows: SpanAggRow[] = [];
  for (const [name, durs] of groups) {
    const sorted = durs.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, x) => acc + x, 0);
    rows.push({
      name,
      count: sorted.length,
      totalMs: sum,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1] ?? 0,
    });
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  return rows;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx] ?? 0;
}

function printSpanSummary(): void {
  const spans = tracing.getSpans() as BufferedSpan[];
  console.log(`\n[spans] total recorded: ${spans.length}`);
  if (spans.length === 0) return;
  const rows = aggregateSpans(spans);
  console.log(
    `\n${"name".padEnd(48)} ${"n".padStart(5)}  ${"p50".padStart(7)}  ${"p95".padStart(7)}  ${"max".padStart(7)}  ${"sum".padStart(8)}`,
  );
  console.log("-".repeat(89));
  for (const row of rows.slice(0, 30)) {
    const short = row.name.replace("convex-embedded.", "");
    console.log(
      `${short.padEnd(48)} ${String(row.count).padStart(5)}  ${row.p50.toFixed(1).padStart(7)}  ${row.p95.toFixed(1).padStart(7)}  ${row.max.toFixed(1).padStart(7)}  ${row.totalMs.toFixed(1).padStart(8)}`,
    );
  }

  const slow = spans
    .filter((s) => s.durMs >= 200)
    .sort((a, b) => b.durMs - a.durMs)
    .slice(0, 10);
  if (slow.length > 0) {
    console.log("\n[spans] slowest (≥200ms):");
    for (const s of slow) {
      const attrSummary = Object.entries(s.attributes)
        .map(([k, v]) => `${k.replace(/^convex\./, "")}=${formatVal(v)}`)
        .join(" ");
      console.log(
        `  ${s.durMs.toFixed(1).padStart(7)}ms  ${s.name.replace("convex-embedded.", "").padEnd(40)}  ${attrSummary}`,
      );
    }
  }
}

function formatVal(v: unknown): string {
  if (typeof v === "string" && v.length > 60) return `${v.slice(0, 57)}…`;
  if (typeof v === "number" && !Number.isInteger(v)) return v.toFixed(1);
  return String(v);
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (predicate()) {
      resolve(true);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function snapshot(
  projects: ProjectRow[],
  issuesByProject: Map<string, IssueListResult | undefined>,
  errorsByProject: Map<string, unknown>,
): { totalLocal: number; totalCounter: number } {
  console.log("\n=== snapshot ===");
  console.log(`projects: ${projects.length}`);
  let totalLocal = 0;
  let totalCounter = 0;
  for (const project of projects) {
    const data = issuesByProject.get(project._id);
    const error = errorsByProject.get(project._id);
    const localCount = data?.page.length ?? 0;
    const counter = project.issueCounter ?? 0;
    const expectedFirstPage = Math.min(counter, 30);
    const flag =
      error !== undefined
        ? `  ← ERROR ${(error as Error).message}`
        : data === undefined
          ? "  ← PENDING"
          : counter > 0 && localCount < expectedFirstPage
            ? "  ← MISSING"
            : "";
    console.log(
      `  ${project.identifier.padEnd(12)} local=${String(localCount).padStart(5)}  counter=${String(counter).padStart(5)}${flag}`,
    );
    totalLocal += localCount;
    totalCounter += counter;
  }
  console.log(`\nTOTAL: local=${totalLocal}  counter_sum=${totalCounter}`);
  return { totalLocal, totalCounter };
}

async function main() {
  const dbPath =
    args.dbPath ??
    join(mkdtempSync(join(tmpdir(), "convex-embedded-repro-")), "data.db");
  console.log(`[setup] CONVEX_URL=${CONVEX_URL}`);
  console.log(`[setup] dbPath=${dbPath}`);
  console.log(`[setup] waitMs=${args.waitMs}`);

  const startedAt = Date.now();
  const client = createConvexClient({
    convex: { modules: createModules() },
    schema,
    name: "convex-embedded-repro",
    databasePath: dbPath,
    remote: { url: CONVEX_URL },
  });

  const issueSubs = new Map<string, Unsub>();
  const issuesByProject = new Map<string, IssueListResult | undefined>();
  const errorsByProject = new Map<string, unknown>();
  let projects: ProjectRow[] = [];

  const subscribeToProject = (project: ProjectRow) => {
    if (issueSubs.has(project._id)) return;
    const unsub = client.onUpdate(
      api.issues.forProject,
      {
        projectId: project._id as never,
        paginationOpts: { numItems: 30, cursor: null },
      },
      (data: IssueListResult | undefined) => {
        if (data !== undefined) {
          issuesByProject.set(project._id, data);
          errorsByProject.delete(project._id);
        }
      },
      (err: Error) => {
        errorsByProject.set(project._id, err);
      },
    ) as Unsub;
    issueSubs.set(project._id, unsub);
    if (!issuesByProject.has(project._id)) {
      issuesByProject.set(project._id, undefined);
    }
  };

  const projectsUnsub = client.onUpdate(
    api.projects.list,
    { workspaceId: DEMO_WORKSPACE_ID },
    (result: ProjectRow[] | undefined) => {
      if (!Array.isArray(result)) return;
      const before = projects.length;
      projects = result;
      if (projects.length !== before) {
        console.log(`[projects] received ${projects.length} project(s)`);
      }
      const limit = Number.isFinite(args.maxProjects)
        ? Math.min(args.maxProjects, projects.length)
        : projects.length;
      for (let i = 0; i < limit; i++) subscribeToProject(projects[i]!);
    },
    (err: Error) => {
      console.error("[projects] subscription error:", err.message);
    },
  ) as Unsub;

  try {
    console.log(`[setup] client created in +${Date.now() - startedAt}ms`);
    console.log(`[setup] waiting up to 30s for projects to populate...`);
    const projectsLanded = await waitFor(() => projects.length > 0, 30_000);
    if (!projectsLanded) {
      console.warn("[setup] projects did not land within 30s");
    } else {
      console.log(
        `[setup] projects landed (${projects.length}) in +${Date.now() - startedAt}ms`,
      );
    }

    console.log(
      `[activate] forProject subscriptions registered for ${issueSubs.size} projects`,
    );
    console.log(`[activate] sleeping ${args.waitMs}ms for issue scopes to resolve...`);
    await new Promise((resolve) => setTimeout(resolve, args.waitMs));

    snapshot(projects, issuesByProject, errorsByProject);
    printSpanSummary();

    if (args.watch) {
      console.log("\n[watch] re-snapshotting every 5s — Ctrl+C to exit");
      tracing.clearSpans();
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        snapshot(projects, issuesByProject, errorsByProject);
        printSpanSummary();
        tracing.clearSpans();
      }
    }
  } finally {
    if (!args.watch) {
      for (const unsub of issueSubs.values()) unsub();
      projectsUnsub();
      await (client as unknown as { close(): Promise<void> }).close();
    }
  }
}

main().catch((error) => {
  console.error("\n[error]", error);
  printSpanSummary();
  process.exit(1);
});
