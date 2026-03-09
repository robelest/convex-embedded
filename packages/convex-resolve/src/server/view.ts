/**
 * View utilities for scoping query results.
 *
 * Views are standalone helpers — not part of register().
 * The app composes them into its own queries:
 *
 *   import { view } from 'convex-resolve/server';
 *
 *   export const list = query({
 *     args: {},
 *     handler: async (ctx) => {
 *       return await view.ownership({ owner: 'userId' })
 *         .apply(ctx, ctx.db.query('tasks'))
 *         .collect();
 *     },
 *   });
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ViewFilter<Ctx = unknown, Q = unknown> {
  /** Apply this view's filter to a query. Returns the filtered query. */
  apply(ctx: Ctx, query: Q): Q | Promise<Q>;
}

type FilterFn<Ctx = unknown, Q = unknown> = (ctx: Ctx, query: Q) => Q | Promise<Q>;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * No filter. All rows visible to all callers.
 */
function publicView(): ViewFilter {
  return {
    apply(_ctx: unknown, query: unknown) {
      return query;
    },
  };
}

/**
 * Requires a valid identity. Returns all rows. Throws if unauthenticated.
 */
function authenticated(): ViewFilter {
  return {
    async apply(ctx: { auth?: { getUserIdentity(): Promise<{ tokenIdentifier?: string } | null> } }, query: unknown) {
      const identity = await ctx.auth?.getUserIdentity();
      if (!identity) {
        throw new Error("convex-resolve: view.authenticated() requires a logged-in user");
      }
      return query;
    },
  };
}

/**
 * Filters to rows where the `owner` field matches the current user's ID.
 * Unauthenticated callers see nothing (empty result set).
 */
function ownership(options: { owner: string }): ViewFilter {
  const { owner } = options;

  return {
    async apply(
      ctx: { auth: { getUserIdentity(): Promise<{ subject?: string; tokenIdentifier?: string } | null> } },
      query: { filter(predicate: (q: unknown) => unknown): unknown },
    ) {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        // Return a query that will produce no results
        // by filtering on an impossible condition
        return query.filter((q: unknown) => (q as { eq(a: unknown, b: unknown): unknown }).eq(true, false));
      }

      const userId = identity.subject ?? identity.tokenIdentifier;

      return query.filter((q: unknown) => {
        const qb = q as { eq(a: unknown, b: unknown): unknown; field(name: string): unknown };
        return qb.eq(qb.field(owner), userId);
      });
    },
  };
}

/**
 * Custom filter view. Accepts a function (ctx, query) => filteredQuery.
 */
function filter<Ctx = unknown, Q = unknown>(fn: FilterFn<Ctx, Q>): ViewFilter<Ctx, Q> {
  return {
    apply(ctx: Ctx, query: Q): Q | Promise<Q> {
      return fn(ctx, query);
    },
  };
}

// ---------------------------------------------------------------------------
// Export as namespace
// ---------------------------------------------------------------------------

export const view = {
  public: publicView,
  authenticated,
  ownership,
  filter,
};
