import { v } from "convex/values";
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import { setup, SYNC_META } from "#resolve/server/setup";
import {
  define,
  register as registerField,
  prose,
} from "#resolve/server/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSchema() {
  return define({
    version: 1,
    shape: {
      title: registerField(v.string()),
      body: prose(),
    },
  });
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

// ---------------------------------------------------------------------------
// setup() + register()
// ---------------------------------------------------------------------------

describe("setup()", () => {
  it("returns a register function", () => {
    const register = setup({});
    expect(typeof register).toBe("function");
  });
});

describe("register()", () => {
  it("returns a TableDescriptor with resolve, mutation, and query", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    expect(tasks).toHaveProperty("resolve");
    expect(typeof tasks.mutation).toBe("function");
    expect(typeof tasks.query).toBe("function");
  });

  it("resolve has properly typed args", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    expect(tasks.resolve.args).toHaveProperty("documents");
  });

  it("tags resolve with SYNC_META symbol", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const meta = tasks.resolve[SYNC_META];
    expect(meta).toBeDefined();
    expect(meta.__brand).toBe("convex-resolve:syncMeta");
    expect(meta.table).toBe("tasks");
    expect(meta.resolveExport).toBe("resolve");
  });

  it("SYNC_META is accessible via Symbol.for (cross-package)", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const crossPkgSymbol = Symbol.for("convex-resolve:syncMeta");
    const meta = tasks.resolve[crossPkgSymbol];
    expect(meta).toBeDefined();
    expect(meta.table).toBe("tasks");
  });

  it("SYNC_META is not enumerable", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    expect(Object.keys(tasks.resolve)).not.toContain(SYNC_META.toString());
    // Also verify it doesn't appear in for..in or JSON.stringify
    const keys = [];
    for (const k in tasks.resolve) keys.push(k);
    expect(keys).not.toContain(SYNC_META.toString());
  });
});

// ---------------------------------------------------------------------------
// mutation() — inline delta recording
// ---------------------------------------------------------------------------

describe("mutation()", () => {
  it("runs handler and returns result on local (no component)", async () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const fn = tasks.mutation({
      args: { title: v.string() },
      handler: async (_ctx: any, args: any) => `id:${args.title}`,
    });

    const result = await fn.handler({}, { title: "hello" });
    expect(result).toBe("id:hello");
  });

  it("runs handler then remote: block on remote", async () => {
    const component = makeMockComponent();
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

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

    // Mock ctx with runQuery that succeeds (signals remote runtime)
    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation: vi.fn(),
      db: { get: vi.fn().mockResolvedValue({ _id: "doc123", title: "t" }) },
    };

    const result = await fn.handler(ctx, {});

    expect(callOrder).toEqual(["handler", "remote"]);
    expect(result).toBe("doc123");
  });

  it("records delta inline (same transaction) on remote", async () => {
    const component = makeMockComponent();
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

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

    await fn.handler(ctx, {});

    // Should have called insertDelta directly (no scheduler.runAfter)
    expect(runMutation).toHaveBeenCalledWith(
      component.public.insertDelta,
      expect.objectContaining({
        collection: "tasks",
        docId: "doc123",
      }),
    );
  });

  it("does not record delta on local (no component)", async () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const scheduler = { runAfter: vi.fn() };
    const fn = tasks.mutation({
      args: {},
      handler: async () => "result",
    });

    await fn.handler({ scheduler }, {});

    // No scheduler calls — delta recording is inline and only on remote
    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("extracts docId from args.id when result is not a string", async () => {
    const component = makeMockComponent();
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi.fn().mockResolvedValue([]),
      runMutation,
      db: {
        get: vi
          .fn()
          .mockResolvedValue({ _id: "fromArgs", title: "t" }),
      },
    };

    const fn = tasks.mutation({
      args: {},
      handler: async () => undefined, // no string result
    });

    await fn.handler(ctx, { id: "fromArgs" });

    expect(runMutation).toHaveBeenCalledWith(
      component.public.insertDelta,
      expect.objectContaining({ docId: "fromArgs" }),
    );
  });

  it("does not throw on delta recording failure", async () => {
    const component = makeMockComponent();
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

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

    // Should not throw
    const result = await fn.handler(ctx, {});
    expect(result).toBe("doc1");
  });

  it("wraps with baseMutation builder when provided", () => {
    const baseMutation = vi.fn((def: any) => ({ __wrapped: true, ...def }));
    const register = setup({ mutation: baseMutation });
    const tasks = register("tasks", makeSchema());

    const fn = tasks.mutation({
      args: { title: v.string() },
      handler: async () => {},
    });

    expect(baseMutation).toHaveBeenCalledTimes(1);
    expect(fn.__wrapped).toBe(true);
  });

  it("preserves args and returns in definition", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const fn = tasks.mutation({
      args: { title: v.string() },
      returns: v.null(),
      handler: async () => null,
    });

    expect(fn.args).toHaveProperty("title");
    expect(fn.returns).toBeDefined();
  });

  it("omits returns when undefined", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const fn = tasks.mutation({
      args: {},
      handler: async () => {},
    });

    expect(fn).not.toHaveProperty("returns");
  });
});

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

describe("query()", () => {
  it("runs handler only on local (no component)", async () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const handler = vi.fn().mockResolvedValue([1, 2, 3]);
    const remote = vi.fn();

    const fn = tasks.query({ args: {}, handler, remote });

    const result = await fn.handler({}, {});
    expect(handler).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
    expect(result).toEqual([1, 2, 3]);
  });

  it("runs handler then remote: on remote", async () => {
    const component = makeMockComponent();
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

    const handler = vi.fn().mockResolvedValue([{ id: 1 }]);
    const remote = vi.fn(async (_ctx: any, _args: any, result: any) =>
      result.map((r: any) => ({ ...r, extra: true })),
    );

    const fn = tasks.query({ args: {}, handler, remote });

    const ctx = { runQuery: vi.fn().mockResolvedValue([]) };
    const result = await fn.handler(ctx, {});

    expect(result).toEqual([{ id: 1, extra: true }]);
  });

  it("wraps with baseQuery builder when provided", () => {
    const baseQuery = vi.fn((def: any) => ({ __wrapped: true, ...def }));
    const register = setup({ query: baseQuery });
    const tasks = register("tasks", makeSchema());

    // baseQuery is called once during register() for the internal resolve query
    expect(baseQuery).toHaveBeenCalledTimes(1);

    const fn = tasks.query({
      args: {},
      handler: async () => [],
    });

    // Now called a second time for the user query
    expect(baseQuery).toHaveBeenCalledTimes(2);
    expect(fn.__wrapped).toBe(true);
  });

  it("preserves returns in query definition", () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const fn = tasks.query({
      args: {},
      returns: v.array(v.string()),
      handler: async () => [],
    });

    expect(fn.returns).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// resolve handler
// ---------------------------------------------------------------------------

describe("resolve handler", () => {
  it("returns empty diffs on local (no component)", async () => {
    const register = setup({});
    const tasks = register("tasks", makeSchema());

    const result = await tasks.resolve.handler(
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
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

    // Create a server-side doc state
    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Server title", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const runQuery = vi
      .fn()
      .mockResolvedValue([{ update: serverUpdate.buffer, seq: 0 }]);

    // Client has empty state
    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const result = await tasks.resolve.handler(
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
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("data", "value");
    const fullUpdate = Y.encodeStateAsUpdateV2(doc);
    const stateVector = Y.encodeStateVector(doc);

    const runQuery = vi
      .fn()
      .mockResolvedValue([{ update: fullUpdate.buffer, seq: 0 }]);

    const result = await tasks.resolve.handler(
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
    const register = setup({ component });
    const tasks = register("tasks", makeSchema());

    const runQuery = vi.fn().mockResolvedValue([null]);

    const result = await tasks.resolve.handler(
      { runQuery },
      {
        documents: [{ docId: "missing", vector: new ArrayBuffer(0) }],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].diff).toBeUndefined();
  });
});
