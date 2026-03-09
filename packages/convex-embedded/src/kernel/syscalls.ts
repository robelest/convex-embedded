/**
 * Syscall routers for the embedded Convex runtime.
 *
 * Three routers matching the Convex backend interface:
 * - sync syscall   — queryStream, queryCleanup, normalizeId
 * - async syscall  — db ops, scheduling, actions, storage
 * - js syscall     — blob storage
 *
 * Ported from convex-test, refactored to accept explicit db/runner
 * parameters instead of relying on globals.
 */
import type { Value } from "convex/values";
import { convexToJson, jsonToConvex } from "convex/values";

import type { FunctionPath } from "$/kernel/module-loader";
import {
  resolveFunctionPath,
  createFunctionHandle,
} from "$/kernel/module-loader";

import type { Database } from "$/core/database";
import type { DocumentId } from "$/core/types";

// ---------------------------------------------------------------------------
// RunUdfFn — the callback used to invoke nested queries/mutations/actions
// ---------------------------------------------------------------------------

export type RunUdfFn = (
  type: "query" | "mutation" | "action",
  path: FunctionPath,
  args: Record<string, unknown>,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function blobSha(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return btoa(String.fromCharCode(...hashArray));
}

// ---------------------------------------------------------------------------
// Sync syscall
// ---------------------------------------------------------------------------

/**
 * Create the synchronous syscall router.
 *
 * Handles:
 * - `1.0/queryStream`
 * - `1.0/queryCleanup`
 * - `1.0/db/normalizeId`
 */
export function createSyncSyscall(
  db: Database,
): (op: string, jsonArgs: string) => string {
  return (op: string, jsonArgs: string): string => {
    const args = JSON.parse(jsonArgs);
    switch (op) {
      case "1.0/queryStream": {
        const { query } = args;
        const queryId = db.startQuery(query);
        return JSON.stringify({ queryId });
      }
      case "1.0/queryCleanup": {
        return JSON.stringify({});
      }
      case "1.0/db/normalizeId": {
        const idString: string = args.idString;
        const isInTable = idString.endsWith(`;${args.table}`);
        return JSON.stringify({
          id: isInTable ? idString : null,
        });
      }
      default: {
        throw new Error(
          `\`convex-embedded\` does not support syscall: "${op}"`,
        );
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Async syscall
// ---------------------------------------------------------------------------

/**
 * Create the asynchronous syscall router.
 *
 * Handles all database reads/writes, scheduling, action delegation,
 * storage operations, nested UDF invocation, and auth identity lookup.
 *
 * @param db       Database instance for reads/writes.
 * @param runUdf   Callback for nested UDF invocation.
 * @param options  Optional configuration.
 * @param options.getIdentity  Returns the current user identity (if any).
 *                             Called by `1.0/getUserIdentity` syscall.
 */
export function createAsyncSyscall(
  db: Database,
  runUdf: RunUdfFn,
  options?: { getIdentity?: () => Promise<unknown> },
): (op: string, jsonArgs: string) => Promise<string> {
  const self = async (op: string, jsonArgs: string): Promise<string> => {
    const args = JSON.parse(jsonArgs);
    switch (op) {
      // ----- Document reads -----

      case "1.0/get": {
        const { table, id } = args;
        const doc = db.get(table, id);
        return JSON.stringify(convexToJson(doc));
      }
      case "1.0/queryStreamNext": {
        const { value, done } = db.queryNext(args.queryId);
        return JSON.stringify(convexToJson({ value, done }));
      }
      case "1.0/queryPage": {
        const { query, cursor, pageSize } = args;
        const { page, isDone, continueCursor } = db.paginate({
          query,
          cursor,
          pageSize,
        });
        return JSON.stringify(convexToJson({ page, isDone, continueCursor }));
      }

      // ----- Document writes -----

      case "1.0/insert": {
        const _id = db.insert(args.table, jsonToConvex(args.value) as Record<string, unknown>);
        return JSON.stringify({ _id });
      }
      case "1.0/shallowMerge": {
        const { table, id, value } = args;
        db.patch(table, id, value);
        return JSON.stringify({});
      }
      case "1.0/replace": {
        const { table, id, value } = args;
        db.replace(table, id, value);
        return JSON.stringify({});
      }
      case "1.0/remove": {
        const { table, id } = args;
        db.delete(table, id);
        return JSON.stringify({});
      }

      // ----- Count -----

      case "1.0/count": {
        const { table } = args;
        const queryId = db.startQuery({
          source: { type: "FullTableScan", tableName: table, order: "asc" },
          operators: [],
        });
        let count = 0;
        while (true) {
          const result = db.queryNext(queryId);
          if (result.done) {
            break;
          }
          count += 1;
        }
        return JSON.stringify(count);
      }

      // ----- Auth -----

      case "1.0/getUserIdentity": {
        // The SDK's setupAuth calls this to get the current user identity.
        if (options?.getIdentity) {
          const identity = await options.getIdentity();
          return JSON.stringify(identity);
        }
        return JSON.stringify(null);
      }

      // ----- Scheduling -----

      case "1.0/schedule": {
        const {
          name,
          reference,
          functionHandle,
          args: fnArgs,
          ts: tsInSecs,
        } = args;
        const functionPath = resolveFunctionPath({
          name,
          reference,
          functionHandle,
        });
        const parsedArgs = jsonToConvex(fnArgs) as Record<string, unknown>;
        const jobId = db.insert("_scheduled_functions", {
          args: [parsedArgs],
          name: functionPath.udfPath,
          scheduledTime: tsInSecs * 1000,
          state: { kind: "pending" },
        });

        // Fire-and-forget: execute the scheduled function after the delay
        setTimeout(
          (async () => {
            // Check if canceled before running
            const job = db.get("_scheduled_functions", jobId);
            const jobState = job?.state as { kind: string } | null;
            if (job === null || jobState?.kind === "canceled") {
              return;
            }
            if (jobState?.kind !== "pending") {
              throw new Error(
                `\`convex-embedded\` invariant error: Unexpected scheduled function state when starting it: ${jobState?.kind}`,
              );
            }
            db.patch("_scheduled_functions", jobId, {
              state: { kind: "inProgress" },
            });

            try {
              await runUdf("mutation", functionPath, parsedArgs);
            } catch (error) {
              console.error(
                `Error when running scheduled function ${functionPath.udfPath}`,
                error,
              );
              db.patch("_scheduled_functions", jobId, {
                state: { kind: "failed" },
                completedTime: Date.now(),
              });
              // Notify if the db supports job completion callbacks
              const dbExt1 = db as unknown as Record<string, unknown>;
              if (typeof dbExt1.jobFinished === "function") {
                (dbExt1.jobFinished as (id: string) => void)(jobId);
              }
              return;
            }

            const finishedJob = db.get("_scheduled_functions", jobId);
            const finishedState = finishedJob?.state as { kind: string } | null;
            if (
              finishedJob !== null &&
              finishedState?.kind === "inProgress"
            ) {
              db.patch("_scheduled_functions", jobId, {
                state: { kind: "success" },
              });
            }
            // Notify if the db supports job completion callbacks
            const dbExt2 = db as unknown as Record<string, unknown>;
            if (typeof dbExt2.jobFinished === "function") {
              (dbExt2.jobFinished as (id: string) => void)(jobId);
            }
          }) as () => void,
          Math.max(0, tsInSecs * 1000 - Date.now()),
        );

        return JSON.stringify(convexToJson(jobId));
      }

      case "1.0/cancel_job": {
        const { id } = args;
        db.patch("_scheduled_functions", id, { state: { kind: "canceled" } });
        return JSON.stringify({});
      }

      // ----- Action delegates (ctx.runQuery, ctx.runMutation, etc.) -----

      case "1.0/actions/query": {
        const { name, args: queryArgs } = args;
        const functionPath = resolveFunctionPath({ name });
        const result = await runUdf("query", functionPath, queryArgs as Record<string, unknown>);
        return JSON.stringify(convexToJson(result as Value));
      }
      case "1.0/actions/mutation": {
        const { name, args: mutationArgs } = args;
        const functionPath = resolveFunctionPath({ name });
        const result = await runUdf("mutation", functionPath, mutationArgs as Record<string, unknown>);
        return JSON.stringify(convexToJson(result as Value));
      }
      case "1.0/actions/action": {
        const { name, args: actionArgs } = args;
        const functionPath = resolveFunctionPath({ name });
        const result = await runUdf("action", functionPath, actionArgs as Record<string, unknown>);
        return JSON.stringify(convexToJson(result as Value));
      }

      case "1.0/actions/schedule": {
        // Delegate to the mutation-context schedule syscall
        return await self("1.0/schedule", jsonArgs);
      }
      case "1.0/actions/cancel_job": {
        return await self("1.0/cancel_job", jsonArgs);
      }
      case "1.0/actions/vectorSearch": {
        const {
          query: { indexName, limit, vector, expressions },
        } = args;
        const results = db.vectorSearch(
          indexName,
          vector,
          // Convex sends expressions as a single expression, not an array
          expressions === null ? [] : [expressions],
          limit,
        );
        return JSON.stringify(convexToJson({ results }));
      }

      // ----- Nested UDF invocation (from queries/mutations) -----

      case "1.0/runUdf": {
        const {
          udfType,
          name,
          reference,
          functionHandle,
          args: udfArgsJson,
        } = args;
        const udfArgs = jsonToConvex(udfArgsJson) as Record<string, unknown>;
        const functionPath = resolveFunctionPath({
          name,
          reference,
          functionHandle,
        });
        if (udfType === "query") {
          const result = await runUdf("query", functionPath, udfArgs);
          return JSON.stringify(convexToJson(result as Value));
        }
        if (udfType === "mutation") {
          const result = await runUdf("mutation", functionPath, udfArgs);
          return JSON.stringify(convexToJson(result as Value));
        }
        throw new Error(
          `\`convex-embedded\` does not support udf type: "${udfType}"`,
        );
      }

      case "1.0/createFunctionHandle": {
        const { name, reference, functionHandle } = args;
        const functionPath = resolveFunctionPath({
          name,
          reference,
          functionHandle,
        });
        const handle = createFunctionHandle(functionPath);
        return JSON.stringify(handle);
      }

      // ----- Storage -----

      case "1.0/storageDelete": {
        const { storageId } = args;
        db.delete("_storage", storageId);
        return JSON.stringify({});
      }
      case "1.0/storageGetUrl": {
        const { storageId } = args;
        const metadata = db.get("_storage", storageId);
        if (metadata === null) {
          return JSON.stringify(null);
        }
        const { sha256 } = metadata;
        const url =
          "https://some-deployment.convex.cloud/api/storage/" +
          (sha256 as string);
        return JSON.stringify(convexToJson(url));
      }
      case "1.0/storageGenerateUploadUrl": {
        const url =
          "https://some-deployment.convex.cloud/api/storage/upload?token=" +
          Math.random();
        return JSON.stringify(convexToJson(url));
      }

      default: {
        throw new Error(
          `\`convex-embedded\` does not support async syscall: "${op}"`,
        );
      }
    }
  };

  return self;
}

// ---------------------------------------------------------------------------
// JS syscall (blob storage)
// ---------------------------------------------------------------------------

/**
 * Create the JS syscall router for blob storage.
 *
 * Handles:
 * - `storage/storeBlob`
 * - `storage/getBlob`
 */
export function createJsSyscall(
  db: Database,
): (op: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (op) {
      case "storage/storeBlob": {
        const { blob } = args as { blob: Blob };
        const storageId = db.insert("_storage", {
          size: blob.size,
          sha256: await blobSha(blob),
        });
        db.storeFile(storageId, blob);
        return storageId;
      }
      case "storage/getBlob": {
        const { storageId } = args as { storageId: DocumentId };
        return db.getFile(storageId);
      }
      default: {
        throw new Error(
          `\`convex-embedded\` does not support js syscall: "${op}"`,
        );
      }
    }
  };
}
