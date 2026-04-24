import {
  ModuleLoader,
  createFunctionHandle,
  getFunctionFromHandle,
  resolveFunctionPath,
} from "@embedded/kernel/modules";
import { describe, it, expect } from "@tests/testkit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModules(): Record<string, () => Promise<any>> {
  return {
    messages: () => Promise.resolve({ list: "listFn", send: "sendFn" }),
    "lib/utils": () => Promise.resolve({ helper: "helperFn" }),
    auth: () => Promise.resolve({ login: "loginFn" }),
  };
}

function createLegacyMockModules(): Record<string, () => Promise<any>> {
  return {
    "_generated/api": () => Promise.resolve({ default: {} }),
    messages: () => Promise.resolve({ list: "listFn", send: "sendFn" }),
    "lib/utils": () => Promise.resolve({ helper: "helperFn" }),
    "./convex/auth.tsx": () => Promise.resolve({ login: "loginFn" }),
  };
}

// ---------------------------------------------------------------------------
// ModuleLoader
// ---------------------------------------------------------------------------

describe("ModuleLoader", () => {
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

  it("throws with a helpful error when module is not found", async () => {
    const loader = new ModuleLoader(createMockModules());

    await expect(loader.load("nonexistent")).rejects.toThrow(
      /Could not find module for: "nonexistent"/,
    );
    // The error should list available modules
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

// ---------------------------------------------------------------------------
// createFunctionHandle / getFunctionFromHandle
// ---------------------------------------------------------------------------

describe("createFunctionHandle", () => {
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

describe("getFunctionFromHandle", () => {
  it("round-trips with createFunctionHandle", () => {
    const original = { componentPath: "comp", udfPath: "mod:fn" };
    const handle = createFunctionHandle(original);
    const resolved = getFunctionFromHandle(handle);

    expect(resolved).toEqual(original);
  });

  it("parses a handle string that was not created in this process", () => {
    const handle = "function://other;path:export";
    const result = getFunctionFromHandle(handle);

    expect(result).toEqual({
      componentPath: "other",
      udfPath: "path:export",
    });
  });

  it("parses a handle with empty componentPath", () => {
    const handle = "function://;messages:send";
    const result = getFunctionFromHandle(handle);

    expect(result).toEqual({
      componentPath: "",
      udfPath: "messages:send",
    });
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

// ---------------------------------------------------------------------------
// resolveFunctionPath
// ---------------------------------------------------------------------------

describe("resolveFunctionPath", () => {
  it('resolves { name } to a FunctionPath with currentComponentPath as ""', () => {
    const result = resolveFunctionPath({ name: "messages:list" });

    expect(result).toEqual({
      componentPath: "",
      udfPath: "messages:list",
    });
  });

  it("resolves { name } using the provided currentComponentPath", () => {
    const result = resolveFunctionPath(
      { name: "messages:list" },
      "myComponent",
    );

    expect(result).toEqual({
      componentPath: "myComponent",
      udfPath: "messages:list",
    });
  });

  it("resolves { reference } to componentPath and udfPath", () => {
    const result = resolveFunctionPath({
      reference: "_reference/childComponent/aggregate/path/to/file/fnName",
    });

    expect(result).toEqual({
      componentPath: "aggregate",
      udfPath: "path/to/file:fnName",
    });
  });

  it("resolves { reference } and prepends currentComponentPath", () => {
    const result = resolveFunctionPath(
      { reference: "_reference/childComponent/sub/module/func" },
      "parent",
    );

    expect(result).toEqual({
      componentPath: "parent/sub",
      udfPath: "module:func",
    });
  });

  it("resolves { functionHandle } by delegating to getFunctionFromHandle", () => {
    const handle = createFunctionHandle({
      componentPath: "comp",
      udfPath: "mod:fn",
    });

    const result = resolveFunctionPath({ functionHandle: handle });

    expect(result).toEqual({
      componentPath: "comp",
      udfPath: "mod:fn",
    });
  });

  it("throws when no address field is provided", () => {
    expect(() => resolveFunctionPath({})).toThrow(
      /Function address must have at least one of/,
    );
  });

  it("prioritizes functionHandle over name", () => {
    const handle = createFunctionHandle({
      componentPath: "fromHandle",
      udfPath: "handle:fn",
    });

    const result = resolveFunctionPath({
      functionHandle: handle,
      name: "name:fn",
    });

    // functionHandle is checked first in the source
    expect(result.componentPath).toBe("fromHandle");
    expect(result.udfPath).toBe("handle:fn");
  });
});
