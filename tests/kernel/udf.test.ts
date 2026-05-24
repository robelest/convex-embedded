import {
  ModuleLoader,
  type ConvexModule,
  type FunctionPath,
} from "@embedded/kernel/modules";
import type { RunUdfFn } from "@embedded/kernel/syscalls";
import { UdfExecutor } from "@embedded/kernel/udf";
import type { EmbeddedCryptoProvider } from "@embedded/runtime/crypto";
import {
  Database,
  type CommitInvalidationBatch,
  type DatabaseCommitResult,
} from "@embedded/runtime/db/database";
import { remoteOnly } from "@embedded/server/table";
import { describe, expect, it, vi, type MockInstance } from "@tests/testkit";
import { ConvexError } from "convex/values";

type HandlerFn = (
  ctx: Record<string, unknown>,
  args: Record<string, unknown>,
) => unknown;

interface TestDescriptor {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  handler?: HandlerFn;
  invokeQuery?: (argsStr: string) => Promise<string>;
  invokeMutation?: (argsStr: string) => Promise<string>;
  invokeAction?: (requestId: string, argsStr: string) => Promise<string>;
}

type TestModules = Record<string, Record<string, TestDescriptor>>;

interface MockDb {
  db: Database;
  startTransaction: MockInstance<Database["startTransaction"]>;
  rollbackWrites: MockInstance<Database["rollbackWrites"]>;
  commit: MockInstance<Database["commit"]>;
  commitAsync: MockInstance<Database["commitAsync"]>;
}

function makeCommitResult(
  overrides: Partial<DatabaseCommitResult> = {},
): DatabaseCommitResult {
  const invalidation: CommitInvalidationBatch = {
    tables: new Set(),
    changes: [],
  };
  return {
    timestamp: 1,
    tablesWritten: new Set(["messages"]),
    invalidation,
    persisted: Promise.resolve(),
    ...overrides,
  };
}

function createMockDb(): MockDb {
  const db = new Database(null);
  const commitResult = makeCommitResult();
  return {
    db,
    startTransaction: vi
      .spyOn(db, "startTransaction")
      .mockImplementation(() => {}),
    rollbackWrites: vi.spyOn(db, "rollbackWrites").mockImplementation(() => {}),
    commit: vi.spyOn(db, "commit").mockReturnValue(commitResult),
    commitAsync: vi.spyOn(db, "commitAsync").mockResolvedValue(commitResult),
  };
}

function createMockCrypto(): EmbeddedCryptoProvider {
  return {
    randomUUID: vi.fn<EmbeddedCryptoProvider["randomUUID"]>(
      () => "00000000-0000-4000-8000-000000000000",
    ),
    getRandomValues: vi.fn<EmbeddedCryptoProvider["getRandomValues"]>(
      (bytes) => bytes,
    ),
    sha256: vi.fn<EmbeddedCryptoProvider["sha256"]>(
      async () => new Uint8Array(),
    ),
    encryptAesGcm: vi.fn<EmbeddedCryptoProvider["encryptAesGcm"]>(
      async () => new Uint8Array(),
    ),
    decryptAesGcm: vi.fn<EmbeddedCryptoProvider["decryptAesGcm"]>(
      async () => new Uint8Array(),
    ),
  };
}

function moduleLoaderFor(modules: TestModules): ModuleLoader {
  const registry: Record<string, () => Promise<ConvexModule>> = {};
  for (const [path, exports] of Object.entries(modules)) {
    registry[path] = () => Promise.resolve(exports as ConvexModule);
  }
  return new ModuleLoader(registry);
}

const mockRunUdf = vi.fn<RunUdfFn>();

function fp(udfPath: string): FunctionPath {
  return { componentPath: "", udfPath };
}

function componentFp(componentPath: string, udfPath: string): FunctionPath {
  return { componentPath, udfPath };
}

function makeExecutor(
  modules: TestModules,
  mockDb: MockDb = createMockDb(),
): { executor: UdfExecutor; db: MockDb } {
  return {
    executor: new UdfExecutor({
      db: mockDb.db,
      crypto: createMockCrypto(),
      moduleLoader: moduleLoaderFor(modules),
      runUdf: mockRunUdf,
    }),
    db: mockDb,
  };
}

function errorData(error: unknown): { code: string } {
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<{ code: string }>).data;
}

describe("executeQuery", () => {
  it("runs a handler function and returns the result", async () => {
    const handler = vi.fn<HandlerFn>((_ctx, args) => Number(args.x) * 2);
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, handler } },
    });

    const result = await executor.executeQuery(fp("messages:list"), { x: 5 });

    expect(result).toBe(10);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("runs the invokeQuery SDK path and deserializes the result", async () => {
    const invokeQuery = vi.fn(async () => JSON.stringify(42));
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, invokeQuery } },
    });

    const result = await executor.executeQuery(fp("messages:list"), {});

    expect(result).toBe(42);
    expect(invokeQuery).toHaveBeenCalledOnce();
  });

  it("always rolls back writes after query execution", async () => {
    const handler = vi.fn<HandlerFn>(async () => "ok");
    const { executor, db } = makeExecutor({
      mod: { default: { isQuery: true, handler } },
    });

    await executor.executeQuery(fp("mod"), {});

    expect(db.startTransaction).toHaveBeenCalledOnce();
    expect(db.rollbackWrites).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("throws when the export does not exist", async () => {
    const { executor } = makeExecutor({ messages: {} });

    await expect(
      executor.executeQuery(fp("messages:list"), {}),
    ).rejects.toThrow(/no such export/);
  });

  it("throws when calling a mutation as a query", async () => {
    const { executor } = makeExecutor({
      messages: { send: { isMutation: true, handler: vi.fn<HandlerFn>() } },
    });

    await expect(
      executor.executeQuery(fp("messages:send"), {}),
    ).rejects.toThrow(/not a query/);
  });

  it("rejects local execution for remoteOnly() exports", async () => {
    const handler = vi.fn<HandlerFn>(async () => "should-not-run");
    const { executor } = makeExecutor({
      messages: { list: remoteOnly({ isQuery: true, handler }) },
    });

    const error = await executor
      .executeQuery(fp("messages:list"), {})
      .catch((err: unknown) => err);

    expect(errorData(error).code).toBe("ROUTE_REMOTE_LOCAL_UNSUPPORTED");
    expect((error as Error).message).toMatch(/remoteOnly\(\)/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects nested component queries during local execution", async () => {
    const handler = vi.fn<HandlerFn>(async () => "should-not-run");
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, handler } },
    });

    const error = await executor
      .executeQuery(componentFp("embedded", "messages:list"), {})
      .catch((err: unknown) => err);

    expect(errorData(error).code).toBe("NESTED_COMPONENT_LOCAL_UNSUPPORTED");
    expect((error as Error).message).toMatch(/component function/);
  });
});

describe("executeMutation", () => {
  it("runs a handler, commits, and returns the result with tablesWritten", async () => {
    const handler = vi.fn<HandlerFn>(async (_ctx, args) => args.text);
    const { executor, db } = makeExecutor({
      messages: { send: { isMutation: true, handler } },
    });

    const { result, commit } = await executor.executeMutation(
      fp("messages:send"),
      { text: "hello" },
    );

    expect(result).toBe("hello");
    expect(commit.tablesWritten).toEqual(new Set(["messages"]));
    expect(db.commitAsync).toHaveBeenCalledOnce();
    expect(db.rollbackWrites).not.toHaveBeenCalled();
  });

  it("runs the invokeMutation SDK path", async () => {
    const invokeMutation = vi.fn(async () => JSON.stringify("created"));
    const { executor } = makeExecutor({
      messages: { send: { isMutation: true, invokeMutation } },
    });

    const { result } = await executor.executeMutation(fp("messages:send"), {});

    expect(result).toBe("created");
    expect(invokeMutation).toHaveBeenCalledOnce();
  });

  it("rolls back writes on handler error", async () => {
    const handler = vi.fn<HandlerFn>(async () => {
      throw new Error("mutation failed");
    });
    const { executor, db } = makeExecutor({
      messages: { send: { isMutation: true, handler } },
    });

    await expect(
      executor.executeMutation(fp("messages:send"), {}),
    ).rejects.toThrow("mutation failed");

    expect(db.rollbackWrites).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("throws when calling a query as a mutation", async () => {
    const { executor } = makeExecutor({
      messages: { list: { isQuery: true, handler: vi.fn<HandlerFn>() } },
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

    expect(errorData(error).code).toBe("NESTED_COMPONENT_LOCAL_UNSUPPORTED");
    expect((error as Error).message).toMatch(/component function/);
  });
});

describe("executeAction", () => {
  it("runs a handler function without a transaction", async () => {
    const handler = vi.fn<HandlerFn>(async (_ctx, args) => args.url);
    const { executor, db } = makeExecutor({
      api: { fetch: { isAction: true, handler } },
    });

    const result = await executor.executeAction(fp("api:fetch"), {
      url: "https://example.com",
    });

    expect(result).toBe("https://example.com");
    expect(db.startTransaction).not.toHaveBeenCalled();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("runs the invokeAction SDK path", async () => {
    const invokeAction = vi.fn(async () => JSON.stringify("fetched"));
    const { executor } = makeExecutor({
      api: { fetch: { isAction: true, invokeAction } },
    });

    const result = await executor.executeAction(fp("api:fetch"), {});

    expect(result).toBe("fetched");
    expect(invokeAction).toHaveBeenCalledOnce();
  });

  it("throws when no handler is found", async () => {
    const { executor } = makeExecutor({ api: { fetch: { isAction: true } } });

    await expect(executor.executeAction(fp("api:fetch"), {})).rejects.toThrow(
      /could not extract a handler/,
    );
  });

  it("rejects nested component actions during local execution", async () => {
    const { executor } = makeExecutor({ api: { fetch: { isAction: true } } });

    const error = await executor
      .executeAction(componentFp("embedded", "api:fetch"), {})
      .catch((err: unknown) => err);

    expect(errorData(error).code).toBe("NESTED_COMPONENT_LOCAL_UNSUPPORTED");
    expect((error as Error).message).toMatch(/component function/);
  });
});

describe("global patching", () => {
  it("installs globalThis.Convex during execution and restores it after", async () => {
    const originalConvex = globalThis.Convex;
    let capturedConvex: typeof globalThis.Convex;
    const handler = vi.fn<HandlerFn>(async () => {
      capturedConvex = globalThis.Convex;
      return "done";
    });
    const { executor } = makeExecutor({
      mod: { default: { isQuery: true, handler } },
    });

    await executor.executeQuery(fp("mod"), {});

    expect(capturedConvex).toBeDefined();
    expect(typeof capturedConvex?.syscall).toBe("function");
    expect(typeof capturedConvex?.asyncSyscall).toBe("function");
    expect(typeof capturedConvex?.jsSyscall).toBe("function");
    expect(globalThis.Convex).toBe(originalConvex);
  });

  it("restores globals even when the UDF throws", async () => {
    const originalConvex = globalThis.Convex;
    const originalMathRandom = Math.random;
    const originalDateNow = Date.now;
    const handler = vi.fn<HandlerFn>(async () => {
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
