import {
  ModuleLoader,
  createFunctionHandle,
  getFunctionFromHandle,
  getFunctionPath,
  type ConvexModuleRegistry,
} from "@embedded/kernel/modules";
import { describe, expect, it } from "@tests/testkit";

function createMockModules(): ConvexModuleRegistry {
  return {
    messages: () => Promise.resolve({ list: "listFn", send: "sendFn" }),
    "lib/utils": () => Promise.resolve({ helper: "helperFn" }),
    auth: () => Promise.resolve({ login: "loginFn" }),
  };
}

function createLegacyMockModules(): ConvexModuleRegistry {
  return {
    "_generated/api": () => Promise.resolve({ default: {} }),
    messages: () => Promise.resolve({ list: "listFn", send: "sendFn" }),
    "lib/utils": () => Promise.resolve({ helper: "helperFn" }),
    "./convex/auth.tsx": () => Promise.resolve({ login: "loginFn" }),
  };
}

describe.concurrent("ModuleLoader", () => {
  it("loads canonical registry keys directly", async () => {
    const loader = new ModuleLoader(createMockModules());

    const mod = await loader.load("messages");

    expect(mod).toEqual({ list: "listFn", send: "sendFn" });
  });

  it("loads a top-level module by name", async () => {
    const loader = new ModuleLoader(createMockModules());

    const mod = await loader.load("messages");

    expect(mod.list).toBe("listFn");
    expect(mod.send).toBe("sendFn");
  });

  it("loads a nested module by path", async () => {
    const loader = new ModuleLoader(createMockModules());

    const mod = await loader.load("lib/utils");

    expect(mod.helper).toBe("helperFn");
  });

  it("normalizes legacy glob-style keys", async () => {
    const loader = new ModuleLoader(createLegacyMockModules());

    const mod = await loader.load("auth");

    expect(mod.login).toBe("loginFn");
  });

  it("throws a helpful error naming the missing module", async () => {
    const loader = new ModuleLoader(createMockModules());

    await expect(loader.load("nonexistent")).rejects.toThrow(
      /Could not find module for: "nonexistent"/,
    );
  });

  it("lists available modules in the not-found error", async () => {
    const loader = new ModuleLoader(createMockModules());

    await expect(loader.load("nonexistent")).rejects.toThrow(/messages/);
  });

  it("supports legacy path-like keys without a _generated sentinel", async () => {
    const loader = new ModuleLoader({
      foo: () => Promise.resolve({ default: "fooFn" }),
      bar: () => Promise.resolve({ default: "barFn" }),
    });

    await expect(loader.load("foo")).resolves.toEqual({ default: "fooFn" });
  });
});

describe.concurrent("createFunctionHandle", () => {
  it('returns a "function://<componentPath>;<udfPath>" string', () => {
    const handle = createFunctionHandle({
      componentPath: "",
      udfPath: "messages:list",
    });

    expect(handle).toBe("function://;messages:list");
  });

  it("includes a non-empty componentPath", () => {
    const handle = createFunctionHandle({
      componentPath: "aggregate",
      udfPath: "stats:compute",
    });

    expect(handle).toBe("function://aggregate;stats:compute");
  });
});

describe.concurrent("getFunctionFromHandle", () => {
  it("round-trips with createFunctionHandle", () => {
    const original = { componentPath: "comp", udfPath: "mod:fn" };

    const resolved = getFunctionFromHandle(createFunctionHandle(original));

    expect(resolved).toEqual(original);
  });

  it("parses a handle string not created in this process", () => {
    const result = getFunctionFromHandle("function://other;path:export");

    expect(result).toEqual({ componentPath: "other", udfPath: "path:export" });
  });

  it("parses a handle with an empty componentPath", () => {
    const result = getFunctionFromHandle("function://;messages:send");

    expect(result).toEqual({ componentPath: "", udfPath: "messages:send" });
  });

  it("throws on a handle without the function:// prefix", () => {
    expect(() => getFunctionFromHandle("invalid-handle")).toThrow(
      /Invalid function handle/,
    );
  });

  it("throws on a handle missing the semicolon separator", () => {
    expect(() => getFunctionFromHandle("function://noSemicolon")).toThrow(
      /Malformed function handle/,
    );
  });
});

describe.concurrent("getFunctionPath", () => {
  it('resolves { name } with currentComponentPath defaulting to ""', () => {
    const result = getFunctionPath({ name: "messages:list" });

    expect(result).toEqual({ componentPath: "", udfPath: "messages:list" });
  });

  it("resolves { name } using the provided currentComponentPath", () => {
    const result = getFunctionPath({ name: "messages:list" }, "myComponent");

    expect(result).toEqual({
      componentPath: "myComponent",
      udfPath: "messages:list",
    });
  });

  it("resolves { reference } to componentPath and udfPath", () => {
    const result = getFunctionPath({
      reference: "_reference/childComponent/aggregate/path/to/file/fnName",
    });

    expect(result).toEqual({
      componentPath: "aggregate",
      udfPath: "path/to/file:fnName",
    });
  });

  it("resolves { reference } and prepends currentComponentPath", () => {
    const result = getFunctionPath(
      { reference: "_reference/childComponent/sub/module/func" },
      "parent",
    );

    expect(result).toEqual({
      componentPath: "parent/sub",
      udfPath: "module:func",
    });
  });

  it("resolves { functionHandle } via getFunctionFromHandle", () => {
    const handle = createFunctionHandle({
      componentPath: "comp",
      udfPath: "mod:fn",
    });

    const result = getFunctionPath({ functionHandle: handle });

    expect(result).toEqual({ componentPath: "comp", udfPath: "mod:fn" });
  });

  it("throws when no address field is provided", () => {
    expect(() => getFunctionPath({})).toThrow(
      /Function address must have at least one of/,
    );
  });

  it("prioritizes functionHandle over name", () => {
    const handle = createFunctionHandle({
      componentPath: "fromHandle",
      udfPath: "handle:fn",
    });

    const result = getFunctionPath({
      functionHandle: handle,
      name: "name:fn",
    });

    expect(result).toEqual({
      componentPath: "fromHandle",
      udfPath: "handle:fn",
    });
  });
});
