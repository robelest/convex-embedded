import { view } from "@resolve/server/view";
import { describe, expect, it, vi } from "@tests/testkit";

interface IdentityCtx {
  auth: {
    getUserIdentity: () => Promise<{
      subject?: string;
      tokenIdentifier?: string;
    } | null>;
  };
}

function authedCtx(
  identity: { subject?: string; tokenIdentifier?: string } | null,
): IdentityCtx {
  return {
    auth: { getUserIdentity: vi.fn().mockResolvedValue(identity) },
  };
}

describe("view.public()", () => {
  it("returns the query unchanged", () => {
    const q = { collect: vi.fn() };

    const result = view.public().apply({}, q);

    expect(result).toBe(q);
  });
});

describe("view.authenticated()", () => {
  it("returns the query when the user is authenticated", async () => {
    const q = { collect: vi.fn() };
    const ctx = authedCtx({ subject: "user123", tokenIdentifier: "token123" });

    const result = await view.authenticated().apply(ctx, q);

    expect(result).toBe(q);
  });

  it("throws when the user is not authenticated", async () => {
    const q = { collect: vi.fn() };
    const ctx = authedCtx(null);

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
  function ownershipQuery() {
    const eq = vi.fn((fieldName: string, value: unknown) => ({
      fieldName,
      value,
    }));
    const withIndex = vi.fn(
      (_indexName: string, builder: (q: { eq: typeof eq }) => unknown) => ({
        scoped: builder({ eq }),
      }),
    );
    return { withIndex, eq, query: { withIndex } };
  }

  it("scopes by the indexed owner field when authenticated", async () => {
    const { withIndex, query } = ownershipQuery();
    const ctx = authedCtx({ subject: "user123", tokenIdentifier: "token123" });

    const result = await view
      .ownership({ index: "by_user_id", field: "userId" })
      .apply(ctx, query);

    expect(withIndex).toHaveBeenCalledTimes(1);
    expect(withIndex).toHaveBeenCalledWith("by_user_id", expect.any(Function));
    expect(result).toEqual({
      scoped: { fieldName: "userId", value: "user123" },
    });
  });

  it("scopes unauthenticated callers to null", async () => {
    const { withIndex, query } = ownershipQuery();
    const ctx = authedCtx(null);

    const result = await view
      .ownership({ index: "by_user_id", field: "userId" })
      .apply(ctx, query);

    expect(withIndex).toHaveBeenCalledTimes(1);
    expect(withIndex).toHaveBeenCalledWith("by_user_id", expect.any(Function));
    expect(result).toEqual({
      scoped: { fieldName: "userId", value: null },
    });
  });
});
