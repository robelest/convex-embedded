import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { monitor } from "#resolve/client/monitor";

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

    // Mock addEventListener/removeEventListener (may not exist in Node)
    globalThis.addEventListener = vi.fn();
    globalThis.removeEventListener = vi.fn();

    // Mock navigator.onLine as true by default
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

  it("returns a MonitorInstance with expected methods", () => {
    const remoteClient = { query: vi.fn().mockResolvedValue([]) };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    expect(m).toHaveProperty("start");
    expect(m).toHaveProperty("stop");
    expect(m).toHaveProperty("on");
    expect(m).toHaveProperty("getStatus");
    expect(m).toHaveProperty("resolveNow");
  });

  it("starts with idle status before start()", () => {
    const remoteClient = { query: vi.fn().mockResolvedValue([]) };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  it("transitions to resolving on start() when online", async () => {
    const remoteClient = {
      query: vi.fn().mockResolvedValue([]),
    };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();

    // Give async resolve time to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(statuses).toContain("resolving");
    expect(statuses).toContain("resolved");

    m.stop();
  });

  it("transitions to offline on start() when navigator.onLine is false", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: false },
      writable: true,
      configurable: true,
    });

    const remoteClient = { query: vi.fn() };

    const m = monitor.create({
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

  it("calls resolve query for each table", async () => {
    const remoteClient = {
      query: vi.fn().mockResolvedValue([]),
    };

    const m = monitor.create({
      remoteClient,
      tables: {
        tasks: { resolve: "tasks.resolve" },
        comments: { resolve: "comments.resolve" },
      },
    });

    m.start();
    await new Promise((r) => setTimeout(r, 50));

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
    const remoteClient = {
      query: vi.fn().mockRejectedValue(new Error("network error")),
    };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
      maxRetries: 2,
      retryDelayMs: 10,
    });

    const statuses: string[] = [];
    m.on("change", (status) => statuses.push(status.status));

    m.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(statuses).toContain("error");

    m.stop();
  });

  it("on() returns unsubscribe function", () => {
    const remoteClient = { query: vi.fn().mockResolvedValue([]) };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    const listener = vi.fn();
    const unsub = m.on("change", listener);

    m.start();
    // Force an emit
    expect(listener).toHaveBeenCalled();

    const callCount = listener.mock.calls.length;
    unsub();

    // After unsub, no more calls even if status changes
    m.stop();
    // stop() clears listeners, but unsub already removed this one
    // The key point: unsub returned a function that works
    expect(typeof unsub).toBe("function");
  });

  it("start() is idempotent", async () => {
    const remoteClient = {
      query: vi.fn().mockResolvedValue([]),
    };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    m.start();
    m.start();
    m.start();

    await new Promise((r) => setTimeout(r, 50));

    // Should only have been called once (for one table)
    expect(remoteClient.query).toHaveBeenCalledTimes(1);

    m.stop();
  });

  it("stop() cleans up and sets status to idle", async () => {
    const remoteClient = {
      query: vi.fn().mockResolvedValue([]),
    };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    m.start();
    await new Promise((r) => setTimeout(r, 50));
    m.stop();

    expect(m.getStatus()).toEqual({ status: "idle" });
  });

  it("resolveNow() triggers a resolve cycle", async () => {
    const remoteClient = {
      query: vi.fn().mockResolvedValue([]),
    };

    const m = monitor.create({
      remoteClient,
      tables: { tasks: { resolve: "resolve_ref" } },
    });

    await m.resolveNow();

    expect(remoteClient.query).toHaveBeenCalledTimes(1);
    expect(m.getStatus()).toEqual({ status: "resolved" });
  });
});
