import { createTestIdentity } from "@embedded/auth/resolver";
import { BrowserWriteBroadcast } from "@embedded/browser/write";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { makeFunctionReference } from "convex/server";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vite-plus/test";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel (copied from browser/write.test.ts)
// ---------------------------------------------------------------------------

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];

  onmessage: ((ev: MessageEvent) => void) | null = null;
  name: string;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: any): void {
    this._closed ||
      MockBroadcastChannel.instances
        .filter(
          (inst) =>
            inst !== this &&
            inst.name === this.name &&
            !inst._closed &&
            inst.onmessage,
        )
        .forEach((inst) =>
          inst.onmessage!(new MessageEvent("message", { data })),
        );
  }

  close(): void {
    this._closed = true;
  }

  static reset(): void {
    MockBroadcastChannel.instances = [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal modules record that satisfies the ModuleLoader requirement for
 * a `_generated` directory entry.
 */
const STUB_MODULES: Record<string, () => Promise<any>> = {
  "./convex/_generated/api.ts": () => Promise.resolve({}),
};

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushRuntimeWatch(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let runtime: EmbeddedRuntime;

beforeEach(() => {
  MockBroadcastChannel.reset();
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  runtime = new EmbeddedRuntime({ modules: STUB_MODULES });
});

afterEach(() => {
  runtime.shutdown();
  vi.unstubAllGlobals();
  MockBroadcastChannel.reset();
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("Construction", () => {
  it("creates without errors with empty modules", () => {
    // runtime was already created in beforeEach — if we got here it succeeded
    expect(runtime).toBeDefined();
  });

  it("exposes all subsystems as public readonly fields", () => {
    expect(runtime.db).toBeDefined();
    expect(runtime.moduleLoader).toBeDefined();
    expect(runtime.executor).toBeDefined();
    expect(runtime.transactionManager).toBeDefined();
    expect(runtime.subscriptions).toBeDefined();
    expect(runtime.syncProtocol).toBeDefined();
    expect(runtime.sessions).toBeDefined();
    expect(runtime.writeFanout).toBeDefined();
    expect(runtime.auth).toBeDefined();
    expect(runtime.scheduler).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// handleMessage
// ---------------------------------------------------------------------------

describe("handleMessage", () => {
  it("returns FatalError ServerMessage for invalid JSON", async () => {
    await runtime.hydrate();

    const responses = await runtime.handleMessage("not valid json {{{");

    expect(responses).toHaveLength(1);
    const parsed = JSON.parse(responses[0]);
    expect(parsed.type).toBe("FatalError");
    expect(parsed.error).toBe("Invalid JSON");
  });

  it("routes valid Authenticate message through protocol", async () => {
    await runtime.hydrate();

    // Must Connect first to establish a session
    await runtime.handleMessage(
      JSON.stringify({
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );

    // Set identity so auth verification succeeds
    runtime.setIdentity({
      subject: "user-1",
      issuer: "https://test.local",
      tokenIdentifier: "https://test.local|user-1",
    });

    const responses = await runtime.handleMessage(
      JSON.stringify({
        type: "Authenticate",
        tokenType: "User",
        value: "test-token",
        baseVersion: 0,
        sessionId: "s1",
      }),
    );

    expect(responses.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(responses[0]);
    // Successful auth returns a Transition with incremented identity version
    expect(parsed.type).toBe("Transition");
  });

  it("returns serialized ServerMessage array", async () => {
    await runtime.hydrate();

    const responses = await runtime.handleMessage(
      JSON.stringify({
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      }),
    );

    expect(Array.isArray(responses)).toBe(true);
    // Each element is a JSON string
    responses.forEach((r) => {
      expect(typeof r).toBe("string");
      const parsed = JSON.parse(r);
      expect(typeof parsed.type).toBe("string");
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation commit
// ---------------------------------------------------------------------------

describe("onMutationCommit", () => {
  it("invalidates subscriptions for written tables", () => {
    const cb = vi.fn();
    runtime.subscriptions.subscribe("q1", new Set(["users"]), cb);

    runtime.onMutationCommit({
      tablesWritten: new Set(["users"]),
      changes: [],
      persisted: Promise.resolve(),
      timestamp: 1,
    });

    expect(cb).toHaveBeenCalledOnce();
  });

  it("is no-op for empty tablesWritten", () => {
    const cb = vi.fn();
    runtime.subscriptions.subscribe("q1", new Set(["users"]), cb);

    runtime.onMutationCommit({
      tablesWritten: new Set(),
      changes: [],
      persisted: Promise.resolve(),
      timestamp: 0,
    });

    expect(cb).not.toHaveBeenCalled();
  });

  it("delays cross-tab fanout until persistence settles", async () => {
    let resolvePersist!: () => void;
    const notifySpy = vi.spyOn(runtime.writeFanout, "notify");

    runtime.onMutationCommit({
      tablesWritten: new Set(["users"]),
      changes: [],
      persisted: new Promise<void>((resolve) => {
        resolvePersist = resolve;
      }),
      timestamp: 1,
    });

    await Promise.resolve();
    expect(notifySpy).not.toHaveBeenCalled();

    resolvePersist();
    await Promise.resolve();
    await Promise.resolve();

    expect(notifySpy).toHaveBeenCalledWith(new Set(["users"]));
  });

  it("skips cross-tab fanout when persistence fails", async () => {
    const notifySpy = vi.spyOn(runtime.writeFanout, "notify");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runtime.onMutationCommit({
      tablesWritten: new Set(["users"]),
      changes: [],
      persisted: Promise.reject(new Error("disk full")),
      timestamp: 1,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(notifySpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("cross-tab fanout refreshes another runtime after persistence settles", async () => {
    const runtimeA = new EmbeddedRuntime({
      modules: STUB_MODULES,
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime"),
    });
    const runtimeB = new EmbeddedRuntime({
      modules: STUB_MODULES,
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime"),
    });

    try {
      await runtimeA.hydrate();
      await runtimeB.hydrate();

      const syncSpy = vi
        .spyOn(runtimeB.db, "syncTable")
        .mockResolvedValue(undefined as never);
      const reevalSpy = vi
        .spyOn(runtimeB.syncProtocol, "reEvaluateQueries")
        .mockResolvedValue(new Map());
      runtimeA.onMutationCommit({
        tablesWritten: new Set(["tasks"]),
        changes: [],
        persisted: Promise.resolve(),
        timestamp: 1,
      });

      await flushRuntimeWatch();

      expect(syncSpy).toHaveBeenCalledWith("tasks");
      expect(reevalSpy).toHaveBeenCalledWith([
        { tableName: "tasks", before: null, after: null },
      ]);
    } finally {
      runtimeA.shutdown();
      runtimeB.shutdown();
    }
  });

  it("multiple cross-tab commits converge on the latest runtime refresh", async () => {
    const runtimeA = new EmbeddedRuntime({
      modules: STUB_MODULES,
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime-burst"),
    });
    const runtimeB = new EmbeddedRuntime({
      modules: STUB_MODULES,
      writeBroadcast: new BrowserWriteBroadcast("shared-runtime-burst"),
    });

    try {
      await runtimeA.hydrate();
      await runtimeB.hydrate();

      const syncSpy = vi
        .spyOn(runtimeB.db, "syncTable")
        .mockResolvedValue(undefined as never);
      runtimeA.onMutationCommit({
        tablesWritten: new Set(["tasks"]),
        changes: [],
        persisted: Promise.resolve(),
        timestamp: 1,
      });
      runtimeA.onMutationCommit({
        tablesWritten: new Set(["tasks"]),
        changes: [],
        persisted: Promise.resolve(),
        timestamp: 2,
      });

      await flushRuntimeWatch();

      expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      runtimeA.shutdown();
      runtimeB.shutdown();
    }
  });
});

describe("transaction locking", () => {
  it("serializes concurrent top-level mutations", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const order: string[] = [];
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const localRuntime = new EmbeddedRuntime({
      modules: {
        ...STUB_MODULES,
        "./convex/tasks.ts": () =>
          Promise.resolve({
            create: {
              isMutation: true,
              _handler: async () => {
                order.push("first:start");
                firstStarted();
                await new Promise<void>((resolve) => {
                  releaseFirst = resolve;
                });
                order.push("first:end");
                return "first";
              },
            },
            update: {
              isMutation: true,
              _handler: async () => {
                order.push("second:start");
                order.push("second:end");
                return "second";
              },
            },
          }),
      },
    });

    await localRuntime.hydrate();

    const first = localRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:create",
      args: {},
      applyLocalEffects: false,
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = localRuntime.executeLocal({
      kind: "mutation",
      path: "tasks:update",
      args: {},
      applyLocalEffects: false,
    });
    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });

    await firstStartedPromise;

    expect(secondResolved).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);

    localRuntime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

describe("ingestDocuments", () => {
  it("inserts new documents", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Task A" },
      { _id: "id2", _creationTime: 2, title: "Task B" },
    ]);

    const docs = await runtime.getDocumentsForTable("tasks");
    expect(docs).toHaveLength(2);

    const titles = docs
      .map((d) => d.title as string)
      .sort((a, b) => a.localeCompare(b));
    expect(titles).toEqual(["Task A", "Task B"]);
  });

  it("deletes documents missing from remote", async () => {
    await runtime.hydrate();

    // Ingest two documents
    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Keep" },
      { _id: "id2", _creationTime: 2, title: "Remove" },
    ]);

    // Re-ingest with only one — id2 should be deleted
    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Keep" },
    ]);

    const docs = await runtime.getDocumentsForTable("tasks");
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Keep");
  });

  it("no-ops when documents are identical", async () => {
    await runtime.hydrate();

    const remoteDocs = [{ _id: "id1", _creationTime: 1, title: "Same" }];

    await runtime.ingestDocuments("tasks", remoteDocs);

    // Spy on subscription invalidation to detect writes
    const invalidateSpy = vi.spyOn(runtime.subscriptions, "invalidate");

    // Ingest the same documents again — should be a no-op
    await runtime.ingestDocuments("tasks", remoteDocs);

    // invalidate should NOT have been called by the second ingest
    expect(invalidateSpy).not.toHaveBeenCalled();

    invalidateSpy.mockRestore();
  });

  it("re-evaluates queries with the ingested table name", async () => {
    await runtime.hydrate();

    const reEvaluateQueriesSpy = vi.spyOn(
      runtime.syncProtocol,
      "reEvaluateQueries",
    );
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await runtime.ingestDocuments("tasks", [
      { _id: "id1", _creationTime: 1, title: "Task A" },
    ]);

    expect(reEvaluateQueriesSpy).toHaveBeenCalledWith([
      { tableName: "tasks", before: null, after: null },
    ]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("scopes mirrored table contents by identity and anonymous namespace", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    runtime.setIdentity(createTestIdentity({ subject: "alice" }));
    expect(await runtime.getDocumentsForTable("tasks")).toEqual([]);

    await runtime.ingestDocuments("tasks", [
      { _id: "alice-1", _creationTime: 2, title: "Alice" },
    ]);

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "alice-1", _creationTime: 2, title: "Alice" },
    ]);

    runtime.setIdentity(null);
    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);
  });

  it("migrates anonymous mirrored data into an authenticated namespace", async () => {
    await runtime.hydrate();

    await runtime.ingestDocuments("tasks", [
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    const identity = createTestIdentity({ subject: "alice" });
    runtime.setIdentity(identity);
    await runtime.migrateAnonymousDataToIdentity(identity.tokenIdentifier);

    expect(await runtime.getDocumentsForTable("tasks")).toEqual([
      { _id: "anon-1", _creationTime: 1, title: "Anonymous" },
    ]);

    runtime.setIdentity(null);
    expect(await runtime.getDocumentsForTable("tasks")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

describe("executeLocal query", () => {
  it("runs a system function", async () => {
    await runtime.hydrate();

    // _system:idMapGetAll is a system query that returns all ID mappings
    const result = await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGetAll",
      args: {},
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

describe("runtime query helpers", () => {
  it("queries through the public runtime facade", async () => {
    await runtime.hydrate();

    const executeLocal = vi
      .spyOn(runtime, "executeLocal")
      .mockResolvedValue([{ _id: "task-1" }]);

    const queryRef = makeFunctionReference<"query">("tasks:list");
    const result = await runtime.query(queryRef, {});

    expect(executeLocal).toHaveBeenCalledWith({
      kind: "query",
      path: "tasks:list",
      args: {},
    });
    expect(result).toEqual([{ _id: "task-1" }]);
  });

  it("paginates through the public runtime facade", async () => {
    await runtime.hydrate();

    const executeLocal = vi.spyOn(runtime, "executeLocal").mockResolvedValue({
      page: [{ _id: "task-1" }],
      isDone: false,
      continueCursor: "cursor-2",
    });

    const queryRef = makeFunctionReference<"query">("tasks:list");
    const result = await runtime.paginate(
      queryRef,
      { owner: "alice" },
      { initialNumItems: 10 },
    );

    expect(executeLocal).toHaveBeenCalledWith({
      kind: "query",
      path: "tasks:list",
      args: {
        owner: "alice",
        paginationOpts: {
          cursor: null,
          numItems: 10,
          id: -1,
        },
      },
    });
    expect(result).toEqual({
      page: [{ _id: "task-1" }],
      isDone: false,
      continueCursor: "cursor-2",
    });
  });
});

describe("replica startup", () => {
  it("seeds the runtime from replica data before first reads", async () => {
    const seededRuntime = new EmbeddedRuntime({
      modules: STUB_MODULES,
      replica: {
        version: 1,
        identityKey: null,
        tables: {
          tasks: [
            {
              _id: "task-1",
              _creationTime: 1,
              title: "From replica",
            },
          ],
        },
      },
    });

    await seededRuntime.hydrate();

    expect(await seededRuntime.getDocumentsForTable("tasks")).toEqual([
      {
        _id: "task-1",
        _creationTime: 1,
        title: "From replica",
      },
    ]);

    seededRuntime.shutdown();
  });
});

describe("watchLocalQuery", () => {
  it("waits for hydration before evaluating the first local result", async () => {
    const gate = deferredPromise<void>();
    runtime.setHydrationGate(gate.promise);

    const evaluateSpy = vi
      .spyOn(runtime as any, "_evaluateLocalQuery")
      .mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});

    await flushRuntimeWatch();

    expect(evaluateSpy).not.toHaveBeenCalled();
    expect(watch.localQueryResult()).toBeUndefined();

    gate.resolve();
    await gate.promise;
    await flushRuntimeWatch();

    expect(evaluateSpy).toHaveBeenCalledWith("tasks:list", {});
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("returns undefined until the first evaluation completes", async () => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(runtime as any, "_evaluateLocalQuery")
      .mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});

    expect(watch.localQueryResult()).toBeUndefined();

    await flushRuntimeWatch();

    expect(evaluateSpy).toHaveBeenCalledWith("tasks:list", {});
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("notifies listeners asynchronously when a cached result already exists", async () => {
    vi.useFakeTimers();
    try {
      await runtime.hydrate();

      vi.spyOn(runtime as any, "_evaluateLocalQuery").mockResolvedValue({
        result: [{ _id: "task-1" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

      const watch = runtime.watchLocalQuery("tasks:list", {});
      await flushRuntimeWatch();

      const callback = vi.fn();
      watch.onUpdate(callback);

      expect(callback).not.toHaveBeenCalled();

      await vi.runAllTimersAsync();

      expect(callback).toHaveBeenCalledOnce();
      expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not miss the first callback when subscribed before hydration completes", async () => {
    const gate = deferredPromise<void>();
    runtime.setHydrationGate(gate.promise);

    vi.spyOn(runtime as any, "_evaluateLocalQuery").mockResolvedValue({
      result: [{ _id: "task-1" }],
      tablesRead: new Set(["tasks"]),
      dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
    });

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    gate.resolve();
    await gate.promise;
    await flushRuntimeWatch();

    expect(callback).toHaveBeenCalledOnce();
    expect(watch.localQueryResult()).toEqual([{ _id: "task-1" }]);
  });

  it("re-evaluates after matching local writes invalidate tracked dependencies", async () => {
    await runtime.hydrate();

    const evaluateSpy = vi
      .spyOn(runtime as any, "_evaluateLocalQuery")
      .mockResolvedValueOnce({
        result: [{ _id: "task-1", title: "before" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      })
      .mockResolvedValueOnce({
        result: [{ _id: "task-1", title: "after" }],
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      });

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushRuntimeWatch();
    expect(callback).toHaveBeenCalledTimes(1);

    runtime.onMutationCommit({
      tablesWritten: new Set(["tasks"]),
      changes: [],
      persisted: Promise.resolve(),
      timestamp: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(watch.localQueryResult()).toEqual([
      { _id: "task-1", title: "after" },
    ]);
  });

  it("throws the latest evaluation error from localQueryResult", async () => {
    await runtime.hydrate();

    vi.spyOn(runtime as any, "_evaluateLocalQuery").mockRejectedValue(
      new Error("watch failed"),
    );

    const watch = runtime.watchLocalQuery("tasks:list", {});
    const callback = vi.fn();
    watch.onUpdate(callback);

    await flushRuntimeWatch();

    expect(callback).toHaveBeenCalledOnce();
    expect(() => watch.localQueryResult()).toThrow("watch failed");
    expect(watch.localQueryLogs()).toEqual(["watch failed"]);
  });
});

describe("watchLocalPaginatedQuery", () => {
  it("builds a paginated local result and supports loadMore", async () => {
    await runtime.hydrate();

    vi.spyOn(runtime as any, "_evaluateLocalPaginatedPage").mockImplementation(
      async (...args: any[]) => ({
        result:
          args[2] === null
            ? {
                page: [{ _id: "task-1" }],
                isDone: false,
                continueCursor: "cursor-2",
              }
            : {
                page: [{ _id: "task-2" }],
                isDone: true,
                continueCursor: "_end_cursor",
              },
        tablesRead: new Set(["tasks"]),
        dependencies: [{ type: "FullTableScan", tableName: "tasks" }],
      }),
    );

    const watch = runtime.watchLocalPaginatedQuery(
      "tasks:list",
      {},
      {
        initialNumItems: 1,
      },
    );
    watch.onUpdate(() => {});

    await flushRuntimeWatch();

    const first = watch.localQueryResult();
    expect(first?.results).toEqual([{ _id: "task-1" }]);
    expect(first?.status).toBe("CanLoadMore");
    expect(first?.loadMore(1)).toBe(true);
    expect(watch.localQueryResult()?.status).toBe("LoadingMore");

    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (watch.localQueryResult()?.results.length === 2) {
        break;
      }
    }

    const second = watch.localQueryResult();
    expect(second?.results).toEqual([{ _id: "task-1" }, { _id: "task-2" }]);
    expect(second?.status).toBe("Exhausted");
  });
});

describe("protocol auth", () => {
  it("uses verifyToken hook when provided", async () => {
    const identity = createTestIdentity({ subject: "verified" });
    const runtime = new EmbeddedRuntime({
      modules: { "./convex/_generated/api.ts": async () => ({}) },
      verifyToken: async (token) => (token === "good" ? identity : null),
    });

    const auth = (runtime as any)._buildProtocolAuth();
    await expect(auth.verifyToken("good")).resolves.toEqual({
      identity,
      identityKey: identity.tokenIdentifier,
    });
    await expect(auth.verifyToken("bad")).rejects.toThrow(/rejected/);

    runtime.shutdown();
  });
});

describe("executeLocal system mutation", () => {
  it("runs a system function and commits", async () => {
    await runtime.hydrate();

    // Insert an ID mapping via the system mutation
    await runtime.executeLocal({
      kind: "mutation",
      path: "_system:idMapSet",
      args: {
        localId: "local-abc",
        remoteId: "remote-xyz",
        table: "users",
      },
      applyLocalEffects: false,
    });

    // Verify the mapping was committed by querying it back
    const result = await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGet",
      args: {
        localId: "local-abc",
      },
    });

    expect(result).toBe("remote-xyz");
  });
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

describe("shutdown", () => {
  it("is idempotent", () => {
    runtime.shutdown();
    // Second call should not throw
    expect(() => runtime.shutdown()).not.toThrow();
  });

  it("clears all transports", async () => {
    const transport = runtime.createTransport();
    const ws = new transport.webSocketConstructor("ws://localhost");

    // Flush microtask so the WebSocket opens
    await new Promise<void>((r) => queueMicrotask(r));
    expect(ws.readyState).toBe(1); // OPEN

    runtime.shutdown();

    expect(ws.readyState).toBe(3); // CLOSED
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe("setIdentity", () => {
  it("delegates to auth resolver", async () => {
    const identity = {
      subject: "user-42",
      issuer: "https://test.local",
      tokenIdentifier: "https://test.local|user-42",
      name: "Alice",
    };

    runtime.setIdentity(identity);

    const resolved = await runtime.auth.getUserIdentity();
    expect(resolved).toEqual(identity);

    // Clear it
    runtime.setIdentity(null);
    const cleared = await runtime.auth.getUserIdentity();
    expect(cleared).toBeNull();
  });
});
