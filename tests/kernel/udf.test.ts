import type { ModuleLoader } from "@embedded/kernel/modules";
import { UdfExecutor } from "@embedded/kernel/udf";
import { remoteOnly } from "@embedded/server/table";
import { describe, it, expect } from "@tests/testkit";
import { ConvexError } from "convex/values";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  const commitResult = {
    timestamp: 1,
    tablesWritten: new Set(["messages"]),
    persisted: Promise.resolve(),
  };
  return {
    startTransaction: vi.fn(),
    commit: vi.fn().mockReturnValue(commitResult),
    commitAsync: vi.fn().mockResolvedValue(commitResult),
    rollbackWrites: vi.fn(),
  } as any;
}

function createMockCrypto() {
  return {
    randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
    getRandomValues: vi.fn((bytes: Uint8Array) => bytes),
    sha256: vi.fn(async () => new Uint8Array()),
    encryptAesGcm: vi.fn(async () => new Uint8Array()),
    decryptAesGcm: vi.fn(async () => new Uint8Array()),
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

function componentFp(componentPath: string, udfPath: string) {
  return { componentPath, udfPath };
}

function makeExecutor(
  modules: Record<string, Record<string, any>>,
  db = createMockDb(),
) {
  return {
    executor: new UdfExecutor({
      db,
      crypto: createMockCrypto(),
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

    const error = await executor
      .executeQuery(fp("messages:list"), {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "ROUTE_REMOTE_LOCAL_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(/remoteOnly\(\)/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects nested component queries during local execution", async () => {
    const handler = vi.fn(async () => "should-not-run");
    const { executor } = makeExecutor({
      messages: {
        list: { isQuery: true, handler },
      },
    });

    const error = await executor
      .executeQuery(componentFp("embedded", "messages:list"), {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "NESTED_COMPONENT_LOCAL_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(/component function/);
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

    const { result, commit } = await executor.executeMutation(
      fp("messages:send"),
      { text: "hello" },
    );

    expect(result).toBe("hello");
    expect(commit.tablesWritten).toEqual(new Set(["messages"]));
    expect(db.commitAsync).toHaveBeenCalledOnce();
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

  it("rejects nested component mutations during local execution", async () => {
    const { executor } = makeExecutor({
      messages: { send: { isMutation: true } },
    });

    const error = await executor
      .executeMutation(componentFp("embedded", "messages:send"), {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "NESTED_COMPONENT_LOCAL_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(/component function/);
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

  it("rejects nested component actions during local execution", async () => {
    const { executor } = makeExecutor({ api: { fetch: { isAction: true } } });

    const error = await executor
      .executeAction(componentFp("embedded", "api:fetch"), {})
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<any>).data.code).toBe(
      "NESTED_COMPONENT_LOCAL_UNSUPPORTED",
    );
    expect((error as Error).message).toMatch(/component function/);
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
