import { describe, it, expect, vi } from "vitest";
import { builders } from "./builders.js";

describe("builders()", () => {
  describe("when components.resolve is absent (local Concave)", () => {
    const { mutation, query } = builders({});

    it("mutation runs handler only", async () => {
      const handler = vi.fn().mockResolvedValue("result");
      const remote = vi.fn();

      const fn = mutation({
        args: {},
        handler,
        remote,
      });

      const result = await fn.handler({}, {});

      expect(handler).toHaveBeenCalledTimes(1);
      expect(remote).not.toHaveBeenCalled();
      expect(result).toBe("result");
    });

    it("query runs handler only", async () => {
      const handler = vi.fn().mockResolvedValue([1, 2, 3]);
      const remote = vi.fn();

      const fn = query({
        args: {},
        handler,
        remote,
      });

      const result = await fn.handler({}, {});

      expect(handler).toHaveBeenCalledTimes(1);
      expect(remote).not.toHaveBeenCalled();
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe("when components.resolve is present (remote Convex)", () => {
    const { mutation, query } = builders({
      resolve: { public: {} } as any,
    });

    it("mutation runs handler then remote", async () => {
      const callOrder: string[] = [];
      const handler = vi.fn(async () => {
        callOrder.push("handler");
        return "handlerResult";
      });
      const remote = vi.fn(async () => {
        callOrder.push("remote");
      });

      const fn = mutation({
        args: {},
        handler,
        remote,
      });

      const result = await fn.handler({}, {});

      expect(callOrder).toEqual(["handler", "remote"]);
      expect(result).toBe("handlerResult");
    });

    it("mutation passes result to remote", async () => {
      const handler = vi.fn().mockResolvedValue({ id: "123" });
      const remote = vi.fn();

      const fn = mutation({
        args: {},
        handler,
        remote,
      });

      await fn.handler({}, { title: "test" });

      expect(remote).toHaveBeenCalledWith(
        expect.anything(), // ctx
        { title: "test" },  // args
        { id: "123" },      // result
      );
    });

    it("query runs remote with handler result and returns transformed result", async () => {
      const handler = vi.fn().mockResolvedValue([{ id: 1 }]);
      const remote = vi.fn(async (_ctx: any, _args: any, result: any) => {
        return result.map((r: any) => ({ ...r, extra: true }));
      });

      const fn = query({
        args: {},
        handler,
        remote,
      });

      const result = await fn.handler({}, {});

      expect(result).toEqual([{ id: 1, extra: true }]);
    });

    it("mutation without remote: key still works", async () => {
      const handler = vi.fn().mockResolvedValue("ok");

      const fn = mutation({
        args: {},
        handler,
      });

      const result = await fn.handler({}, {});
      expect(result).toBe("ok");
    });
  });

  describe("with base builders", () => {
    it("passes function definition to baseMutation", () => {
      const baseMutation = vi.fn((def: any) => ({ wrapped: true, ...def }));
      const { mutation } = builders({}, baseMutation);

      const fn = mutation({
        args: { title: "string" },
        handler: async () => {},
      });

      expect(baseMutation).toHaveBeenCalledTimes(1);
      expect(fn.wrapped).toBe(true);
    });

    it("passes function definition to baseQuery", () => {
      const baseQuery = vi.fn((def: any) => ({ wrapped: true, ...def }));
      const { query } = builders({}, undefined, baseQuery);

      const fn = query({
        args: {},
        handler: async () => [],
      });

      expect(baseQuery).toHaveBeenCalledTimes(1);
      expect(fn.wrapped).toBe(true);
    });
  });

  describe("args and returns passthrough", () => {
    it("preserves args in mutation definition", () => {
      const { mutation } = builders({});

      const fn = mutation({
        args: { title: "v.string()" as any },
        returns: "v.null()" as any,
        handler: async () => null,
      });

      expect(fn.args).toEqual({ title: "v.string()" });
    });

    it("preserves returns in query definition", () => {
      const { query } = builders({});

      const fn = query({
        args: {},
        returns: "v.array()" as any,
        handler: async () => [],
      });

      expect(fn.returns).toBe("v.array()");
    });

    it("omits returns when undefined", () => {
      const { mutation } = builders({});

      const fn = mutation({
        args: {},
        handler: async () => {},
      });

      expect(fn).not.toHaveProperty("returns");
    });
  });
});
