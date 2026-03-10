import { describe, it, expect, vi } from "vitest";

import { view } from "#resolve/server/view";

describe("view.public()", () => {
  it("returns query unchanged", () => {
    const q = { collect: vi.fn() };
    const result = view.public().apply({}, q);
    expect(result).toBe(q);
  });
});

describe("view.authenticated()", () => {
  it("returns query when user is authenticated", async () => {
    const q = { collect: vi.fn() };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          subject: "user123",
          tokenIdentifier: "token123",
        }),
      },
    };

    const result = await view.authenticated().apply(ctx, q);
    expect(result).toBe(q);
  });

  it("throws when user is not authenticated", async () => {
    const q = { collect: vi.fn() };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue(null),
      },
    };

    await expect(view.authenticated().apply(ctx, q)).rejects.toThrow(
      "requires a logged-in user",
    );
  });

  it("throws when auth is missing entirely", async () => {
    const q = { collect: vi.fn() };
    // ctx.auth is undefined
    await expect(view.authenticated().apply({}, q)).rejects.toThrow(
      "requires a logged-in user",
    );
  });
});

describe("view.ownership()", () => {
  it("filters by owner field when authenticated", async () => {
    const filterFn = vi.fn((_fn: any) => {
      // Simulate the filter builder
      return "filtered";
    });
    const q = { filter: filterFn };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          subject: "user123",
          tokenIdentifier: "token123",
        }),
      },
    };

    const result = await view.ownership({ owner: "userId" }).apply(ctx, q);

    expect(filterFn).toHaveBeenCalledTimes(1);
    expect(result).toBe("filtered");
  });

  it("returns impossible filter for unauthenticated", async () => {
    const filterFn = vi.fn(() => "impossible");
    const q = { filter: filterFn };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue(null),
      },
    };

    const result = await view.ownership({ owner: "userId" }).apply(ctx, q);

    expect(filterFn).toHaveBeenCalledTimes(1);
    expect(result).toBe("impossible");
  });
});

describe("view.filter()", () => {
  it("applies custom filter function", () => {
    const customFilter = vi.fn((_ctx: any, query: any) => ({
      ...query,
      filtered: true,
    }));

    const v = view.filter(customFilter);
    const result = v.apply({}, { data: [1, 2, 3] });

    expect(customFilter).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ data: [1, 2, 3], filtered: true });
  });

  it("supports async filter functions", async () => {
    const asyncFilter = vi.fn(async (_ctx: any, query: any) => {
      return { ...query, async: true };
    });

    const v = view.filter(asyncFilter);
    const result = await v.apply({}, { data: [] });

    expect(result).toEqual({ data: [], async: true });
  });
});
