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

export interface ViewFilter<Ctx = any, Q = any> {
  /** Apply this view's filter to a query. Returns the filtered query. */
  apply(ctx: Ctx, query: Q): Q | Promise<Q>;
}

type FilterFn<Ctx = any, Q = any> = (ctx: Ctx, query: Q) => Q | Promise<Q>;

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * No filter. All rows visible to all callers.
 */
function publicView(): ViewFilter {
  return {
    apply(_ctx: any, query: any) {
      return query;
    },
  };
}

/**
 * Requires a valid identity. Returns all rows. Throws if unauthenticated.
 */
function authenticated(): ViewFilter {
  return {
    async apply(ctx: any, query: any) {
      const identity = await ctx.auth?.getUserIdentity?.();
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
    async apply(ctx: any, query: any) {
      const identity = await ctx.auth?.getUserIdentity?.();
      if (!identity) {
        // Return a query that will produce no results
        // by filtering on an impossible condition
        return query.filter((q: any) => q.eq(true, false));
      }

      const userId = identity.subject ?? identity.tokenIdentifier;

      return query.filter((q: any) => q.eq(q.field(owner), userId));
    },
  };
}

/**
 * Custom filter view. Accepts a function (ctx, query) => filteredQuery.
 */
function filter<Ctx = any, Q = any>(fn: FilterFn<Ctx, Q>): ViewFilter<Ctx, Q> {
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
