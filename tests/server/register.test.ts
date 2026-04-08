import { register as registerField, prose } from "@resolve/server/schema";
import {
  bindTableRuntime,
  embeddedTable,
  localOnly,
  remoteOnly,
  _resetRegistry,
  RESOLVE_QUERY_META,
  REMOTE_META,
} from "@resolve/server/setup";
import { v } from "convex/values";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique table name per test to avoid registry collisions. */
let _counter = 0;
function uniqueTable(): string {
  return `test_table_${++_counter}`;
}

function makeMockComponent() {
  return {
    public: {
      recordUpdate: { _name: "recordUpdate" } as any,
      getLiveState: { _name: "getLiveState" } as any,
      getLiveStates: { _name: "getLiveStates" } as any,
      createCheckpoint: { _name: "createCheckpoint" } as any,
      listCheckpoints: { _name: "listCheckpoints" } as any,
      getCheckpoint: { _name: "getCheckpoint" } as any,
      cleanupDoc: { _name: "cleanupDoc" } as any,
    },
  };
}

function bindRuntime(table: any, component?: any) {
  bindTableRuntime(table, component);
}

beforeEach(() => {
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// embeddedTable() + runtime binding
// ---------------------------------------------------------------------------

describe("embeddedTable()", () => {
  it("returns a handle with resolve, mutation, and query", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    expect(tasks).toHaveProperty("resolve");
    expect(typeof tasks.mutation).toBe("function");
    expect(typeof tasks.query).toBe("function");
  });

  it("resolve exports args via exportArgs", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    expect(typeof tasks.resolve.exportArgs).toBe("function");
    // exportArgs() returns a JSON string describing the validator shape.
    const argsJson = JSON.parse(tasks.resolve.exportArgs());
    expect(argsJson).toBeDefined();
  });

  it("tags resolve with REMOTE_META symbol", () => {
    const name = uniqueTable();
    const tasks: any = embeddedTable(name, {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const meta = tasks.resolve[REMOTE_META];
    expect(meta).toBeDefined();
    expect(meta.__brand).toBe("convex-embedded:remoteMeta");
    expect(meta.table).toBe(name);
    expect(meta.resolveExport).toBe("resolve");
  });

  it("REMOTE_META is accessible via Symbol.for (cross-package)", () => {
    const name = uniqueTable();
    const tasks: any = embeddedTable(name, {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const crossPkgSymbol = Symbol.for("convex-embedded:remoteMeta");
    const meta = tasks.resolve[crossPkgSymbol];
    expect(meta).toBeDefined();
    expect(meta.table).toBe(name);
  });

  it("REMOTE_META is not enumerable", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });

    expect(Object.keys(tasks.resolve)).not.toContain(REMOTE_META.toString());
    const keys = [];
    for (const k in tasks.resolve) keys.push(k);
    expect(keys).not.toContain(REMOTE_META.toString());
  });

  it("remoteOnly() tags function exports with route metadata", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn: any = tasks.query({
      args: {},
      handler: async () => [],
    });

    const wrapped = remoteOnly(fn);

    expect(wrapped).toBe(fn);
    expect(wrapped[Symbol.for("convex-embedded:route")]).toEqual({
      __brand: "convex-embedded:route",
      mode: "remote",
    });
  });

  it("localOnly() tags function exports with local route metadata", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const fn: any = tasks.query({
      args: {},
      handler: async () => [],
    });

    const wrapped = localOnly(fn);

    expect(wrapped[Symbol.for("convex-embedded:route")]).toEqual({
      __brand: "convex-embedded:route",
      mode: "local",
    });
  });

  it("remoteOnly() rejects non-function values", () => {
    expect(() => remoteOnly("bad-input" as any)).toThrow(
      /expects a Convex function export/,
    );
  });

  it("query() tags scoped resolve queries with RESOLVE_QUERY_META", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });
    bindRuntime(tasks);

    const listMine = tasks.query({
      args: { owner: v.string() },
      resolve: { args: () => ({ owner: "alice" }) },
      handler: async () => [],
    });

    expect(listMine[RESOLVE_QUERY_META]).toEqual({
      __brand: "convex-embedded:resolveQueryMeta",
      table: tasks.table,
      getArgs: expect.any(Function),
    });
    expect(listMine[RESOLVE_QUERY_META].getArgs()).toEqual({ owner: "alice" });
  });

  it("preserves the embedded table handle through chained indexes", () => {
    const tasks = embeddedTable(uniqueTable(), {
      projectId: v.id("projects"),
      title: registerField(v.string()),
      body: prose(),
    })
      .index("by_projectId", ["projectId"])
      .index("by_projectId_and_title", ["projectId", "title"]);

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
    expect(() => bindTableRuntime(tasks, component as any)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mutation() — inline delta recording
// ---------------------------------------------------------------------------

describe("mutation()", () => {
  it("returns a registered Convex mutation", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn: any = tasks.mutation({
      args: { title: v.string() },
      handler: async (_ctx: any, args: any) => `id:${args.title}`,
    });

    expect(fn.isMutation).toBe(true);
    expect(fn.isPublic).toBe(true);
  });

  it("runs handler and returns result on local (no component)", async () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn: any = tasks.mutation({
      args: { title: v.string() },
      handler: async (_ctx: any, args: any) => `id:${args.title}`,
    });

    const result = await fn._handler({}, { title: "hello" });
    expect(result).toBe("id:hello");
  });

  it("runs handler then remote: block on remote", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const callOrder: string[] = [];
    const fn: any = tasks.mutation({
      args: {},
      handler: async () => {
        callOrder.push("handler");
        return "doc123";
      },
      remote: async () => {
        callOrder.push("remote");
      },
    });

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
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const remoteBlock = vi.fn(async () => {});
    const fn: any = tasks.mutation({
      args: {},
      handler: async () => "doc123",
      remote: remoteBlock,
    });

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

  it("records delta inline (same transaction) on remote", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
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

    const fn: any = tasks.mutation({
      args: {},
      handler: async () => "doc123",
    });

    await fn._handler(ctx, {});

    expect(runMutation).toHaveBeenCalledWith(
      component.public.recordUpdate,
      expect.objectContaining({
        collection: tasks.table,
        docId: "doc123",
      }),
    );
  });

  it("does not record delta on local (no component)", async () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const scheduler = { runAfter: vi.fn() };
    const fn: any = tasks.mutation({
      args: {},
      handler: async () => "result",
    });

    await fn._handler({ scheduler }, {});

    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("extracts docId from args.id when result is not a string", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
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

    const fn: any = tasks.mutation({
      args: {},
      handler: async () => undefined,
    });

    await fn._handler(ctx, { id: "fromArgs" });

    expect(runMutation).toHaveBeenCalledWith(
      component.public.recordUpdate,
      expect.objectContaining({ docId: "fromArgs" }),
    );
  });

  it("does not throw on delta recording failure", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
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

    const fn: any = tasks.mutation({
      args: {},
      handler: async () => "doc1",
    });

    const result = await fn._handler(ctx, {});
    expect(result).toBe("doc1");
  });

  it("exports args via exportArgs", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn: any = tasks.mutation({
      args: { title: v.string() },
      returns: v.null(),
      handler: async () => null,
    });

    expect(typeof fn.exportArgs).toBe("function");
    expect(typeof fn.exportReturns).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("query()", () => {
  it("returns a registered Convex query", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn: any = tasks.query({
      args: {},
      handler: async () => [],
    });

    expect(fn.isQuery).toBe(true);
    expect(fn.isPublic).toBe(true);
  });

  it("runs handler only on local (no component)", async () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const handler = vi.fn().mockResolvedValue([1, 2, 3]);
    const remote = vi.fn();

    const fn: any = tasks.query({ args: {}, handler, remote });

    const result = await fn._handler({}, {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
    expect(result).toEqual([1, 2, 3]);
  });

  it("runs handler then remote: on remote", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const handler = vi.fn().mockResolvedValue([{ id: 1 }]);
    const remote = vi.fn(async (_ctx: any, _args: any, result: any) =>
      result.map((r: any) => ({ ...r, extra: true })),
    );

    const fn: any = tasks.query({ args: {}, handler, remote });

    const ctx = { runQuery: vi.fn().mockResolvedValue([]) };
    const result = await fn._handler(ctx, {});

    expect(result).toEqual([{ id: 1, extra: true }]);
  });

  it("exports args via exportArgs", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const fn: any = tasks.query({
      args: {},
      returns: v.array(v.string()),
      handler: async () => [],
    });

    expect(typeof fn.exportArgs).toBe("function");
    expect(typeof fn.exportReturns).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// resolve handler
// ---------------------------------------------------------------------------

describe("resolve handler", () => {
  it("is a registered Convex query", () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    expect(tasks.resolve.isQuery).toBe(true);
    expect(tasks.resolve.isPublic).toBe(true);
  });

  it("returns empty diffs on local (no component)", async () => {
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks);

    const result = await tasks.resolve._handler(
      {},
      {
        documents: [
          { docId: "a", vector: new ArrayBuffer(0) },
          { docId: "b", vector: new ArrayBuffer(0) },
        ],
      },
    );

    expect(result).toHaveLength(2);
    expect(result[0].docId).toBe("a");
    expect(result[0].diff).toBeUndefined();
  });

  it("computes diffs from component deltas on remote", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
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

    const runQuery = vi
      .fn()
      .mockResolvedValue([{ update: serverUpdate.buffer, seq: 0 }]);

    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const result = await tasks.resolve._handler(
      { runQuery },
      {
        documents: [{ docId: "doc1", vector: clientVector.buffer }],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe("doc1");
    expect(result[0].diff).toBeDefined();
  });

  it("does not return remote-only docs for scoped resolves", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
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
      runQuery: vi.fn().mockResolvedValue([
        { docId: "doc1", update: serverUpdate.buffer, seq: 0 },
        { docId: "doc2", update: serverUpdate.buffer, seq: 1 },
      ]),
      db: {
        get: vi.fn().mockResolvedValue({
          _id: "doc2",
          _creationTime: 1,
          title: "Extra",
          body: "Remote-only",
        }),
      },
    };

    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const result = await tasks.resolve._handler(ctx, {
      documents: [{ docId: "doc1", vector: clientVector.buffer }],
      scopeArgs: { owner: "alice" },
    });

    expect(result).toEqual([
      expect.objectContaining({ docId: "doc1", diff: expect.any(ArrayBuffer) }),
    ]);
  });

  it("rethrows non-component runtime detection failures", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const fn: any = tasks.mutation({
      args: {},
      handler: async () => "doc123",
      remote: vi.fn(async () => {}),
    });

    const remoteCtx = {
      runQuery: vi.fn().mockRejectedValue(new Error("permission denied")),
      runMutation: vi.fn(),
      db: { get: vi.fn().mockResolvedValue({ _id: "doc123", title: "t" }) },
    };

    await expect(fn._handler(remoteCtx, {})).rejects.toThrow(
      "permission denied",
    );
  });

  it("returns no diff when client is up to date", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("data", "value");
    const fullUpdate = Y.encodeStateAsUpdateV2(doc);
    const stateVector = Y.encodeStateVector(doc);

    const runQuery = vi
      .fn()
      .mockResolvedValue([{ update: fullUpdate.buffer, seq: 0 }]);

    const result = await tasks.resolve._handler(
      { runQuery },
      {
        documents: [{ docId: "doc1", vector: stateVector.buffer }],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].diff).toBeUndefined();
  });

  it("handles missing deltas gracefully", async () => {
    const component = makeMockComponent();
    const tasks: any = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    bindRuntime(tasks, component);

    const runQuery = vi.fn().mockResolvedValue([null]);

    const result = await tasks.resolve._handler(
      { runQuery },
      {
        documents: [{ docId: "missing", vector: new ArrayBuffer(0) }],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].diff).toBeUndefined();
  });
});
