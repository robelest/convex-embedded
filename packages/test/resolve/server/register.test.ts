import { register as registerField, prose } from "@resolve/server/schema";
import {
  embeddedTable,
  remoteOnly,
  setup,
  _resetRegistry,
  SYNC_META,
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
      insertDelta: { _name: "insertDelta" } as any,
      getLatestDelta: { _name: "getLatestDelta" } as any,
      getLatestDeltas: { _name: "getLatestDeltas" } as any,
      cleanup: { _name: "cleanup" } as any,
    },
  };
}

beforeEach(() => {
  _resetRegistry();
});

// ---------------------------------------------------------------------------
// embeddedTable() + setup()
// ---------------------------------------------------------------------------

describe("embeddedTable()", () => {
  it("returns a handle with resolve, mutation, and query", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    expect(tasks).toHaveProperty("resolve");
    expect(typeof tasks.mutation).toBe("function");
    expect(typeof tasks.query).toBe("function");
  });

  it("resolve exports args via exportArgs", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });

    expect(typeof tasks.resolve.exportArgs).toBe("function");
    // exportArgs() returns a JSON string describing the validator shape.
    const argsJson = JSON.parse(tasks.resolve.exportArgs());
    expect(argsJson).toBeDefined();
  });

  it("tags resolve with SYNC_META symbol", () => {
    const name = uniqueTable();
    const tasks = embeddedTable(name, {
      title: registerField(v.string()),
    });

    const meta = tasks.resolve[SYNC_META];
    expect(meta).toBeDefined();
    expect(meta.__brand).toBe("convex-resolve:syncMeta");
    expect(meta.table).toBe(name);
    expect(meta.resolveExport).toBe("resolve");
  });

  it("SYNC_META is accessible via Symbol.for (cross-package)", () => {
    const name = uniqueTable();
    const tasks = embeddedTable(name, {
      title: registerField(v.string()),
    });

    const crossPkgSymbol = Symbol.for("convex-resolve:syncMeta");
    const meta = tasks.resolve[crossPkgSymbol];
    expect(meta).toBeDefined();
    expect(meta.table).toBe(name);
  });

  it("SYNC_META is not enumerable", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
    });

    expect(Object.keys(tasks.resolve)).not.toContain(SYNC_META.toString());
    const keys = [];
    for (const k in tasks.resolve) keys.push(k);
    expect(keys).not.toContain(SYNC_META.toString());
  });

  it("remoteOnly() tags function exports with a symbol", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const fn = tasks.query({
      args: {},
      handler: async () => [],
    });

    const wrapped = remoteOnly(fn);
    const symbol = Symbol.for("convex-embedded:remoteOnly");

    expect(wrapped).toBe(fn);
    expect(wrapped[symbol]).toEqual({ __brand: "convex-embedded:remoteOnly" });
  });

  it("remoteOnly() rejects non-function values", () => {
    expect(() => remoteOnly("bad-input" as any)).toThrow(
      /expects a Convex function export/,
    );
  });
});

describe("setup()", () => {
  it("is a void function (side-effect only)", () => {
    embeddedTable(uniqueTable(), { title: registerField(v.string()) });
    const result = setup({});
    expect(result).toBeUndefined();
  });

  it("accepts component-only config", () => {
    const component = makeMockComponent();
    embeddedTable(uniqueTable(), { title: registerField(v.string()) });
    expect(() => setup({ component })).not.toThrow();
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

    const fn = tasks.mutation({
      args: { title: v.string() },
      handler: async (_ctx: any, args: any) => `id:${args.title}`,
    });

    expect(fn.isMutation).toBe(true);
    expect(fn.isPublic).toBe(true);
  });

  it("runs handler and returns result on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const fn = tasks.mutation({
      args: { title: v.string() },
      handler: async (_ctx: any, args: any) => `id:${args.title}`,
    });

    const result = await fn._handler({}, { title: "hello" });
    expect(result).toBe("id:hello");
  });

  it("runs handler then remote: block on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

    const callOrder: string[] = [];
    const fn = tasks.mutation({
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

  it("records delta inline (same transaction) on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

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

    const fn = tasks.mutation({
      args: {},
      handler: async () => "doc123",
    });

    await fn._handler(ctx, {});

    expect(runMutation).toHaveBeenCalledWith(
      component.public.insertDelta,
      expect.objectContaining({
        collection: tasks.table,
        docId: "doc123",
      }),
    );
  });

  it("does not record delta on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const scheduler = { runAfter: vi.fn() };
    const fn = tasks.mutation({
      args: {},
      handler: async () => "result",
    });

    await fn._handler({ scheduler }, {});

    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("extracts docId from args.id when result is not a string", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation,
      db: {
        get: vi.fn().mockResolvedValue({ _id: "fromArgs", title: "t" }),
      },
    };

    const fn = tasks.mutation({
      args: {},
      handler: async () => undefined,
    });

    await fn._handler(ctx, { id: "fromArgs" });

    expect(runMutation).toHaveBeenCalledWith(
      component.public.insertDelta,
      expect.objectContaining({ docId: "fromArgs" }),
    );
  });

  it("does not throw on delta recording failure", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation: vi.fn().mockRejectedValue(new Error("write failed")),
      db: {
        get: vi.fn().mockResolvedValue({ _id: "doc1", title: "t" }),
      },
    };

    const fn = tasks.mutation({
      args: {},
      handler: async () => "doc1",
    });

    const result = await fn._handler(ctx, {});
    expect(result).toBe("doc1");
  });

  it("exports args via exportArgs", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const fn = tasks.mutation({
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
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const fn = tasks.query({
      args: {},
      handler: async () => [],
    });

    expect(fn.isQuery).toBe(true);
    expect(fn.isPublic).toBe(true);
  });

  it("runs handler only on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const handler = vi.fn().mockResolvedValue([1, 2, 3]);
    const remote = vi.fn();

    const fn = tasks.query({ args: {}, handler, remote });

    const result = await fn._handler({}, {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
    expect(result).toEqual([1, 2, 3]);
  });

  it("runs handler then remote: on remote", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

    const handler = vi.fn().mockResolvedValue([{ id: 1 }]);
    const remote = vi.fn(async (_ctx: any, _args: any, result: any) =>
      result.map((r: any) => ({ ...r, extra: true })),
    );

    const fn = tasks.query({ args: {}, handler, remote });

    const ctx = { runQuery: vi.fn().mockResolvedValue([]) };
    const result = await fn._handler(ctx, {});

    expect(result).toEqual([{ id: 1, extra: true }]);
  });

  it("exports args via exportArgs", () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    const fn = tasks.query({
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
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

    expect(tasks.resolve.isQuery).toBe(true);
    expect(tasks.resolve.isPublic).toBe(true);
  });

  it("returns empty diffs on local (no component)", async () => {
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });

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
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

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

  it("returns no diff when client is up to date", async () => {
    const component = makeMockComponent();
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

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
    const tasks = embeddedTable(uniqueTable(), {
      title: registerField(v.string()),
      body: prose(),
    });
    setup({ component });

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
