import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { v } from "convex/values";
import { register } from "#resolve/server/register.js";
import { define, register as registerField, prose } from "#resolve/server/schema.js";

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
// Tests
// ---------------------------------------------------------------------------

describe("register()", () => {
  it("returns resolve, _recordDelta, and wrapMutation", () => {
    const result = register({
      table: "tasks",
      schema: makeSchema(),
    });

    expect(result).toHaveProperty("resolve");
    expect(result).toHaveProperty("_recordDelta");
    expect(result).toHaveProperty("wrapMutation");
    expect(result.resolve).toHaveProperty("handler");
    expect(result._recordDelta).toHaveProperty("handler");
    expect(typeof result.wrapMutation).toBe("function");
  });

  it("_recordDelta has v.string() docId arg and v.null() returns", () => {
    const result = register({
      table: "tasks",
      schema: makeSchema(),
    });

    expect(result._recordDelta.args).toHaveProperty("docId");
    expect(result._recordDelta.returns).toBeDefined();
  });

  it("resolve has properly typed args", () => {
    const result = register({
      table: "tasks",
      schema: makeSchema(),
    });

    expect(result.resolve.args).toHaveProperty("documents");
  });
});

describe("_recordDelta handler", () => {
  it("is a no-op on local embedded runtime (no component)", async () => {
    const { _recordDelta } = register({
      table: "tasks",
      schema: makeSchema(),
    });

    const result = await _recordDelta.handler({}, { docId: "123" });
    expect(result).toBeNull();
  });

  it("reads doc and writes to component on remote", async () => {
    const component = makeMockComponent();
    const runMutation = vi.fn();
    const dbGet = vi.fn().mockResolvedValue({
      _id: "123",
      title: "Hello",
      body: "World",
    });

    const { _recordDelta } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    await _recordDelta.handler(
      { db: { get: dbGet }, runMutation },
      { docId: "123" },
    );

    expect(dbGet).toHaveBeenCalledWith("123");
    expect(runMutation).toHaveBeenCalledWith(
      component.public.insertDelta,
      expect.objectContaining({
        collection: "tasks",
        docId: "123",
      }),
    );
  });

  it("handles missing document gracefully", async () => {
    const component = makeMockComponent();
    const dbGet = vi.fn().mockResolvedValue(null);

    const { _recordDelta } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    const result = await _recordDelta.handler(
      { db: { get: dbGet }, runMutation: vi.fn() },
      { docId: "missing" },
    );

    expect(result).toBeNull();
  });

  it("does not throw on component write failure", async () => {
    const component = makeMockComponent();
    const dbGet = vi.fn().mockResolvedValue({
      _id: "123",
      title: "Hello",
    });
    const runMutation = vi.fn().mockRejectedValue(new Error("write failed"));

    const { _recordDelta } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    // Should not throw
    const result = await _recordDelta.handler(
      { db: { get: dbGet }, runMutation },
      { docId: "123" },
    );

    expect(result).toBeNull();
  });
});

describe("resolve handler", () => {
  it("returns empty diffs on local embedded runtime (no component)", async () => {
    const { resolve } = register({
      table: "tasks",
      schema: makeSchema(),
    });

    const result = await resolve.handler({}, {
      documents: [
        { docId: "a", vector: new ArrayBuffer(0) },
        { docId: "b", vector: new ArrayBuffer(0) },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0].docId).toBe("a");
    expect(result[0].diff).toBeUndefined();
  });

  it("computes diffs from component deltas on remote", async () => {
    const component = makeMockComponent();
    const schemaDef = makeSchema();

    // Create a server-side doc state
    const serverDoc = new Y.Doc();
    const fields = serverDoc.getMap("fields");
    const titleMap = new Y.Map();
    titleMap.set("_init", { value: "Server title", timestamp: Date.now() });
    fields.set("title", titleMap);
    const serverUpdate = Y.encodeStateAsUpdateV2(serverDoc);

    const runQuery = vi.fn().mockResolvedValue([
      { update: serverUpdate.buffer, seq: 0 },
    ]);

    const { resolve } = register({
      table: "tasks",
      schema: schemaDef,
      component,
    });

    // Client has empty state
    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const result = await resolve.handler(
      { runQuery },
      {
        documents: [
          { docId: "doc1", vector: clientVector.buffer },
        ],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].docId).toBe("doc1");
    // Should have a non-empty diff since client is behind
    expect(result[0].diff).toBeDefined();
  });

  it("returns no diff when client is up to date", async () => {
    const component = makeMockComponent();
    const schemaDef = makeSchema();

    // Use the SAME Y.Doc for both server and client (same clientID + clock)
    // so the diff is truly empty
    const doc = new Y.Doc();
    const fields = doc.getMap("fields");
    fields.set("data", "value");
    const fullUpdate = Y.encodeStateAsUpdateV2(doc);
    const stateVector = Y.encodeStateVector(doc);

    const runQuery = vi.fn().mockResolvedValue([
      { update: fullUpdate.buffer, seq: 0 },
    ]);

    const { resolve } = register({
      table: "tasks",
      schema: schemaDef,
      component,
    });

    const result = await resolve.handler(
      { runQuery },
      {
        documents: [
          { docId: "doc1", vector: stateVector.buffer },
        ],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].diff).toBeUndefined(); // Up to date
  });

  it("handles missing deltas gracefully", async () => {
    const component = makeMockComponent();
    const runQuery = vi.fn().mockResolvedValue([null]);

    const { resolve } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    const result = await resolve.handler(
      { runQuery },
      {
        documents: [
          { docId: "missing", vector: new ArrayBuffer(0) },
        ],
      },
    );

    expect(result).toHaveLength(1);
    expect(result[0].diff).toBeUndefined();
  });
});

describe("wrapMutation()", () => {
  it("runs handler and remote on remote Convex", async () => {
    const component = makeMockComponent();
    const { wrapMutation } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    const callOrder: string[] = [];
    const handler = vi.fn(async () => {
      callOrder.push("handler");
      return "doc123";
    });
    const remote = vi.fn(async () => {
      callOrder.push("remote");
    });

    const scheduler = { runAfter: vi.fn() };
    const recordDeltaRef = { _name: "_recordDelta" };

    const wrapped = wrapMutation(recordDeltaRef, {
      args: {},
      handler,
      remote,
    });

    const result = await wrapped.handler({ scheduler }, {});

    expect(callOrder).toEqual(["handler", "remote"]);
    expect(result).toBe("doc123");
  });

  it("schedules _recordDelta via ctx.scheduler.runAfter(0, ...)", async () => {
    const component = makeMockComponent();
    const { wrapMutation } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    const scheduler = { runAfter: vi.fn() };
    const recordDeltaRef = { _name: "_recordDelta" };

    const wrapped = wrapMutation(recordDeltaRef, {
      args: {},
      handler: async () => "docId123",
    });

    await wrapped.handler({ scheduler }, {});

    expect(scheduler.runAfter).toHaveBeenCalledWith(
      0,
      recordDeltaRef,
      { docId: "docId123" },
    );
  });

  it("extracts docId from args.id when result is not a string", async () => {
    const component = makeMockComponent();
    const { wrapMutation } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    const scheduler = { runAfter: vi.fn() };
    const recordDeltaRef = { _name: "_recordDelta" };

    const wrapped = wrapMutation(recordDeltaRef, {
      args: {},
      handler: async () => undefined,
    });

    await wrapped.handler({ scheduler }, { id: "fromArgs" });

    expect(scheduler.runAfter).toHaveBeenCalledWith(
      0,
      recordDeltaRef,
      { docId: "fromArgs" },
    );
  });

  it("does not schedule on local embedded runtime", async () => {
    const { wrapMutation } = register({
      table: "tasks",
      schema: makeSchema(),
      // No component
    });

    const scheduler = { runAfter: vi.fn() };
    const recordDeltaRef = { _name: "_recordDelta" };

    const wrapped = wrapMutation(recordDeltaRef, {
      args: {},
      handler: async () => "result",
    });

    await wrapped.handler({ scheduler }, {});

    expect(scheduler.runAfter).not.toHaveBeenCalled();
  });

  it("does not throw if scheduler.runAfter fails", async () => {
    const component = makeMockComponent();
    const { wrapMutation } = register({
      table: "tasks",
      schema: makeSchema(),
      component,
    });

    const scheduler = {
      runAfter: vi.fn().mockRejectedValue(new Error("scheduler error")),
    };
    const recordDeltaRef = { _name: "_recordDelta" };

    const wrapped = wrapMutation(recordDeltaRef, {
      args: {},
      handler: async () => "docId",
    });

    // Should not throw
    const result = await wrapped.handler({ scheduler }, {});
    expect(result).toBe("docId");
  });
});
