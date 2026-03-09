/**
 * builders() — creates mutation and query wrappers with remote: key support.
 *
 * Usage in consuming app:
 *   // convex/functions.ts
 *   import { builders } from 'convex-resolve/server';
 *   import { components } from './_generated/api';
 *   export const { mutation, query } = builders(components);
 *
 * The returned `mutation` and `query` accept an optional `remote:` key:
 *   - On remote Convex: handler runs, then remote runs (same transaction),
 *     then _recordDelta is scheduled via ctx.scheduler.runAfter(0, ...).
 *   - On local embedded runtime: handler runs only. remote is ignored.
 */
import {
  type MutationBuilder,
  type QueryBuilder,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type GenericDataModel,
  type FunctionReference,
} from "convex/server";
import { createLogger } from "../shared/logger.js";

const log = createLogger("builders");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The components object shape we expect. The consuming app passes
 * `components` from their `_generated/api`, which includes the
 * `resolve` component if installed.
 */
interface ResolveComponentApi {
  public?: {
    insertDelta?: FunctionReference<"mutation">;
  };
}

interface ComponentsMap {
  resolve?: ResolveComponentApi;
}

/**
 * Extended mutation definition that accepts a `remote:` key.
 */
export interface ResolveMutationDefinition<
  Ctx,
  Args extends Record<string, any>,
  Returns,
> {
  args: Record<string, any>;
  returns?: any;
  handler: (ctx: Ctx, args: Args) => Promise<Returns> | Returns;
  /** Only runs on remote Convex. Same transaction as handler. */
  remote?: (ctx: Ctx, args: Args, result: Returns) => Promise<void> | void;
}

/**
 * Extended query definition that accepts a `remote:` key.
 */
export interface ResolveQueryDefinition<
  Ctx,
  Args extends Record<string, any>,
  Returns,
> {
  args: Record<string, any>;
  returns?: any;
  handler: (ctx: Ctx, args: Args) => Promise<Returns> | Returns;
  /** Only runs on remote Convex. Receives handler result as third arg. */
  remote?: (
    ctx: Ctx,
    args: Args,
    result: Returns,
  ) => Promise<Returns> | Returns;
}

// ---------------------------------------------------------------------------
// builders()
// ---------------------------------------------------------------------------

export interface BuildersResult {
  /**
   * Mutation wrapper with remote: key support.
   * On remote Convex: runs handler, then remote (same tx), then schedules delta recording.
   * On local embedded runtime: runs handler only.
   */
  mutation: (definition: {
    args: Record<string, any>;
    returns?: any;
    handler: (ctx: any, args: any) => any;
    remote?: (ctx: any, args: any, result: any) => any;
  }) => any;

  /**
   * Query wrapper with remote: key support.
   * On remote Convex: runs handler, then remote with result.
   * On local embedded runtime: runs handler only.
   */
  query: (definition: {
    args: Record<string, any>;
    returns?: any;
    handler: (ctx: any, args: any) => any;
    remote?: (ctx: any, args: any, result: any) => any;
  }) => any;
}

/**
 * Creates mutation and query wrappers that support the `remote:` key
 * and automatically record Yjs deltas on the remote.
 *
 * @param components - The `components` object from the app's _generated/api.
 *   If components.resolve exists, we're on remote Convex.
 *   If it's absent, we're on local embedded runtime.
 * @param baseMutation - The base `mutation` builder from _generated/server.
 * @param baseQuery - The base `query` builder from _generated/server.
 */
export function builders(
  components: ComponentsMap,
  baseMutation?: any,
  baseQuery?: any,
): BuildersResult {
  const isRemote = !!components?.resolve;

  log.debug(`builders() initialized, isRemote=${isRemote}`);

  function wrapMutation(definition: {
    args: Record<string, any>;
    returns?: any;
    handler: (ctx: any, args: any) => any;
    remote?: (ctx: any, args: any, result: any) => any;
  }) {
    const { args, returns, handler, remote } = definition;

    // Build the actual Convex function definition
    const functionDef: any = {
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (ctx: any, fnArgs: any) => {
        // 1. Always run the handler
        const result = await handler(ctx, fnArgs);

        // 2. On remote, run the remote: block in the same transaction
        if (isRemote && remote) {
          await remote(ctx, fnArgs, result);
        }

        // Delta recording is handled by register().wrapMutation() at a
        // higher level — builders() is a generic wrapper and doesn't know
        // which table was touched.

        return result;
      },
    };

    // If we have a base builder, use it. Otherwise return raw definition.
    if (baseMutation) {
      return baseMutation(functionDef);
    }
    return functionDef;
  }

  function wrapQuery(definition: {
    args: Record<string, any>;
    returns?: any;
    handler: (ctx: any, args: any) => any;
    remote?: (ctx: any, args: any, result: any) => any;
  }) {
    const { args, returns, handler, remote } = definition;

    const functionDef: any = {
      args,
      ...(returns !== undefined ? { returns } : {}),
      handler: async (ctx: any, fnArgs: any) => {
        // 1. Always run the handler
        let result = await handler(ctx, fnArgs);

        // 2. On remote, run the remote: block with the result
        if (isRemote && remote) {
          result = await remote(ctx, fnArgs, result);
        }

        return result;
      },
    };

    if (baseQuery) {
      return baseQuery(functionDef);
    }
    return functionDef;
  }

  return {
    mutation: wrapMutation,
    query: wrapQuery,
  };
}
