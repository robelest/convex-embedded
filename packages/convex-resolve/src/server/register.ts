/**
 * register() — server-side entry point for convex-resolve.
 *
 * Generates the `resolve` action for a table and wires delta recording.
 *
 * Usage:
 *   import { register } from 'convex-resolve/server';
 *   import { components } from './_generated/api';
 *   import { taskSchema } from './schema/tasks';
 *
 *   export const { resolve } = register({
 *     table: 'tasks',
 *     schema: taskSchema,
 *     component: components.resolve,
 *     migrations: { 2: internal.migrations.tasksV2 },
 *   });
 */
import * as Y from "yjs";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Definition } from "./schema.js";
import { encodeDocumentState, computeDiff, isDiffEmpty } from "./schema.js";
import type { MigrationErrorHandler } from "../shared/types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("register");

/**
 * Safely convert a Uint8Array to a proper ArrayBuffer.
 * In some runtimes (e.g. edge-runtime used by convex-test), the
 * Uint8Array.buffer property doesn't return a native ArrayBuffer,
 * so we construct a fresh one and copy the bytes.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResolveComponentApi {
  public: {
    insertDelta: FunctionReference<"mutation">;
    getLatestDelta: FunctionReference<"query">;
    getLatestDeltas: FunctionReference<"query">;
    cleanup: FunctionReference<"mutation">;
  };
}

export interface RegisterConfig {
  /** Table name in convex/schema.ts */
  table: string;

  /** Versioned schema definition from schema.define() */
  schema: Definition;

  /** Convex component reference — required on remote, absent on local */
  component?: ResolveComponentApi;

  /** Per-version migration functions (keyed by target version number) */
  migrations?: Record<number, FunctionReference<"mutation">>;

  /** Error handler when a local migration fails */
  onMigrationError?: MigrationErrorHandler;
}

export interface RegisterResult {
  /**
   * One-shot catch-up action — client sends state vectors, receives diffs.
   * This is the function reference the consuming app exports.
   */
  resolve: {
    args: Record<string, any>;
    handler: (ctx: any, args: any) => Promise<any>;
  };

  /**
   * Internal mutation for recording a delta after an app mutation.
   * Called by wrapMutation via ctx.scheduler.runAfter(0, ...).
   * The consuming app must export this so the scheduler can reference it.
   */
  _recordDelta: {
    args: Record<string, any>;
    returns: any;
    handler: (ctx: any, args: any) => Promise<null>;
  };

  /**
   * Utility: wraps a mutation definition to schedule delta recording
   * after execution. The consuming app must pass the _recordDelta
   * function reference so the scheduler can call it.
   *
   * Usage:
   *   const { resolve, _recordDelta, wrapMutation } = register(config);
   *   export const create = wrapMutation(api.tasks._recordDelta, { ... });
   */
  wrapMutation: (
    recordDeltaRef: any,
    mutationDef: { args: Record<string, any>; handler: (ctx: any, args: any) => any; remote?: (ctx: any, args: any, result: any) => any },
  ) => { args: Record<string, any>; handler: (ctx: any, args: any) => any };
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

export function register(config: RegisterConfig): RegisterResult {
  const { table, schema: schemaDef, component } = config;
  const isRemote = !!component;

  log.info(`register() table="${table}" isRemote=${isRemote} version=${schemaDef.version}`);

  // -------------------------------------------------------------------------
  // _recordDelta — records a Yjs state snapshot to the component
  // -------------------------------------------------------------------------

  const _recordDelta = {
    args: {
      docId: v.string(),
    },
    returns: v.null(),
    handler: async (ctx: any, args: { docId: string }): Promise<null> => {
      if (!isRemote || !component) {
        // On local Concave — no-op
        return null;
      }

      try {
        // Read the current document from the main table
        const doc = await ctx.db.get(args.docId);
        if (!doc) {
          log.warn(`_recordDelta: document ${args.docId} not found in table "${table}"`);
          return null;
        }

        // Encode the full Yjs state from the document row
        const update = encodeDocumentState(schemaDef, doc);

        // Write to the component's deltas table
        await ctx.runMutation(component.public.insertDelta, {
          collection: table,
          docId: args.docId,
          update: toArrayBuffer(update),
        });

        log.debug(`_recordDelta: recorded delta for ${table}/${args.docId} (${update.byteLength} bytes)`);
      } catch (err) {
        log.error(`_recordDelta: failed for ${table}/${args.docId}`, err);
        // Don't throw — delta recording failures shouldn't break the app
      }

      return null;
    },
  };

  // -------------------------------------------------------------------------
  // resolve — one-shot catch-up action
  // -------------------------------------------------------------------------

  const resolve = {
    args: {
      documents: v.array(
        v.object({
          docId: v.string(),
          vector: v.bytes(),
        }),
      ),
    },
    handler: async (
      ctx: any,
      args: { documents: Array<{ docId: string; vector: ArrayBuffer }> },
    ): Promise<Array<{ docId: string; diff?: ArrayBuffer }>> => {
      if (!isRemote || !component) {
        // On local Concave — return empty diffs (no-op)
        return args.documents.map((d) => ({ docId: d.docId }));
      }

      const docIds = args.documents.map((d) => d.docId);

      // Batch fetch latest deltas from the component
      const latestDeltas = await ctx.runQuery(component.public.getLatestDeltas, {
        collection: table,
        docIds,
      });

      const results: Array<{ docId: string; diff?: ArrayBuffer }> = [];

      for (let i = 0; i < args.documents.length; i++) {
        const { docId, vector } = args.documents[i]!;
        const latest = latestDeltas[i];

        if (!latest) {
          // No delta recorded for this document — nothing to diff
          results.push({ docId });
          continue;
        }

        try {
          // Compute the diff between the server's state and the client's state vector
          const serverUpdate = new Uint8Array(latest.update);
          const clientVector = new Uint8Array(vector);
          const diff = computeDiff(serverUpdate, clientVector);

          if (isDiffEmpty(diff)) {
            // Client is up to date
            results.push({ docId });
          } else {
            results.push({ docId, diff: toArrayBuffer(diff) });
          }
        } catch (err) {
          log.error(`resolve: failed to compute diff for ${table}/${docId}`, err);
          results.push({ docId });
        }
      }

      return results;
    },
  };

  // -------------------------------------------------------------------------
  // wrapMutation — enhances a mutation to schedule delta recording
  // -------------------------------------------------------------------------

  function wrapMutation(
    recordDeltaRef: any,
    mutationDef: {
      args: Record<string, any>;
      handler: (ctx: any, args: any) => any;
      remote?: (ctx: any, args: any, result: any) => any;
    },
  ) {
    const { args, handler, remote } = mutationDef;

    return {
      args,
      handler: async (ctx: any, fnArgs: any) => {
        // 1. Run the handler
        const result = await handler(ctx, fnArgs);

        // 2. On remote, run the remote: block in the same transaction
        if (isRemote && remote) {
          await remote(ctx, fnArgs, result);
        }

        // 3. On remote, schedule _recordDelta as a separate transaction.
        //    This avoids OCC contention on the deltas sequence counter
        //    and keeps the app mutation fast.
        if (isRemote && recordDeltaRef && ctx.scheduler) {
          const docId = extractDocId(result, fnArgs);
          if (docId) {
            try {
              await ctx.scheduler.runAfter(0, recordDeltaRef, { docId });
            } catch (err) {
              log.warn(`wrapMutation: failed to schedule delta recording for ${table}`, err);
              // Don't throw — delta recording failures shouldn't break the mutation
            }
          }
        }

        return result;
      },
    };
  }

  return {
    resolve,
    _recordDelta,
    wrapMutation,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a document ID from mutation result or args.
 * Mutations that return an Id (insert) or receive one in args (patch/delete)
 * can be tracked automatically.
 */
function extractDocId(result: any, args: any): string | null {
  // If result is a string that looks like an ID, use it
  if (typeof result === "string") return result;

  // Check common arg patterns
  if (args?.id && typeof args.id === "string") return args.id;
  if (args?._id && typeof args._id === "string") return args._id;
  if (args?.docId && typeof args.docId === "string") return args.docId;

  return null;
}


