import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { monitor } from "#resolve/client/monitor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLocalClient() {
  return {
    query: vi.fn().mockImplementation((path: string) => {
      if (path === "_system:idMapGetAll") return Promise.resolve([]);
      if (path === "_system:pendingGetAll") return Promise.resolve([]);
      return Promise.resolve(null);
    }),
    mutation: vi.fn().mockImplementation((path: string) => {
      if (path === "_system:pendingPush") return Promise.resolve("pending-doc-1");
      return Promise.resolve(null);
    }),
  };
}

function createMockRemoteClient() {
  return {
    query: vi.fn().mockResolvedValue([]),
    mutation: vi.fn().mockResolvedValue(null),
  };
}

function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("monitor.create()", () => {
  let originalAddEventListener: typeof globalThis.addEventListener | undefined;
  let originalRemoveEventListener:
    | typeof globalThis.removeEventListener
    | undefined;
  let originalNavigator: any;

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
  });

  // -------------------------------------------------------------------------
  // Basic structure
  // -------------------------------------------------------------------------

  it("returns a MonitorInstance with expected methods", () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    expect(m).toHaveProperty("start");
    expect(m).toHaveProperty("stop");
    expect(m).toHaveProperty("on");
    expect(m).toHaveProperty("getStatus");
    expect(m).toHaveProperty("resolveNow");
    expect(m).toHaveProperty("mutation");
    expect(m).toHaveProperty("pendingCount");
    expect(m).toHaveProperty("idMap");
    expect(m).toHaveProperty("pendingQueue");
  });

  it("starts with idle status before start()", () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  // -------------------------------------------------------------------------
  // Start / Stop lifecycle
  // -------------------------------------------------------------------------

  it("transitions through resolving to resolved on start() when online", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await settle();

    expect(statuses).toContain("resolving");
    expect(statuses).toContain("resolved");

    // Hydration queries were issued on localClient
    expect(localClient.query).toHaveBeenCalledWith("_system:idMapGetAll", {});
    expect(localClient.query).toHaveBeenCalledWith("_system:pendingGetAll", {});

    m.stop();
  });

  it("transitions to offline on start() when navigator.onLine is false", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();

    expect(statuses).toContain("offline");
    expect(remoteClient.query).not.toHaveBeenCalled();

    m.stop();
  });

  it("start() is idempotent", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    m.start();
    m.start();
    m.start();

    await settle();

    // Resolve query called once per table (1 table), not tripled
    expect(remoteClient.query).toHaveBeenCalledTimes(1);

    m.stop();
  });

  it("stop() cleans up and sets status to idle", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    m.start();
    await settle();
    m.stop();

    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  it("stop() removes event listeners", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    m.start();
    await settle();

    const addCalls = (globalThis.addEventListener as ReturnType<typeof vi.fn>)
      .mock.calls.length;
    expect(addCalls).toBeGreaterThan(0);

    m.stop();

    const removeCalls = (
      globalThis.removeEventListener as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    expect(removeCalls).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Resolve
  // -------------------------------------------------------------------------

  it("calls resolve query for each registered table", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: {
        tasks: { resolve: "tasks.resolve" },
        comments: { resolve: "comments.resolve" },
      },
    });

    m.start();
    await settle();

    expect(remoteClient.query).toHaveBeenCalledTimes(2);
    expect(remoteClient.query).toHaveBeenCalledWith("tasks.resolve", {
      documents: [],
    });
    expect(remoteClient.query).toHaveBeenCalledWith("comments.resolve", {
      documents: [],
    });

    m.stop();
  });

  it("transitions to error when resolve fails after retries", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = {
      query: vi.fn().mockRejectedValue(new Error("network error")),
      mutation: vi.fn().mockResolvedValue(null),
    };

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
      maxRetries: 2,
      retryDelayMs: 10,
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await settle(200);

    expect(statuses).toContain("error");

    m.stop();
  });

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  it("on('change', ...) returns an unsubscribe function", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const listener = vi.fn();
    const unsub = m.on("change", listener);

    expect(typeof unsub).toBe("function");

    m.start();
    await settle();

    expect(listener).toHaveBeenCalled();

    m.stop();
  });

  it("listener receives status changes", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await settle();
    m.stop();

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).toContain("resolving");
    expect(statuses).toContain("resolved");
    // stop() clears listeners before emitting idle, so the listener
    // does not observe the final idle transition — verify via getStatus
    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  it("after unsubscribe, listener receives no more calls", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const listener = vi.fn();
    const unsub = m.on("change", listener);

    m.start();
    await settle();

    const callCount = listener.mock.calls.length;
    expect(callCount).toBeGreaterThan(0);

    unsub();

    // Trigger further status changes — listener should not be called again
    m.stop();
    expect(listener.mock.calls.length).toBe(callCount);
  });

  // -------------------------------------------------------------------------
  // Mutation proxying
  // -------------------------------------------------------------------------

  it("mutation() writes to localClient first", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    await m.mutation("tasks:create", { title: "Buy milk" });

    expect(localClient.mutation).toHaveBeenCalledWith("tasks:create", {
      title: "Buy milk",
    });
  });

  it("mutation() returns the local result", async () => {
    const localClient = createMockLocalClient();
    localClient.mutation.mockImplementation((path: string) => {
      if (path === "_system:pendingPush") return Promise.resolve("pending-doc-1");
      return Promise.resolve({ _id: "local-123" });
    });
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const result = await m.mutation("tasks:create", { title: "Buy milk" });

    expect(result).toEqual({ _id: "local-123" });
  });

  it("mutation() persists to pending queue via localClient", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    await m.mutation("tasks:create", { title: "Buy milk" });
    await settle();

    // The pendingPush system mutation should have been called
    expect(localClient.mutation).toHaveBeenCalledWith(
      "_system:pendingPush",
      expect.objectContaining({
        ref: expect.any(String),
        args: expect.any(String),
        localResult: expect.any(String),
        table: expect.any(String),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // resolveNow
  // -------------------------------------------------------------------------

  it("resolveNow() triggers a resolve cycle", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    expect(m.getStatus()).toEqual({ status: "resolved" });
  });

  // -------------------------------------------------------------------------
  // pendingCount
  // -------------------------------------------------------------------------

  it("pendingCount() reflects queue size", async () => {
    const localClient = createMockLocalClient();
    const remoteClient = createMockRemoteClient();

    const m = monitor.create({
      localClient,
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    expect(m.pendingCount()).toBe(0);

    // Mutation goes through local write then queues — go offline so queue stays
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    m.start();
    await settle();

    await m.mutation("tasks:create", { title: "Task 1" });
    await settle();

    expect(m.pendingCount()).toBeGreaterThanOrEqual(1);

    m.stop();
  });
});
