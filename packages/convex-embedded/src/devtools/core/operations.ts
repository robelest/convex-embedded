import type {
  DevtoolsLogLine,
  OperationEntry,
  PerfBucket,
  PerfSummary,
} from "@/devtools/core/types";
import type { BufferedLog, BufferedSpan } from "@/tracing/buffer";

type OperationKind = OperationEntry["kind"];

const SPAN_KIND_BY_NAME: Record<string, OperationKind> = {
  "convex-embedded.executeLocal.query": "query",
  "convex-embedded.executeLocal.mutation": "mutation",
  "convex-embedded.executeLocal.action": "action",
  "convex-embedded.evaluateLocalQuery": "query",
  "convex-embedded.runUdf.query": "query",
  "convex-embedded.runUdf.mutation": "mutation",
  "convex-embedded.runUdf.action": "action",
};

const TOP_LEVEL_SPAN_PREFIXES = [
  "convex-embedded.executeLocal.",
  "convex-embedded.evaluateLocalQuery",
];

const DEFAULT_SLOWEST_COUNT = 10;

function operationKindForSpan(span: BufferedSpan): OperationKind | null {
  return SPAN_KIND_BY_NAME[span.name] ?? null;
}

function operationPathForSpan(span: BufferedSpan): string {
  const underscore = span.attributes["convex.udf_path"];
  if (typeof underscore === "string" && underscore.length > 0) {
    return underscore;
  }
  const dotted = span.attributes["convex.udf.path"];
  if (typeof dotted === "string" && dotted.length > 0) {
    return dotted;
  }
  return "";
}

function operationStatusForSpan(span: BufferedSpan): OperationEntry["status"] {
  return span.status === "error" ? "error" : "ok";
}

function parseCaptured(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toLogLine(log: BufferedLog): DevtoolsLogLine {
  const category = log.attributes.category;
  return {
    severity: log.severity,
    body: log.body,
    timeMs: log.timeMs,
    category: typeof category === "string" ? category : undefined,
  };
}

function indexLogsBySpan(logs: BufferedLog[]): Map<string, BufferedLog[]> {
  const bySpan = new Map<string, BufferedLog[]>();
  for (const log of logs) {
    if (typeof log.spanId !== "string" || log.spanId.length === 0) {
      continue;
    }
    const key = `${log.traceId ?? ""}:${log.spanId}`;
    const existing = bySpan.get(key);
    if (existing) {
      existing.push(log);
    } else {
      bySpan.set(key, [log]);
    }
  }
  return bySpan;
}

/**
 * Map buffered tracing spans + logs into the devtools operations view.
 */
export function spansToOperations(
  spans: BufferedSpan[],
  logs: BufferedLog[],
): OperationEntry[] {
  const logsBySpan = indexLogsBySpan(logs);
  const tracesWithTopLevel = new Set<string>();
  for (const span of spans) {
    if (
      TOP_LEVEL_SPAN_PREFIXES.some((prefix) => span.name.startsWith(prefix))
    ) {
      tracesWithTopLevel.add(span.traceId);
    }
  }

  const operations: OperationEntry[] = [];

  for (const span of spans) {
    const kind = operationKindForSpan(span);
    if (kind === null) {
      continue;
    }
    if (
      span.name.startsWith("convex-embedded.runUdf.") &&
      tracesWithTopLevel.has(span.traceId)
    ) {
      continue;
    }
    const matchedLogs = logsBySpan.get(`${span.traceId}:${span.spanId}`) ?? [];
    const resultRaw = span.attributes["convex.result"];
    operations.push({
      id: span.spanId,
      kind,
      path: operationPathForSpan(span),
      status: operationStatusForSpan(span),
      startMs: span.startMs,
      durationMs: span.durMs,
      error: span.error,
      args: parseCaptured(span.attributes["convex.args"]),
      result: parseCaptured(resultRaw),
      resultSize: typeof resultRaw === "string" ? resultRaw.length : undefined,
      logs: matchedLogs
        .slice()
        .sort((left, right) => left.timeMs - right.timeMs)
        .map(toLogLine),
    });
  }

  operations.sort((left, right) => left.startMs - right.startMs);
  return operations;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
}

function buildBuckets(operations: OperationEntry[]): PerfBucket[] {
  const byKind = new Map<string, number[]>();
  for (const operation of operations) {
    const list = byKind.get(operation.kind);
    if (list) {
      list.push(operation.durationMs);
    } else {
      byKind.set(operation.kind, [operation.durationMs]);
    }
  }

  const buckets: PerfBucket[] = [];
  for (const [kind, durations] of byKind) {
    const sorted = [...durations].sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    buckets.push({
      kind,
      count: sorted.length,
      meanMs: sorted.length > 0 ? total / sorted.length : 0,
      p50: percentile(sorted, 50),
      p99: percentile(sorted, 99),
    });
  }

  buckets.sort((left, right) => left.kind.localeCompare(right.kind));
  return buckets;
}

/**
 * Aggregate operations into per-kind latency buckets plus the slowest
 * operations seen.
 */
export function operationsToPerfSummary(
  operations: OperationEntry[],
  slowestCount = DEFAULT_SLOWEST_COUNT,
): PerfSummary {
  const slowest = [...operations]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, Math.max(0, slowestCount));

  return {
    buckets: buildBuckets(operations),
    slowest,
  };
}

/**
 * Convenience mapping straight from buffered spans + logs to a
 * {@link PerfSummary}.
 */
export function spansToPerfSummary(
  spans: BufferedSpan[],
  logs: BufferedLog[],
  slowestCount = DEFAULT_SLOWEST_COUNT,
): PerfSummary {
  return operationsToPerfSummary(spansToOperations(spans, logs), slowestCount);
}
