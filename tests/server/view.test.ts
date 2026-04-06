import { view } from "@resolve/server/view";
import { describe, it, expect, vi } from "vite-plus/test";

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
    await expect(view.authenticated().apply({}, q)).rejects.toThrow(
      "requires a logged-in user",
    );
  });
});

describe("view.ownership()", () => {
  it("scopes by indexed owner field when authenticated", async () => {
    const withIndexFn = vi.fn((_indexName: string, builder: any) => {
      const scoped = builder({
        eq: vi.fn((fieldName: string, value: unknown) => ({
          fieldName,
          value,
        })),
      });
      return { scoped };
    });
    const q = { withIndex: withIndexFn };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue({
          subject: "user123",
          tokenIdentifier: "token123",
        }),
      },
    };

    const result = await view
      .ownership({ index: "by_user_id", field: "userId" })
      .apply(ctx, q);

    expect(withIndexFn).toHaveBeenCalledTimes(1);
    expect(withIndexFn).toHaveBeenCalledWith(
      "by_user_id",
      expect.any(Function),
    );
    expect(result).toEqual({
      scoped: { fieldName: "userId", value: "user123" },
    });
  });

  it("scopes unauthenticated callers to null", async () => {
    const withIndexFn = vi.fn((_indexName: string, builder: any) => {
      const scoped = builder({
        eq: vi.fn((fieldName: string, value: unknown) => ({
          fieldName,
          value,
        })),
      });
      return { scoped };
    });
    const q = { withIndex: withIndexFn };
    const ctx = {
      auth: {
        getUserIdentity: vi.fn().mockResolvedValue(null),
      },
    };

    const result = await view
      .ownership({ index: "by_user_id", field: "userId" })
      .apply(ctx, q);

    expect(withIndexFn).toHaveBeenCalledTimes(1);
    expect(withIndexFn).toHaveBeenCalledWith(
      "by_user_id",
      expect.any(Function),
    );
    expect(result).toEqual({
      scoped: { fieldName: "userId", value: null },
    });
  });
});
