import type { BufferedSpan } from "@embedded/tracing/buffer";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import { engine } from "@resolve/client/engine";
import type {
  EmbeddedClientLike,
  EngineConfig,
  EngineInstance,
  TableConfig,
} from "@resolve/client/engine";
import type { Definition } from "@resolve/server/schema";
import { expect, it, vi } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

import { crdtTaskDefinition, crdtSeedRow } from "./helpers";

const SCOPE_DOC_COUNT = 499;
const RESOLVE_PAGE_SIZE = 100;

type Args = Record<string, unknown>;
type Doc = Record<string, unknown>;

interface MockRemoteClient {
  query: ReturnType<typeof vi.fn>;
  mutation: ReturnType<typeof vi.fn>;
  onUpdate: ReturnType<typeof vi.fn>;
}

function asConvexClient(client: unknown): ConvexClient {
  return client as unknown as ConvexClient;
}

function tableConfig(resolve: string, schema: Definition): TableConfig {
  return { resolve, schema };
}

function makeScopedDocs(scopeArgs: Args): Doc[] {
  const projectId = scopeArgs.projectId as string;
  return Array.from({ length: SCOPE_DOC_COUNT }, (_, index) => ({
    ...crdtSeedRow(index),
    projectId,
  }));
}

function resolveRowsFor(scopeArgs: Args): Array<{
  docId: string;
  seq: number;
  document: Doc;
}> {
  return makeScopedDocs(scopeArgs).map((document, index) => ({
    docId: document._id as string,
    seq: index,
    document,
  }));
}

function buildPage(
  rows: Array<{ docId: string; seq: number; document: Doc }>,
  fullCursor: string | null | undefined,
) {
  const start =
    typeof fullCursor === "string" && fullCursor.length > 0
      ? Number(fullCursor)
      : 0;
  const slice = rows.slice(start, start + RESOLVE_PAGE_SIZE);
  const nextStart = start + slice.length;
  const isDone = nextStart >= rows.length;
  return {
    mode: "full" as const,
    collectionSeq: 0,
    documents: slice,
    isDone,
    continueCursor: isDone ? null : String(nextStart),
  };
}

interface ColdOpenHarness {
  engineInstance: EngineInstance;
  remoteClient: MockRemoteClient;
  ingestCalls: number[];
  localDocs: () => Doc[];
  fireLiveSnapshot: () => void;
}

function createColdOpenHarness(): ColdOpenHarness {
  let docs: Doc[] = [];
  const ingestCalls: number[] = [];

  const localClient = {
    query: vi.fn((path: string): Promise<unknown> => {
      if (path === "_system:idMapGetAll") return Promise.resolve([]);
      if (path === "_system:pendingGetAll") return Promise.resolve([]);
      return Promise.resolve(null);
    }),
    mutation: vi.fn((): Promise<unknown> => Promise.resolve(null)),
  };

  const embedded: EmbeddedClientLike = {
    client: asConvexClient(localClient),
    ingestDocuments: vi.fn(async (_table: string, nextDocs: Doc[]) => {
      ingestCalls.push(nextDocs.length);
      const byId = new Map(docs.map((doc) => [doc._id as string, doc]));
      for (const doc of nextDocs) {
        byId.set(doc._id as string, doc);
      }
      docs = Array.from(byId.values());
    }),
    canonicalizeMappedCreate: vi.fn(async () => undefined),
    getDocumentsForTable: vi.fn(async () => [...docs]),
    hasLocalDocumentId: (id: string) => docs.some((doc) => doc._id === id),
  };

  let liveSnapshotHandler: ((response: unknown) => void) | undefined;
  let liveScopeArgs: Args | undefined;

  const remoteClient: MockRemoteClient = {
    query: vi.fn(async (_ref: string, args?: Args) => {
      const scopeArgs = (args?.scopeArgs as Args) ?? {};
      const rows = resolveRowsFor(scopeArgs);
      return buildPage(rows, args?.fullCursor as string | null | undefined);
    }),
    mutation: vi.fn(async () => null),
    onUpdate: vi.fn(
      (_ref: unknown, args: Args, handler: (response: unknown) => void) => {
        liveSnapshotHandler = handler;
        liveScopeArgs = (args?.scopeArgs as Args) ?? {};
        return vi.fn();
      },
    ),
  };

  const config: EngineConfig = {
    embedded,
    remoteClient: asConvexClient(remoteClient),
    tables: { issues: tableConfig("issues.resolve", crdtTaskDefinition()) },
    maxRetries: 1,
    retryDelayMs: 1,
  };

  return {
    engineInstance: engine.create(config),
    remoteClient,
    ingestCalls,
    localDocs: () => docs,
    fireLiveSnapshot: () => {
      const rows = resolveRowsFor(liveScopeArgs ?? {});
      liveSnapshotHandler?.(buildPage(rows, undefined));
    },
  };
}

async function settle(iterations = 16): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.resolve();
}

function spanTotals(spans: BufferedSpan[]): void {
  const byName = new Map<string, { count: number; total: number }>();
  for (const span of spans) {
    const row = byName.get(span.name) ?? { count: 0, total: 0 };
    row.count += 1;
    row.total += span.durMs;
    byName.set(span.name, row);
  }
  const rows = [...byName.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log(
    `\n[COLD-OPEN] span breakdown (ms)\n${"span".padEnd(46)}${"count".padStart(7)}${"total".padStart(11)}${"mean".padStart(11)}`,
  );
  for (const [name, row] of rows) {
    console.log(
      `${name.padEnd(46)}${String(row.count).padStart(7)}${row.total.toFixed(2).padStart(11)}${(row.total / row.count).toFixed(3).padStart(11)}`,
    );
  }
}

it("profiles a 499-doc scoped cold open", async () => {
  const harness = createColdOpenHarness();
  const tracing = installInMemoryTracing({ capacity: 100_000 });

  harness.engineInstance.start();
  await settle();

  const t0 = performance.now();
  const ready = harness.engineInstance.ensureScopeReady("issues", {
    projectId: "project-cold",
  });

  await ready;
  const tFirstPaintComplete = performance.now();

  harness.fireLiveSnapshot();
  await settle();
  const tAfterLiveSnapshot = performance.now();

  const spans = tracing.getSpans();
  spanTotals(spans);

  for (const span of spans.filter(
    (s) => s.name === "convex_embedded.resolve.prepareInput",
  )) {
    console.log(
      `[COLD-OPEN] prepareInput local_doc_count=${String(span.attributes?.local_doc_count)} dur=${span.durMs.toFixed(2)}ms`,
    );
  }

  const resolveTableSpans = spans.filter(
    (span) => span.name === "convex-embedded.getTableSpec",
  );
  const queryCalls = harness.remoteClient.query.mock.calls.length;

  console.log(
    `\n[COLD-OPEN] getTableSpec invocations: ${resolveTableSpans.length}`,
  );
  console.log(`[COLD-OPEN] remoteClient.query calls: ${queryCalls}`);
  console.log(
    `[COLD-OPEN] ingest call sizes: ${harness.ingestCalls.join(",")}`,
  );
  console.log(
    `[COLD-OPEN] ensureScopeReady (cold resolve) time: ${(tFirstPaintComplete - t0).toFixed(1)}ms`,
  );
  console.log(
    `[COLD-OPEN] post-live-snapshot total time: ${(tAfterLiveSnapshot - t0).toFixed(1)}ms`,
  );
  console.log(
    `[COLD-OPEN] local docs after open: ${harness.localDocs().length}`,
  );

  harness.engineInstance.stop();
  await tracing.close();

  expect(harness.localDocs().length).toBe(SCOPE_DOC_COUNT);
});
