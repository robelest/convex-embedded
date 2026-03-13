import { describe, it, expect, vi } from "vitest";

import type { ModuleLoader } from "#embedded/kernel/module-loader";
import { UdfExecutor } from "#embedded/kernel/udf-executor";
import { remoteOnly } from "#embedded/server/setup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  return {
    startTransaction: vi.fn(),
    commit: vi
      .fn()
      .mockReturnValue({ timestamp: 1, tablesWritten: new Set(["messages"]) }),
    rollbackWrites: vi.fn(),
  } as any;
}

function createMockModuleLoader(
  modules: Record<string, Record<string, any>>,
): ModuleLoader {
  return {
    load: vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve(modules[path] ?? {}),
      ),
  } as any;
}

const mockRunUdf = vi.fn();

function fp(udfPath: string) {
  return { componentPath: "", udfPath };
}

function makeExecutor(
  modules: Record<string, Record<string, any>>,
  db = createMockDb(),
) {
  return {
    executor: new UdfExecutor({
      db,
      moduleLoader: createMockModuleLoader(modules),
      runUdf: mockRunUdf,
    }),
    db,
  };
}

// ---------------------------------------------------------------------------
// executeQuery
// ---------------------------------------------------------------------------

describe("executeQuery", () => {
  it("runs a handler function and returns the result", async () => {
    const handler = vi.fn(async (_ctx: any, args: any) => args.x * 2);
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, handler } },
    });

    const result = await executor.executeQuery(fp("messages:list"), { x: 5 });

    expect(result).toBe(10);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("runs invokeQuery SDK path and deserializes result", async () => {
    const invokeQuery = vi.fn(async (_argsStr: string) => JSON.stringify(42));
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, invokeQuery } },
    });

    const result = await executor.executeQuery(fp("messages:list"), {});

    expect(result).toBe(42);
    expect(invokeQuery).toHaveBeenCalledOnce();
  });

  it("always rolls back writes after query execution", async () => {
    const handler = vi.fn(async () => "ok");
    const db = createMockDb();
    const { executor } = makeExecutor(
      { mod: { default: { isQuery: true, handler } } },
      db,
    );

    await executor.executeQuery(fp("mod"), {});

    expect(db.startTransaction).toHaveBeenCalledOnce();
    expect(db.rollbackWrites).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("throws when export does not exist", async () => {
    const { executor } = makeExecutor({ messages: {} });

    await expect(
      executor.executeQuery(fp("messages:list"), {}),
    ).rejects.toThrow(/no such export/);
  });

  it("throws when calling a mutation as a query", async () => {
    const { executor } = makeExecutor({
      messages: { send: { isMutation: true, handler: vi.fn() } },
    });

    await expect(
      executor.executeQuery(fp("messages:send"), {}),
    ).rejects.toThrow(/not a query/);
  });

  it("rejects local execution for remoteOnly() exports", async () => {
    const handler = vi.fn(async () => "should-not-run");
    const { executor } = makeExecutor({
      messages: {
        list: remoteOnly({ isQuery: true, handler }),
      },
    });

    await expect(
      executor.executeQuery(fp("messages:list"), {}),
    ).rejects.toThrow(/marked remoteOnly\(\)/);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeMutation
// ---------------------------------------------------------------------------

describe("executeMutation", () => {
  it("runs a handler function, commits, and returns result with tablesWritten", async () => {
    const handler = vi.fn(async (_ctx: any, args: any) => args.text);
    const db = createMockDb();
    const { executor } = makeExecutor(
      { messages: { send: { isMutation: true, handler } } },
      db,
    );

    const { result, tablesWritten } = await executor.executeMutation(
      fp("messages:send"),
      { text: "hello" },
    );

    expect(result).toBe("hello");
    expect(tablesWritten).toEqual(new Set(["messages"]));
    expect(db.commit).toHaveBeenCalledOnce();
    expect(db.rollbackWrites).not.toHaveBeenCalled();
  });

  it("runs invokeMutation SDK path", async () => {
    const invokeMutation = vi.fn(async (_argsStr: string) =>
      JSON.stringify("created"),
    );
    const { executor } = makeExecutor({
      messages: { send: { isMutation: true, invokeMutation } },
    });

    const { result } = await executor.executeMutation(fp("messages:send"), {});

    expect(result).toBe("created");
    expect(invokeMutation).toHaveBeenCalledOnce();
  });

  it("rolls back writes on handler error", async () => {
    const handler = vi.fn(async () => {
      throw new Error("mutation failed");
    });
    const db = createMockDb();
    const { executor } = makeExecutor(
      { messages: { send: { isMutation: true, handler } } },
      db,
    );

    await expect(
      executor.executeMutation(fp("messages:send"), {}),
    ).rejects.toThrow("mutation failed");

    expect(db.rollbackWrites).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("throws when calling a query as a mutation", async () => {
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, handler: vi.fn() } },
    });

    await expect(
      executor.executeMutation(fp("messages:list"), {}),
    ).rejects.toThrow(/not a mutation/);
  });
});

// ---------------------------------------------------------------------------
// executeAction
// ---------------------------------------------------------------------------

describe("executeAction", () => {
  it("runs a handler function without a transaction", async () => {
    const handler = vi.fn(async (_ctx: any, args: any) => args.url);
    const db = createMockDb();
    const { executor } = makeExecutor(
      { api: { fetch: { isAction: true, handler } } },
      db,
    );

    const result = await executor.executeAction(fp("api:fetch"), {
      url: "https://example.com",
    });

    expect(result).toBe("https://example.com");
    expect(db.startTransaction).not.toHaveBeenCalled();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("runs invokeAction SDK path", async () => {
    const invokeAction = vi.fn(async (_requestId: string, _argsStr: string) =>
      JSON.stringify("fetched"),
    );
    const { executor } = makeExecutor({
      api: { fetch: { isAction: true, invokeAction } },
    });

    const result = await executor.executeAction(fp("api:fetch"), {});

    expect(result).toBe("fetched");
    expect(invokeAction).toHaveBeenCalledOnce();
  });

  it("throws when no handler found", async () => {
    const { executor } = makeExecutor({
      api: { fetch: { isAction: true } },
    });

    await expect(executor.executeAction(fp("api:fetch"), {})).rejects.toThrow(
      /could not extract a handler/,
    );
  });
});

// ---------------------------------------------------------------------------
// Global patching
// ---------------------------------------------------------------------------

describe("Global patching", () => {
  it("installs globalThis.Convex during execution and restores after", async () => {
    const originalConvex = globalThis.Convex;
    let capturedConvex: typeof globalThis.Convex;

    const handler = vi.fn(async () => {
      capturedConvex = globalThis.Convex;
      return "done";
    });
    const { executor } = makeExecutor({
      mod: { default: { isQuery: true, handler } },
    });

    await executor.executeQuery(fp("mod"), {});

    expect(capturedConvex!).toBeDefined();
    expect(typeof capturedConvex!.syscall).toBe("function");
    expect(typeof capturedConvex!.asyncSyscall).toBe("function");
    expect(typeof capturedConvex!.jsSyscall).toBe("function");
    expect(globalThis.Convex).toBe(originalConvex);
  });

  it("restores globals even when the UDF throws", async () => {
    const originalConvex = globalThis.Convex;
    const originalMathRandom = Math.random;
    const originalDateNow = Date.now;

    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const { executor } = makeExecutor({
      mod: { default: { isQuery: true, handler } },
    });

    await expect(executor.executeQuery(fp("mod"), {})).rejects.toThrow("boom");

    expect(globalThis.Convex).toBe(originalConvex);
    expect(Math.random).toBe(originalMathRandom);
    expect(Date.now).toBe(originalDateNow);
  });
});
