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
const RESOLVE_PAGE_SIZE = 5;
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

function buildPage(
  rows: Array<{ docId: string; seq: number; document: Doc }>,
  fullCursor: string | null | undefined,
  collectionSeq: number,
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
    collectionSeq,
    documents: slice,
    isDone,
    continueCursor: isDone ? null : String(nextStart),
  };
}

type EventLog = Array<
  | { kind: "ingest"; size: number; deleteAbsent: boolean }
  | { kind: "metadataSet"; seq: number }
>;

interface Harness {
  engineInstance: EngineInstance;
  remoteClient: MockRemoteClient;
  localDocs: () => Doc[];
  events: EventLog;
  invalidationSizes: number[];
  fireLiveSnapshot: (collectionSeq: number) => void;
  resolveGate: { release: () => void; hold: () => void };
}

function createHarness(): Harness {
  let docs: Doc[] = [];
  const events: EventLog = [];
  const invalidationSizes: number[] = [];

  const localClient = {
    query: vi.fn((path: string): Promise<unknown> => {
      if (path === "_system:idMapGetAll") return Promise.resolve([]);
      if (path === "_system:pendingGetAll") return Promise.resolve([]);
      if (path === "_system:collectionMetadataGet")
        return Promise.resolve(null);
      if (path === "_system:documentMetadataGetForDocs") {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    }),
    mutation: vi.fn((path: string, args: Args): Promise<unknown> => {
      if (path === "_system:collectionMetadataSet") {
        events.push({ kind: "metadataSet", seq: args.seq as number });
      }
      return Promise.resolve(null);
    }),
  };

  const embedded: EmbeddedClientLike = {
    client: asConvexClient(localClient),
    ingestDocuments: vi.fn(
      async (
        _table: string,
        nextDocs: Doc[],
        scopeArgs?: Args,
        options?: { deleteAbsent?: boolean; keepIds?: ReadonlySet<string> },
      ) => {
        const deleteAbsent = options?.deleteAbsent !== false;
        events.push({
          kind: "ingest",
          size: nextDocs.length,
          deleteAbsent,
        });

        const byId = new Map(docs.map((doc) => [doc._id as string, doc]));
        for (const doc of nextDocs) {
          byId.set(doc._id as string, doc);
        }
        if (deleteAbsent) {
          const remoteIds = new Set(nextDocs.map((doc) => doc._id as string));
          const keepIds = options?.keepIds;
          for (const id of Array.from(byId.keys())) {
            const inScope =
              scopeArgs === undefined ||
              Object.entries(scopeArgs).every(
                ([key, value]) => byId.get(id)?.[key] === value,
              );
            if (inScope && !remoteIds.has(id) && !(keepIds?.has(id) ?? false)) {
              byId.delete(id);
            }
          }
        }
        docs = [...byId.values()];
        invalidationSizes.push(docs.length);
      },
    ),
    canonicalizeMappedCreate: vi.fn(async () => undefined),
    getDocumentsForTable: vi.fn(async () => [...docs]),
    hasLocalDocumentId: (id: string) => docs.some((doc) => doc._id === id),
  };

  let liveSnapshotHandler: ((response: unknown) => void) | undefined;
  let liveScopeArgs: Args = {};

  let held = false;
  let pendingReleases: Array<() => void> = [];
  const gateBarrier = () =>
    held
      ? new Promise<void>((resolve) => pendingReleases.push(resolve))
      : Promise.resolve();

  const remoteClient: MockRemoteClient = {
    query: vi.fn(async (_ref: string, args?: Args) => {
      const scopeArgs = (args?.scopeArgs as Args) ?? {};
      const rows = resolveRowsFor(scopeArgs);
      const page = buildPage(
        rows,
        args?.fullCursor as string | null | undefined,
        COLLECTION_SEQ,
      );
      if ((args?.fullCursor as string | undefined) !== undefined) {
        await gateBarrier();
      }
      return page;
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
    tables: { issues: tableConfig("issues.resolve") },
    maxRetries: 1,
    retryDelayMs: 1,
  };

  return {
    engineInstance: engine.create(config),
    remoteClient,
    localDocs: () => docs,
    events,
    invalidationSizes,
    fireLiveSnapshot: (collectionSeq: number) => {
      const rows = resolveRowsFor(liveScopeArgs);
      const snapshot = buildPage(rows, undefined, collectionSeq);
      liveSnapshotHandler?.(snapshot);
    },
    resolveGate: {
      hold: () => {
        held = true;
      },
      release: () => {
        held = false;
        const releases = pendingReleases;
        pendingReleases = [];
        for (const release of releases) release();
      },
    },
  };
}

async function settle(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await flushMicrotasks(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flushMicrotasks(3);
}

describe("engine cold open", () => {
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

  it("resolves the scope exactly once (no redundant warm re-resolve)", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", {
      projectId: "project-1",
    });
    await settle();

    const pageCount = Math.ceil(SCOPE_DOC_COUNT / RESOLVE_PAGE_SIZE);
    expect(harness.remoteClient.query).toHaveBeenCalledTimes(pageCount);

    // Live subscription fires its first snapshot at the SAME collectionSeq we
    // just resolved at. This must be recognised as redundant and skipped.
    harness.fireLiveSnapshot(COLLECTION_SEQ);
    await settle();

    expect(harness.remoteClient.query).toHaveBeenCalledTimes(pageCount);
    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);

    harness.engineInstance.stop();
  });

  it("re-resolves when the live snapshot advances past the resolved seq", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", {
      projectId: "project-1",
    });
    await settle();

    const pageCount = Math.ceil(SCOPE_DOC_COUNT / RESOLVE_PAGE_SIZE);
    expect(harness.remoteClient.query).toHaveBeenCalledTimes(pageCount);

    // A genuinely newer snapshot must trigger another resolve.
    harness.fireLiveSnapshot(COLLECTION_SEQ + 1);
    await settle();

    expect(harness.remoteClient.query.mock.calls.length).toBeGreaterThan(
      pageCount,
    );

    harness.engineInstance.stop();
  });

  it("streams ingest per page and advances metadata only after completion", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    // Hold subsequent pages so we can observe that page 1 is ingested (and
    // observable) before the full resolve completes and metadata advances.
    harness.resolveGate.hold();

    const ready = harness.engineInstance.ensureScopeReady("issues", {
      projectId: "project-1",
    });
    await settle();

    // First page has been ingested; metadata has NOT advanced yet.
    const ingestsBeforeRelease = harness.events.filter(
      (event) => event.kind === "ingest",
    );
    expect(ingestsBeforeRelease.length).toBeGreaterThanOrEqual(1);
    expect(harness.localDocs().length).toBe(RESOLVE_PAGE_SIZE);
    expect(harness.events.some((event) => event.kind === "metadataSet")).toBe(
      false,
    );

    harness.resolveGate.release();
    await ready;
    await settle();

    // All pages ingested append-only; metadata advances exactly once, last.
    const ingestEvents = harness.events.filter(
      (event) => event.kind === "ingest",
    );
    const pageIngests = ingestEvents.filter(
      (event) => event.kind === "ingest" && event.deleteAbsent === false,
    );
    const pageCount = Math.ceil(SCOPE_DOC_COUNT / RESOLVE_PAGE_SIZE);
    expect(pageIngests.length).toBe(pageCount);

    const metadataEvents = harness.events.filter(
      (event) => event.kind === "metadataSet",
    );
    expect(metadataEvents).toHaveLength(1);
    expect(metadataEvents[0]).toEqual({
      kind: "metadataSet",
      seq: COLLECTION_SEQ,
    });

    // metadataSet is the LAST event (after every ingest).
    const lastEvent = harness.events[harness.events.length - 1];
    expect(lastEvent?.kind).toBe("metadataSet");

    expect(harness.localDocs()).toHaveLength(SCOPE_DOC_COUNT);

    harness.engineInstance.stop();
  });

  it("ends with the full scope present locally (offline-first)", async () => {
    const harness = createHarness();
    harness.engineInstance.start();
    await settle();

    await harness.engineInstance.ensureScopeReady("issues", {
      projectId: "project-1",
    });
    await settle();

    const ids = new Set(harness.localDocs().map((doc) => doc._id));
    for (let index = 0; index < SCOPE_DOC_COUNT; index += 1) {
      expect(ids.has(`project-1-doc-${index}`)).toBe(true);
    }

    harness.engineInstance.stop();
  });
});
