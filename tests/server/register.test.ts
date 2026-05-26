import { register as registerField, prose } from "@resolve/server/fields";
import { bindTableRuntime } from "@resolve/server/runtime";
import type {
  ComponentBinding,
  EmbeddedTableRuntimeHandle,
  RuntimeHooks,
} from "@resolve/server/schema";
import {
  embeddedTable,
  localOnly,
  remoteOnly,
  _resetRegistry,
  REMOTE_META,
} from "@resolve/server/table";
import { toArrayBuffer } from "@tests/helpers/convex";
import { beforeEach, describe, expect, it, vi } from "@tests/testkit";
import { v } from "convex/values";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Types describing the runtime surface of embedded functions
// ---------------------------------------------------------------------------

/** A stand-in for a component function reference, discriminated by `_name`. */
interface MockRef {
  _name: string;
}

interface MockComponent {
  public: {
    recordUpdate: MockRef;
    recordDelete: MockRef;
    getLiveState: MockRef;
    getLiveStates: MockRef;
    getLiveStatesPage: MockRef;
    getCollectionChanges: MockRef;
    createCheckpoint: MockRef;
    listCheckpoints: MockRef;
    getCheckpoint: MockRef;
    cleanupDoc: MockRef;
  };
}

const ROUTE = Symbol.for("convex-embedded:route");

interface RouteMeta {
  __brand: string;
  mode: string;
}

/** Runtime-only properties the SDK attaches to registered Convex functions. */
interface RegisteredFn {
  isQuery?: boolean;
  isMutation?: boolean;
  isPublic?: boolean;
  exportArgs?: () => string;
  exportReturns?: () => string;
  _handler: (ctx: object, args: Record<string, unknown>) => Promise<unknown>;
}

type PullArgs = Parameters<NonNullable<RuntimeHooks["pullHandler"]>>[1];
type ResolveResult = Awaited<
  ReturnType<NonNullable<RuntimeHooks["pullHandler"]>>
>;

interface ResolveFn {
  isQuery?: boolean;
  isPublic?: boolean;
  _handler: (ctx: object, args: PullArgs) => Promise<ResolveResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique table name per test to avoid registry collisions. */
let _counter = 0;
function uniqueTable(): string {
  return `test_table_${++_counter}`;
}

function makeMockComponent(): MockComponent {
  return {
    public: {
      recordUpdate: { _name: "recordUpdate" },
      recordDelete: { _name: "recordDelete" },
      getLiveState: { _name: "getLiveState" },
      getLiveStates: { _name: "getLiveStates" },
      getLiveStatesPage: { _name: "getLiveStatesPage" },
      getCollectionChanges: { _name: "getCollectionChanges" },
      createCheckpoint: { _name: "createCheckpoint" },
      listCheckpoints: { _name: "listCheckpoints" },
      getCheckpoint: { _name: "getCheckpoint" },
      cleanupDoc: { _name: "cleanupDoc" },
    },
  };
}

function bindRuntime(
  table: EmbeddedTableRuntimeHandle,
  component?: MockComponent,
): void {
  bindTableRuntime(
    table,
    component ? (component as unknown as ComponentBinding) : undefined,
  );
}

/**
 * `.index()` is typed to return the bare `TableDefinition`, but at runtime it
 * returns the same embedded table handle. Recover the runtime-facing type.
 */
function asHandle(table: unknown): EmbeddedTableRuntimeHandle {
  return table as EmbeddedTableRuntimeHandle;
}

function asFn(value: unknown): RegisteredFn {
  return value as RegisteredFn;
}

function asResolveFn(value: unknown): ResolveFn {
  return value as ResolveFn;
}

function readRoute(value: unknown): RouteMeta | undefined {
  return (value as Record<symbol, RouteMeta | undefined>)[ROUTE];
}

function readRemoteMeta(
  value: unknown,
): { __brand: string; table: string; resolveExport: string } | undefined {
  return (
    value as Record<
      symbol,
      { __brand: string; table: string; resolveExport: string } | undefined
    >
  )[REMOTE_META];
}

beforeEach(() => {
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// embeddedTable() + runtime binding
// ---------------------------------------------------------------------------

describe("embeddedTable()", () => {
  it("returns a handle with resolve, mutation, and query", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    expect(tasks).toHaveProperty("resolve");
    expect(typeof tasks.mutation).toBe("function");
    expect(typeof tasks.query).toBe("function");
  });

  it("resolve exports args via exportArgs", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const resolve = asFn(tasks.resolve);
    expect(typeof resolve.exportArgs).toBe("function");
    const argsJson: unknown = JSON.parse(resolve.exportArgs!());
    expect(argsJson).toBeDefined();
  });

  it("tags resolve with the REMOTE_META symbol", () => {
    const name = uniqueTable();
    const tasks = embeddedTable(name, {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const meta = readRemoteMeta(tasks.resolve);
    expect(meta).toBeDefined();
    expect(meta?.__brand).toBe("convex-embedded:remoteMeta");
    expect(meta?.table).toBe(name);
    expect(meta?.resolveExport).toBe("resolve");
  });

  it("exposes REMOTE_META via Symbol.for (cross-package)", () => {
    const name = uniqueTable();
    const tasks = embeddedTable(name, {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const crossPkgSymbol = Symbol.for("convex-embedded:remoteMeta");
    const meta = (
      tasks.resolve as Record<symbol, { table: string } | undefined>
    )[crossPkgSymbol];
    expect(meta).toBeDefined();
    expect(meta?.table).toBe(name);
  });

  it("does not make REMOTE_META enumerable", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });

    expect(Object.keys(tasks.resolve)).not.toContain(REMOTE_META.toString());
    const keys: string[] = [];
    for (const k in tasks.resolve) keys.push(k);
    expect(keys).not.toContain(REMOTE_META.toString());
  });

  it("remoteOnly() tags function exports with remote route metadata", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn = tasks.query({
      args: {},
      handler: async () => [],
    });

    const wrapped = remoteOnly(fn);

    expect(wrapped).toBe(fn);
    expect(readRoute(wrapped)).toEqual({
      __brand: "convex-embedded:route",
      mode: "remote",
    });
  });

  it("localOnly() tags function exports with local route metadata", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const fn = tasks.query({
      args: {},
      handler: async () => [],
    });

    const wrapped = localOnly(fn);

    expect(readRoute(wrapped)).toEqual({
      __brand: "convex-embedded:route",
      mode: "local",
    });
  });

  it("remoteOnly() rejects non-function values", () => {
    expect(() => remoteOnly("bad-input")).toThrow(
      /expects a Convex function export/,
    );
  });

  it("preserves the embedded table handle through chained indexes", () => {
    const tasks = asHandle(
      embeddedTable(uniqueTable(), {
        projectId: v.id("projects"),
        title: registerField(v.string()),
        body: prose(),
      })
        .index("by_projectId", ["projectId"])
        .index("by_projectId_and_title", ["projectId", "title"]),
    );

    expect(tasks.table).toBeDefined();
    expect(typeof tasks.query).toBe("function");
    expect(typeof tasks.mutation).toBe("function");
  });

  it("builds typed field refs from the table handle", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    expect(tasks.field("doc-1", "title")).toEqual({
      table: tasks.table,
      id: "doc-1",
      field: "title",
    });
  });
});

describe("bindTableRuntime()", () => {
  it("is a void function (side-effect only)", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });

    const result = bindTableRuntime(tasks);

    expect(result).toBeUndefined();
  });

  it("accepts component bindings", () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });

    expect(() => bindRuntime(tasks, component)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mutation() — inline delta recording
// ---------------------------------------------------------------------------

describe("mutation()", () => {
  it("returns a registered Convex mutation", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn = asFn(
      tasks.mutation({
        args: { title: v.string() },
        handler: async (_ctx, args) => `id:${args.title}`,
      }),
    );

    expect(fn.isMutation).toBe(true);
    expect(fn.isPublic).toBe(true);
  });

  it("runs the handler and returns its result on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn = asFn(
      tasks.mutation({
        args: { title: v.string() },
        handler: async (_ctx, args) => `id:${args.title}`,
      }),
    );

    const result = await fn._handler({}, { title: "hello" });

    expect(result).toBe("id:hello");
  });

  it("runs the handler then the remote block on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const callOrder: string[] = [];
    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => {
          callOrder.push("handler");
          return "doc123";
        },
        remote: async () => {
          callOrder.push("remote");
        },
      }),
    );

    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation: vi.fn(),
      db: { get: vi.fn().mockResolvedValue({ _id: "doc123", title: "t" }) },
    };

    const result = await fn._handler(ctx, {});

    expect(callOrder).toEqual(["handler", "remote"]);
    expect(result).toBe("doc123");
  });

  it("does not cache a local runtime decision across later remote contexts", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const remoteBlock = vi.fn(async () => undefined);
    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => "doc123",
        remote: remoteBlock,
      }),
    );

    const localCtx = {
      runQuery: vi.fn().mockRejectedValue(new Error("component unavailable")),
      runMutation: vi.fn(),
      db: { get: vi.fn().mockResolvedValue({ _id: "doc123", title: "t" }) },
    };
    const remoteCtx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation: vi.fn(),
      db: { get: vi.fn().mockResolvedValue({ _id: "doc123", title: "t" }) },
    };

    await fn._handler(localCtx, {});
    expect(remoteBlock).not.toHaveBeenCalled();

    await fn._handler(remoteCtx, {});
    expect(remoteBlock).toHaveBeenCalledOnce();
  });

  it("records a delta inline (same transaction) on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation,
      db: {
        get: vi.fn().mockResolvedValue({
          _id: "doc123",
          title: "Hello",
          body: "World",
        }),
      },
    };

    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => "doc123",
      }),
    );

    await fn._handler(ctx, {});

    expect(runMutation).toHaveBeenCalledWith(
      component.public.recordUpdate,
      expect.objectContaining({
        collection: tasks.table,
        docId: "doc123",
      }),
    );
  });

  it("does not record a delta on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const scheduler = { runAfter: vi.fn() };
    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => "result",
      }),
    );

    await fn._handler({ scheduler }, {});

    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("extracts docId from args.id when the result is not a string", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation,
      db: {
        get: vi.fn().mockResolvedValue({ _id: "fromArgs", title: "t" }),
      },
    };

    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => undefined,
      }),
    );

    await fn._handler(ctx, { id: "fromArgs" });

    expect(runMutation).toHaveBeenCalledWith(
      component.public.recordUpdate,
      expect.objectContaining({ docId: "fromArgs" }),
    );
  });

  it("does not throw on delta recording failure", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation: vi.fn().mockRejectedValue(new Error("write failed")),
      db: {
        get: vi.fn().mockResolvedValue({ _id: "doc1", title: "t" }),
      },
    };

    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => "doc1",
      }),
    );

    const result = await fn._handler(ctx, {});

    expect(result).toBe("doc1");
  });

  it("exposes exportArgs and exportReturns", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn = asFn(
      tasks.mutation({
        args: { title: v.string() },
        returns: v.null(),
        handler: async () => null,
      }),
    );

    expect(typeof fn.exportArgs).toBe("function");
    expect(typeof fn.exportReturns).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("query()", () => {
  it("returns a registered Convex query", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn = asFn(
      tasks.query({
        args: {},
        handler: async () => [],
      }),
    );

    expect(fn.isQuery).toBe(true);
    expect(fn.isPublic).toBe(true);
  });

  it("runs the handler only on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const handler = vi.fn().mockResolvedValue([1, 2, 3]);
    const remote = vi.fn();

    const fn = asFn(tasks.query({ args: {}, handler, remote }));

    const result = await fn._handler({}, {});

    expect(handler).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
    expect(result).toEqual([1, 2, 3]);
  });

  it("runs the handler then the remote block on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const handler = vi.fn().mockResolvedValue([{ id: 1 }]);
    const remote = vi.fn(
      async (_ctx: object, _args: object, result: Array<{ id: number }>) =>
        result.map((r) => ({ ...r, extra: true })),
    );

    const fn = asFn(tasks.query({ args: {}, handler, remote }));

    const ctx = { runQuery: vi.fn().mockResolvedValue([]) };
    const result = await fn._handler(ctx, {});

    expect(result).toEqual([{ id: 1, extra: true }]);
  });

  it("exposes exportArgs and exportReturns", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn = asFn(
      tasks.query({
        args: {},
        returns: v.array(v.string()),
        handler: async () => [],
      }),
    );

    expect(typeof fn.exportArgs).toBe("function");
    expect(typeof fn.exportReturns).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// resolve handler
// ---------------------------------------------------------------------------

describe("resolve handler", () => {
  it("is a registered Convex query", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const resolve = asResolveFn(tasks.resolve);
    expect(resolve.isQuery).toBe(true);
    expect(resolve.isPublic).toBe(true);
  });

  it("returns empty diffs on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const result = await asResolveFn(tasks.resolve)._handler(
      {},
      {
        collectionSeq: null,
        documents: [
          { docId: "a", vector: new ArrayBuffer(0), lastSeq: null },
          { docId: "b", vector: new ArrayBuffer(0), lastSeq: null },
        ],
      },
    );

    expect(result.mode).toBe("incremental");
    expect(result.documents).toHaveLength(2);
    expect(result.documents[0].docId).toBe("a");
    expect(result.documents[0].diff).toBeUndefined();
  });

  it("computes diffs from component deltas on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Server title", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const runQuery = vi.fn((ref: MockRef, args: { docIds?: string[] }) => {
      if (ref._name === "getCollectionChanges") {
        return Promise.resolve({
          mode: "incremental",
          collectionSeq: 1,
          changes: [{ docId: "doc1", kind: "upsert" }],
        });
      }
      if (ref._name === "getLiveStates" && Array.isArray(args.docIds)) {
        return Promise.resolve(
          args.docIds.map((docId) => ({
            docId,
            update: serverUpdate.buffer,
            seq: 1,
          })),
        );
      }
      if (ref._name === "getLiveState") {
        return Promise.resolve({ update: serverUpdate.buffer, seq: 1 });
      }
      return Promise.resolve(null);
    });

    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const result = await asResolveFn(tasks.resolve)._handler(
      { runQuery, db: { get: vi.fn() } },
      {
        collectionSeq: 0,
        documents: [
          { docId: "doc1", vector: toArrayBuffer(clientVector), lastSeq: 0 },
        ],
      },
    );

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].docId).toBe("doc1");
    expect(result.documents[0].diff).toBeDefined();
  });

  it("does not return remote-only docs for scoped resolves", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      owner: registerField(v.string()),
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Server title", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const ctx = {
      runQuery: vi.fn((ref: MockRef, args: { docIds?: string[] }) => {
        if (ref._name === "getCollectionChanges") {
          return Promise.resolve({
            mode: "full",
            collectionSeq: 5,
            changes: [],
          });
        }
        if (ref._name === "getLiveStates") {
          if (Array.isArray(args.docIds) && args.docIds.length === 0) {
            return Promise.resolve([]);
          }
          return Promise.resolve([
            { docId: "doc1", update: serverUpdate.buffer, seq: 1 },
            { docId: "doc2", update: serverUpdate.buffer, seq: 2 },
          ]);
        }
        if (ref._name === "getLiveStatesPage") {
          return Promise.resolve({
            page: [
              { docId: "doc1", update: serverUpdate.buffer, seq: 1 },
              { docId: "doc2", update: serverUpdate.buffer, seq: 2 },
            ],
            continueCursor: null,
            isDone: true,
          });
        }
        return Promise.resolve(null);
      }),
      db: {
        get: vi.fn((docId: string) => {
          if (docId === "doc1") {
            return Promise.resolve({
              _id: "doc1",
              _creationTime: 1,
              owner: "alice",
              title: "Server title",
              body: "Scoped",
            });
          }
          if (docId === "doc2") {
            return Promise.resolve({
              _id: "doc2",
              _creationTime: 2,
              owner: "bob",
              title: "Other owner",
              body: "Out of scope",
            });
          }
          return Promise.resolve(null);
        }),
      },
    };

    const result = await asResolveFn(tasks.resolve)._handler(ctx, {
      collectionSeq: 0,
      documents: [{ docId: "doc1", vector: new ArrayBuffer(0), lastSeq: 0 }],
      scopeArgs: { owner: "alice" },
    });

    expect(result.mode).toBe("full");
    const returnedIds = result.documents.map((d) => d.docId).sort();
    expect(returnedIds).toEqual(["doc1"]);
  });

  it("filters indexed scoped snapshots by the full scope args", async () => {
    const component = makeMockComponent();
    const tasks = asHandle(
      embeddedTable(uniqueTable(), {
        projectId: registerField(v.string()),
        status: registerField(v.string()),
        title: registerField(v.string()),
      }).index("by_projectId", ["projectId"]),
    );
    bindRuntime(tasks, component);

    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Scoped task", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const indexedCollect = vi
      .fn()
      .mockResolvedValue([{ _id: "doc-open" }, { _id: "doc-closed" }]);
    const eqChain = { eq: vi.fn().mockReturnThis() };
    const ctx = {
      runQuery: vi.fn((ref: MockRef, args: { docIds: string[] }) => {
        if (ref._name === "getCollectionChanges") {
          return Promise.resolve({
            mode: "full",
            collectionSeq: 9,
            changes: [],
          });
        }
        if (ref._name === "getLiveStates") {
          if (Array.isArray(args.docIds) && args.docIds.length === 0) {
            return Promise.resolve([]);
          }
          expect(args.docIds.sort()).toEqual(["doc-closed", "doc-open"]);
          return Promise.resolve(
            args.docIds.map((docId) => ({
              docId,
              update: serverUpdate.buffer,
              seq: docId === "doc-open" ? 1 : 2,
            })),
          );
        }
        return Promise.resolve(null);
      }),
      db: {
        query: vi.fn(() => ({
          withIndex: vi.fn(
            (indexName: string, chain: (q: typeof eqChain) => unknown) => {
              expect(indexName).toBe("by_projectId");
              chain(eqChain);
              expect(eqChain.eq).toHaveBeenCalledWith("projectId", "p1");
              return {
                collect: indexedCollect,
                paginate: vi.fn(
                  async (opts: { cursor?: string; numItems?: number }) => {
                    const all = await indexedCollect();
                    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
                    const end = start + (opts.numItems ?? all.length);
                    return {
                      page: all.slice(start, end),
                      isDone: end >= all.length,
                      continueCursor: end < all.length ? String(end) : null,
                    };
                  },
                ),
              };
            },
          ),
        })),
        get: vi.fn((docId: string) => {
          if (docId === "doc-open") {
            return Promise.resolve({
              _id: "doc-open",
              _creationTime: 1,
              projectId: "p1",
              status: "open",
              title: "Open task",
            });
          }
          if (docId === "doc-closed") {
            return Promise.resolve({
              _id: "doc-closed",
              _creationTime: 2,
              projectId: "p1",
              status: "closed",
              title: "Closed task",
            });
          }
          return Promise.resolve(null);
        }),
      },
    };

    const result = await asResolveFn(tasks.resolve)._handler(ctx, {
      collectionSeq: 0,
      documents: [],
      scopeArgs: { projectId: "p1", status: "open" },
    });

    expect(result.mode).toBe("full");
    expect(result.documents.map((d) => d.docId)).toEqual(["doc-open"]);
    expect(indexedCollect).toHaveBeenCalledTimes(1);
  });

  it("resolves scoped first-time subscriptions via a declared index", async () => {
    const component = makeMockComponent();
    const tasks = asHandle(
      embeddedTable(uniqueTable(), {
        owner: registerField(v.string()),
        title: registerField(v.string()),
      }).index("by_owner", ["owner"]),
    );
    bindRuntime(tasks, component);

    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Alice's task", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const indexedCollect = vi
      .fn()
      .mockResolvedValue([{ _id: "doc-alice-1" }, { _id: "doc-alice-2" }]);
    const eqChain = { eq: vi.fn().mockReturnThis() };
    const ctx = {
      runQuery: vi.fn((ref: MockRef, args: { docIds: string[] }) => {
        if (ref._name === "getCollectionChanges") {
          return Promise.resolve({
            mode: "full",
            collectionSeq: 7,
            changes: [],
          });
        }
        if (ref._name === "getLiveStates") {
          if (args.docIds.length === 0) {
            // detectRuntime probe
            return Promise.resolve([]);
          }
          // Should ask for exactly the doc IDs returned by the indexed read.
          expect(args.docIds.sort()).toEqual(["doc-alice-1", "doc-alice-2"]);
          return Promise.resolve(
            args.docIds.map((docId) => ({
              docId,
              update: serverUpdate.buffer,
              seq: 1,
            })),
          );
        }
        return Promise.resolve(null);
      }),
      db: {
        query: vi.fn(() => ({
          withIndex: vi.fn(
            (indexName: string, chain: (q: typeof eqChain) => unknown) => {
              expect(indexName).toBe("by_owner");
              chain(eqChain);
              expect(eqChain.eq).toHaveBeenCalledWith("owner", "alice");
              return {
                collect: indexedCollect,
                paginate: vi.fn(
                  async (opts: { cursor?: string; numItems?: number }) => {
                    const all = await indexedCollect();
                    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
                    const end = start + (opts.numItems ?? all.length);
                    return {
                      page: all.slice(start, end),
                      isDone: end >= all.length,
                      continueCursor: end < all.length ? String(end) : null,
                    };
                  },
                ),
              };
            },
          ),
        })),
        get: vi.fn((docId: string) => {
          if (docId === "doc-alice-1") {
            return Promise.resolve({
              _id: "doc-alice-1",
              _creationTime: 1,
              owner: "alice",
              title: "Alice's first task",
            });
          }
          if (docId === "doc-alice-2") {
            return Promise.resolve({
              _id: "doc-alice-2",
              _creationTime: 2,
              owner: "alice",
              title: "Alice's second task",
            });
          }
          return Promise.resolve(null);
        }),
      },
    };

    const result = await asResolveFn(tasks.resolve)._handler(ctx, {
      collectionSeq: 0,
      documents: [],
      scopeArgs: { owner: "alice" },
    });

    expect(result.mode).toBe("full");
    const returnedIds = result.documents.map((d) => d.docId).sort();
    expect(returnedIds).toEqual(["doc-alice-1", "doc-alice-2"]);
    expect(indexedCollect).toHaveBeenCalledTimes(1);
  });

  it("recomputes indexed scoped snapshots even when the client sends known doc ids", async () => {
    const component = makeMockComponent();
    const tasks = asHandle(
      embeddedTable(uniqueTable(), {
        owner: registerField(v.string()),
        title: registerField(v.string()),
      }).index("by_owner", ["owner"]),
    );
    bindRuntime(tasks, component);

    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Alice's task", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const indexedCollect = vi
      .fn()
      .mockResolvedValue([{ _id: "doc-alice-1" }, { _id: "doc-alice-2" }]);
    const eqChain = { eq: vi.fn().mockReturnThis() };
    const ctx = {
      runQuery: vi.fn((ref: MockRef, args: { docIds: string[] }) => {
        if (ref._name === "getCollectionChanges") {
          return Promise.resolve({
            mode: "full",
            collectionSeq: 8,
            changes: [],
          });
        }
        if (ref._name === "getLiveStates") {
          if (args.docIds.length === 0) {
            return Promise.resolve([]);
          }
          expect(args.docIds.sort()).toEqual(["doc-alice-1", "doc-alice-2"]);
          return Promise.resolve(
            args.docIds.map((docId) => ({
              docId,
              update: serverUpdate.buffer,
              seq: 1,
            })),
          );
        }
        return Promise.resolve(null);
      }),
      db: {
        query: vi.fn(() => ({
          withIndex: vi.fn(
            (_indexName: string, chain: (q: typeof eqChain) => unknown) => {
              chain(eqChain);
              return {
                collect: indexedCollect,
                paginate: vi.fn(
                  async (opts: { cursor?: string; numItems?: number }) => {
                    const all = await indexedCollect();
                    const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
                    const end = start + (opts.numItems ?? all.length);
                    return {
                      page: all.slice(start, end),
                      isDone: end >= all.length,
                      continueCursor: end < all.length ? String(end) : null,
                    };
                  },
                ),
              };
            },
          ),
        })),
        get: vi.fn((docId: string) => {
          if (docId === "doc-alice-1") {
            return Promise.resolve({
              _id: "doc-alice-1",
              _creationTime: 1,
              owner: "alice",
              title: "Alice's first task",
            });
          }
          if (docId === "doc-alice-2") {
            return Promise.resolve({
              _id: "doc-alice-2",
              _creationTime: 2,
              owner: "alice",
              title: "Alice's second task",
            });
          }
          return Promise.resolve(null);
        }),
      },
    };

    const result = await asResolveFn(tasks.resolve)._handler(ctx, {
      collectionSeq: 7,
      documents: [
        { docId: "doc-alice-1", vector: new ArrayBuffer(0), lastSeq: 1 },
      ],
      scopeArgs: { owner: "alice" },
    });

    expect(result.mode).toBe("full");
    const returnedIds = result.documents.map((d) => d.docId).sort();
    expect(returnedIds).toEqual(["doc-alice-1", "doc-alice-2"]);
  });

  it("returns deleted for scoped incremental docs that no longer match the scope", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      owner: registerField(v.string()),
      title: registerField(v.string()),
    });
    bindRuntime(tasks, component);

    const ctx = {
      runQuery: vi.fn((ref: MockRef, args: { docIds?: string[] }) => {
        if (ref._name === "getCollectionChanges") {
          return Promise.resolve({
            mode: "incremental",
            collectionSeq: 2,
            changes: [{ docId: "doc1", kind: "upsert" }],
          });
        }
        if (ref._name === "getLiveStates" && Array.isArray(args.docIds)) {
          return Promise.resolve(
            args.docIds.map((docId) => ({
              docId,
              update: new ArrayBuffer(0),
              seq: 2,
            })),
          );
        }
        if (ref._name === "getLiveState") {
          return Promise.resolve({ update: new ArrayBuffer(0), seq: 2 });
        }
        return Promise.resolve(null);
      }),
      db: {
        get: vi.fn().mockResolvedValue({
          _id: "doc1",
          _creationTime: 1,
          owner: "bob",
          title: "Moved",
        }),
      },
    };

    const result = await asResolveFn(tasks.resolve)._handler(ctx, {
      collectionSeq: 1,
      documents: [{ docId: "doc1", vector: new ArrayBuffer(0), lastSeq: 1 }],
      scopeArgs: { owner: "alice" },
    });

    expect(result.documents).toEqual([
      { docId: "doc1", deleted: true, seq: null },
    ]);
  });

  it("rethrows non-component runtime detection failures", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const fn = asFn(
      tasks.mutation({
        args: {},
        handler: async () => "doc123",
        remote: vi.fn(async () => undefined),
      }),
    );

    const remoteCtx = {
      runQuery: vi.fn().mockRejectedValue(new Error("permission denied")),
      runMutation: vi.fn(),
      db: { get: vi.fn().mockResolvedValue({ _id: "doc123", title: "t" }) },
    };

    await expect(fn._handler(remoteCtx, {})).rejects.toThrow(
      "permission denied",
    );
  });

  it("returns no diff when the client is up to date", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("data", "value");
    const fullUpdate = Y.encodeStateAsUpdateV2(doc);
    const stateVector = Y.encodeStateVector(doc);

    const runQuery = vi.fn((ref: MockRef, args: { docIds?: string[] }) => {
      if (ref._name === "getCollectionChanges") {
        return Promise.resolve({
          mode: "incremental",
          collectionSeq: 1,
          changes: [{ docId: "doc1", kind: "upsert" }],
        });
      }
      if (ref._name === "getLiveStates" && Array.isArray(args.docIds)) {
        return Promise.resolve(
          args.docIds.map((docId) => ({
            docId,
            update: fullUpdate.buffer,
            seq: 1,
          })),
        );
      }
      if (ref._name === "getLiveState") {
        return Promise.resolve({ update: fullUpdate.buffer, seq: 1 });
      }
      return Promise.resolve(null);
    });

    const result = await asResolveFn(tasks.resolve)._handler(
      { runQuery, db: { get: vi.fn() } },
      {
        collectionSeq: 0,
        documents: [
          { docId: "doc1", vector: toArrayBuffer(stateVector), lastSeq: 0 },
        ],
      },
    );

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].diff).toBeUndefined();
  });

  it("handles missing deltas gracefully", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const runQuery = vi.fn((ref: MockRef, args: { docIds?: string[] }) => {
      if (ref._name === "getCollectionChanges") {
        return Promise.resolve({
          mode: "incremental",
          collectionSeq: 1,
          changes: [{ docId: "missing", kind: "upsert" }],
        });
      }
      if (ref._name === "getLiveStates" && Array.isArray(args.docIds)) {
        return Promise.resolve(args.docIds.map(() => null));
      }
      if (ref._name === "getLiveState") {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    const result = await asResolveFn(tasks.resolve)._handler(
      { runQuery, db: { get: vi.fn() } },
      {
        collectionSeq: 0,
        documents: [
          { docId: "missing", vector: new ArrayBuffer(0), lastSeq: 0 },
        ],
      },
    );

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].deleted).toBe(true);
  });
});
