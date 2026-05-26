import { describe, expect, it } from "@tests/testkit";
import type { FunctionReference } from "convex/server";
import { convexToJson } from "convex/values";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  setAuth: vi.fn(),
  instances: [] as Array<{ url: string; options?: unknown }>,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = mocks.query;
    setAuth = mocks.setAuth;
    constructor(url: string, options?: unknown) {
      mocks.instances.push({ url, options });
    }
  },
}));

import {
  emptyPreloaded,
  preloadQuery,
  preloadedQueryRef,
  preloadedQueryResult,
} from "@resolve/client/preload";
import { makeFunctionReference } from "@resolve/shared/refs";

const projectsList =
  makeFunctionReference<FunctionReference<"query">>("projects:list");

beforeEach(() => {
  mocks.query.mockReset();
  mocks.setAuth.mockReset();
  mocks.instances.length = 0;
});

describe("preloadQuery", () => {
  it("runs the query on the http client and returns an opaque payload", async () => {
    const value = [{ _id: "p1", name: "Alpha" }];
    mocks.query.mockResolvedValue(value);

    const preloaded = await preloadQuery(
      projectsList,
      { teamId: "t1" },
      { url: "https://example.convex.cloud" },
    );

    expect(mocks.instances).toEqual([
      { url: "https://example.convex.cloud", options: { logger: false } },
    ]);
    expect(mocks.query).toHaveBeenCalledWith(projectsList, { teamId: "t1" });
    expect(mocks.setAuth).not.toHaveBeenCalled();
    expect(preloaded).toEqual({
      _name: "projects:list",
      _argsJSON: convexToJson({ teamId: "t1" }),
      _valueJSON: convexToJson(value),
    });
  });

  it("sets auth when a token is provided", async () => {
    mocks.query.mockResolvedValue(null);

    await preloadQuery(
      projectsList,
      {},
      { url: "https://example.convex.cloud", token: "tok-123" },
    );

    expect(mocks.setAuth).toHaveBeenCalledWith("tok-123");
  });
});

describe("preloadedQueryResult", () => {
  it("round-trips Convex values including bigint and bytes", () => {
    const value = {
      count: 9007199254740993n,
      blob: new Uint8Array([1, 2, 3]).buffer,
      nested: { name: "Alpha" },
    };
    const preloaded = {
      _name: "projects:get",
      _argsJSON: convexToJson({}),
      _valueJSON: convexToJson(value),
    } as Parameters<typeof preloadedQueryResult>[0];

    expect(preloadedQueryResult(preloaded)).toEqual(value);
  });
});

describe("preloadedQueryRef", () => {
  it("decodes the query name and args", () => {
    const preloaded = {
      _name: "projects:list",
      _argsJSON: convexToJson({ teamId: "t1", limit: 5n }),
      _valueJSON: convexToJson(null),
    } as Parameters<typeof preloadedQueryRef>[0];

    expect(preloadedQueryRef(preloaded)).toEqual({
      name: "projects:list",
      args: { teamId: "t1", limit: 5n },
    });
  });
});

describe("emptyPreloaded", () => {
  it("builds a name + args payload with a null value", () => {
    const preloaded = emptyPreloaded(projectsList, { teamId: "t1" });

    expect(preloaded).toEqual({
      _name: "projects:list",
      _argsJSON: convexToJson({ teamId: "t1" }),
      _valueJSON: null,
    });
    expect(preloadedQueryResult(preloaded)).toBeNull();
    expect(preloadedQueryRef(preloaded)).toEqual({
      name: "projects:list",
      args: { teamId: "t1" },
    });
  });
});
