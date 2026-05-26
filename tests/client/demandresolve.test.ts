import { engine } from "@resolve/client/engine";
import type {
  EmbeddedClientLike,
  EngineConfig,
  EngineInstance,
  TableConfig,
} from "@resolve/client/engine";
import type { Definition } from "@resolve/server/schema";
import { flushMicrotasks } from "@tests/helpers/time";
import { describe, it, expect, beforeEach, afterEach } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

const SCOPE_DOC_COUNT = 12;
const PAGE = 5;
const COLLECTION_SEQ = 7;

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

function createMockSchema(): Definition {
  const shape = { projectId: "string", title: "string" };
  return {
    version: 1,
    shape,
    defaults: {},
    getShape: () => shape,
    getCrdtFields: () => new Map(),
    getOmittedFields: () => [],
  } as unknown as Definition;
}

function tableConfig(resolve: string): TableConfig {
  return { resolve, schema: createMockSchema() };
}

function makeScopedDocs(scopeArgs: Args): Doc[] {
  const projectId = (scopeArgs.projectId as string) ?? "p";
  return Array.from({ length: SCOPE_DOC_COUNT }, (_, index) => ({
    _id: `${projectId}-doc-${index}`,
    _creationTime: index + 1,
    projectId,
    title: `title-${index}`,
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

function pageFrom(
  rows: Array<{ docId: string; seq: number; document: Doc }>,
  cursor: string | null | undefined,
  numItems: number,
  collectionSeq: number,
) {
  const start =
    typeof cursor === "string" && cursor.length > 0 ? Number(cursor) : 0;
  const slice = rows.slice(start, start + numItems);
  const nextStart = start + slice.length;
  const isDone = nextStart >= rows.length;
  return {
    mode: "full" as const,
    collectionSeq,
    documents: slice,
    isDone,
    continueCursor: isDone ? null : String(nextStart),
  };
}

type EventLog = Array<
  | { kind: "ingest"; size: number; deleteAbsent: boolean }
  | { kind: "metadataSet"; seq: number }
  | { kind: "docMetaSet"; count: number }
  | { kind: "docMetaClear" }
>;

interface Harness {
  engineInstance: EngineInstance;
  remoteClient: MockRemoteClient;
  localDocs: () => Doc[];
  events: EventLog;
  queryCalls: () => number;
  unsubs: Array<ReturnType<typeof vi.fn>>;
  fireLiveSnapshot: (collectionSeq: number) => void;
  bumpSeqs: (delta: number) => void;
  scopeReadCalls: () => Array<{ table: string; scopeArgs: Args }>;
  wholeTableReadCount: () => number;
}

function createHarness(): Harness {
  let docs: Doc[] = [];
  const events: EventLog = [];
  const unsubs: Array<ReturnType<typeof vi.fn>> = [];
  let liveHandler: ((response: unknown) => void) | undefined;
  const docMetaSeqs = new Map<string, number>();
  let collectionSeq: number | null = null;
  let seqBump = 0;

  const localClient = {
    query: vi.fn((path: string, args: Args): Promise<unknown> => {
      if (path === "_system:idMapGetAll") return Promise.resolve([]);
      if (path === "_system:pendingGetAll") return Promise.resolve([]);
      if (path === "_system:collectionMetadataGet")
        return Promise.resolve(collectionSeq);
      if (path === "_system:documentMetadataGetBatch") {
        const docIds = (args.docIds as string[]) ?? [];
        return Promise.resolve(
          docIds
            .filter((docId) => docMetaSeqs.has(docId))
            .map((docId) => ({ docId, seq: docMetaSeqs.get(docId) })),
        );
      }
      return Promise.resolve(null);
    }),
    mutation: vi.fn((path: string, args: Args): Promise<unknown> => {
      if (path === "_system:collectionMetadataSet") {
        collectionSeq = args.seq as number;
        events.push({ kind: "metadataSet", seq: args.seq as number });
      }
      if (path === "_system:documentMetadataSetBatch") {
        const entries =
          (args.entries as Array<{ docId: string; seq: number }>) ?? [];
        for (const entry of entries) docMetaSeqs.set(entry.docId, entry.seq);
        events.push({ kind: "docMetaSet", count: entries.length });
      }
      if (path === "_system:documentMetadataClearCollection") {
        docMetaSeqs.clear();
        events.push({ kind: "docMetaClear" });
      }
      return Promise.resolve(null);
    }),
  };

  const getDocumentsForTableSpy = vi.fn(async () => [...docs]);
  const getDocumentsForScopeSpy = vi.fn(
    async (_table: string, scopeArgs: Args) => {
      const keys = Object.keys(scopeArgs);
      if (keys.length === 0) return [...docs];
      return docs.filter((doc) => keys.every((k) => doc[k] === scopeArgs[k]));
    },
  );

  const embedded: EmbeddedClientLike = {
    client: asConvexClient(localClient),
    ingestDocuments: vi.fn(
      async (
        _table: string,
        nextDocs: Doc[],
        scopeArgs?: Args,
        options?: { deleteAbsent?: boolean; keepIds?: ReadonlySet<string> },
      ) => {
        const deleteAbsent = options?.deleteAbsent === true;
        events.push({ kind: "ingest", size: nextDocs.length, deleteAbsent });
        const byId = new Map(docs.map((doc) => [doc._id as string, doc]));
        for (const doc of nextDocs) byId.set(doc._id as string, doc);
        if (deleteAbsent) {
          const keepIds = options?.keepIds;
          const remoteIds = new Set(nextDocs.map((doc) => doc._id as string));
          for (const id of Array.from(byId.keys())) {
            if (!remoteIds.has(id) && !(keepIds?.has(id) ?? false)) {
              byId.delete(id);
            }
          }
        }
        docs = [...byId.values()];
      },
    ),
    canonicalizeMappedCreate: vi.fn(async () => undefined),
    getDocumentsForTable: getDocumentsForTableSpy,
    getDocumentsForScope: getDocumentsForScopeSpy,
    hasLocalDocumentId: (id: string) => docs.some((doc) => doc._id === id),
  };

  const remoteClient: MockRemoteClient = {
    query: vi.fn(async (_ref: string, args?: Args) => {
      const scopeArgs = (args?.scopeArgs as Args) ?? {};
      const rows = resolveRowsFor(scopeArgs).map((row) => ({
        ...row,
        seq: row.seq + seqBump,
      }));
      return pageFrom(
        rows,
        args?.fullCursor as string | null | undefined,
        PAGE,
        COLLECTION_SEQ + seqBump,
      );
    }),
    mutation: vi.fn(async () => null),
    onUpdate: vi.fn(
      (_ref: unknown, _args: Args, handler: (response: unknown) => void) => {
        liveHandler = handler;
        const unsub = vi.fn();
        unsubs.push(unsub);
        return unsub;
      },
    ),
  };

  const config: EngineConfig = {
    embedded,
    remoteClient: asConvexClient(remoteClient),
    tables: { issues: tableConfig("issues.resolve") },
    maxRetries: 1,
    retryDelayMs: 1,
    scopeTeardownDebounceMs: 0,
  };

  return {
    engineInstance: engine.create(config),
    remoteClient,
    localDocs: () => docs,
    events,
    queryCalls: () => remoteClient.query.mock.calls.length,
    unsubs,
    fireLiveSnapshot: (snapshotSeq: number) => {
      liveHandler?.({
        mode: "full",
        isDone: false,
        collectionSeq: snapshotSeq,
        documents: [],
      });
    },
    bumpSeqs: (delta: number) => {
      seqBump += delta;
    },
    scopeReadCalls: () =>
      getDocumentsForScopeSpy.mock.calls.map(([table, scopeArgs]) => ({
        table,
        scopeArgs,
      })),
    wholeTableReadCount: () => getDocumentsForTableSpy.mock.calls.length,
  };
}

async function settle(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await flushMicrotasks(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flushMicrotasks(3);
}

const SCOPE: Args = { projectId: "project-1" };

function countDocMetaWrites(events: EventLog): number {
  return events.reduce(
    (sum, event) => (event.kind === "docMetaSet" ? sum + event.count : sum),
    0,
  );
}

describe("engine demand-driven resolve", () => {
  let originalAddEventListener: typeof globalThis.addEventListener | undefined;
  let originalRemoveEventListener:
    | typeof globalThis.removeEventListener
    | undefined;
  let originalNavigator: Navigator | undefined;

  beforeEach(() => {
    originalAddEventListener = globalThis.addEventListener;
    originalRemoveEventListener = globalThis.removeEventListener;
    originalNavigator = globalThis.navigator;
    globalThis.addEventListener = vi.fn();
    globalThis.removeEventListener = vi.fn();
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalAddEventListener) {
      globalThis.addEventListener = originalAddEventListener;
    }
    if (originalRemoveEventListener) {
      globalThis.removeEventListener = originalRemoveEventListener;
    }
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
  });

  it("resolves the whole scope on first read, then prunes and advances the watermark", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();

    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);
    expect(harness.queryCalls()).toBeGreaterThan(0);
    expect(
      harness.events.some((e) => e.kind === "ingest" && e.deleteAbsent),
    ).toBe(true);
    expect(harness.events).toContainEqual({
      kind: "metadataSet",
      seq: COLLECTION_SEQ,
    });

    harness.engineInstance.stop();
  });

  it("does not eagerly subscribe or resolve any table on start", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();
    expect(harness.unsubs).toHaveLength(0);
    expect(harness.queryCalls()).toBe(0);
    harness.engineInstance.stop();
  });

  it("skips a redundant live snapshot at the already-resolved collectionSeq", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();
    const callsBefore = harness.queryCalls();

    harness.fireLiveSnapshot(COLLECTION_SEQ);
    await settle();
    expect(harness.queryCalls()).toBe(callsBefore);

    harness.engineInstance.stop();
  });

  it("deactivates a scope after its last reader releases", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();
    expect(harness.unsubs).toHaveLength(0);

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-2");
    await settle();
    const scopedUnsub = harness.unsubs[0];
    expect(scopedUnsub).toBeDefined();
    expect(scopedUnsub).not.toHaveBeenCalled();

    harness.engineInstance.releaseScopeRead("issues", SCOPE, "reader-1");
    await settle();
    expect(scopedUnsub).not.toHaveBeenCalled();

    harness.engineInstance.releaseScopeRead("issues", SCOPE, "reader-2");
    await settle();
    expect(scopedUnsub).toHaveBeenCalled();

    harness.engineInstance.stop();
  });

  it("keeps local docs after teardown and re-subscribes without re-resolving a current scope", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();
    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);
    const callsAfterFirst = harness.queryCalls();

    harness.engineInstance.releaseScopeRead("issues", SCOPE, "reader-1");
    await settle();
    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-3");
    await settle();
    expect(harness.unsubs.length).toBeGreaterThanOrEqual(2);
    expect(harness.queryCalls()).toBe(callsAfterFirst);

    harness.engineInstance.stop();
  });

  it("resolves a scope through the indexed scoped read, not a whole-table read", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();

    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);
    const scopeReads = harness.scopeReadCalls();
    expect(scopeReads.length).toBeGreaterThan(0);
    expect(scopeReads).toContainEqual({ table: "issues", scopeArgs: SCOPE });
    expect(harness.wholeTableReadCount()).toBe(0);

    harness.engineInstance.stop();
  });

  it("a live resolve with unchanged doc seqs writes no doc-metadata and never wipes the collection", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();

    expect(countDocMetaWrites(harness.events)).toBe(SCOPE_DOC_COUNT);
    expect(harness.events.some((e) => e.kind === "docMetaClear")).toBe(false);

    const writesAfterFirst = countDocMetaWrites(harness.events);
    harness.fireLiveSnapshot(COLLECTION_SEQ + 1);
    await settle();

    expect(countDocMetaWrites(harness.events)).toBe(writesAfterFirst);
    expect(harness.events.some((e) => e.kind === "docMetaClear")).toBe(false);

    harness.engineInstance.stop();
  });

  it("a live resolve writes doc-metadata again for docs whose seq advanced", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();
    const writesAfterFirst = countDocMetaWrites(harness.events);

    harness.bumpSeqs(1);
    harness.fireLiveSnapshot(COLLECTION_SEQ + 5);
    await settle();

    expect(countDocMetaWrites(harness.events)).toBe(
      writesAfterFirst + SCOPE_DOC_COUNT,
    );

    harness.engineInstance.stop();
  });

  it("resolves a scope activated while offline once the client comes online", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", SCOPE, "reader-1");
    await settle();
    expect(harness.queryCalls()).toBe(0);
    expect(harness.localDocs()).toHaveLength(0);

    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
    const onlineHandler = (
      globalThis.addEventListener as unknown as {
        mock: { calls: Array<[string, () => void]> };
      }
    ).mock.calls.find(([event]) => event === "online")?.[1];
    expect(onlineHandler).toBeTypeOf("function");
    onlineHandler?.();
    await settle();

    expect(harness.queryCalls()).toBeGreaterThan(0);
    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);

    harness.engineInstance.stop();
  });
});
