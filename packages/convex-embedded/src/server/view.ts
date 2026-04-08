/**
 * View utilities for scoping query results.
 *
 * Views are standalone helpers -- not part of register().
 * The app composes them into its own queries:
 *
 *   import { view } from '@robelest/convex-embedded/server';
 *
 *   export const list = query({
 *     args: {},
 *     handler: async (ctx) => {
 *       return await view.ownership({ index: 'by_user_id', field: 'userId' })
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
    async apply(
      ctx: {
        auth?: {
          getUserIdentity(): Promise<{ tokenIdentifier?: string } | null>;
        };
      },
      query: unknown,
    ) {
      return Fx.run(
        Fx.from({
          ok: () => ctx.auth?.getUserIdentity(),
          err: (error) => error as Error,
        }).pipe(
          Fx.map((identity) => {
            if (!identity) {
              throw new Error(
                "convex-embedded: view.authenticated() requires a logged-in user",
              );
            }
            return query;
          }),
        ),
      );
    },
  };
}

/**
 * Scopes rows through an index where the owner field matches the current
 * user's ID. Unauthenticated callers scope to `null`, which should yield no
 * rows when the owner field stores non-null auth identifiers.
 */
function ownership(options: { index: string; field: string }): ViewFilter {
  const { index, field } = options;

  return {
    async apply(
      ctx: {
        auth: {
          getUserIdentity(): Promise<{
            subject?: string;
            tokenIdentifier?: string;
          } | null>;
        };
      },
      query: {
        withIndex(indexName: string, builder: (q: unknown) => unknown): unknown;
      },
    ) {
      return Fx.run(
        Fx.from({
          ok: () => ctx.auth.getUserIdentity(),
          err: (error) => error as Error,
        }).pipe(
          Fx.map((identity) => {
            const userId =
              identity?.subject ?? identity?.tokenIdentifier ?? null;

            return query.withIndex(index, (q: unknown) => {
              const qb = q as {
                eq(fieldName: string, value: unknown): unknown;
              };
              return qb.eq(field, userId);
            });
          }),
        ),
      );
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
};
import { Fx } from "@robelest/fx";
