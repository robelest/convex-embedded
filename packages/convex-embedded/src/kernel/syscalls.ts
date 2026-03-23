import { Fx } from "@robelest/fx";
/**
 * Syscall routers for the embedded Convex runtime.
 *
 * Three routers matching the Convex backend interface:
 * - remote syscall   — queryStream, queryCleanup, normalizeId
 * - async syscall  — db ops, scheduling, actions, storage
 * - js syscall     — blob storage
 *
 * Ported from convex-test, refactored to accept explicit db/runner
 * parameters instead of relying on globals.
 */
import type { Value } from "convex/values";
import { convexToJson, jsonToConvex } from "convex/values";

import type { Database } from "@/core/database";
import type {
  DocumentId,
  QueryDependency,
  SerializedQuery,
} from "@/core/types";
import type { FunctionPath } from "@/kernel/module-loader";
import {
  resolveFunctionPath,
  createFunctionHandle,
} from "@/kernel/module-loader";

// ---------------------------------------------------------------------------
// RunUdfFn — the callback used to invoke nested queries/mutations/actions
// ---------------------------------------------------------------------------

export type RunUdfFn = (
  type: "query" | "mutation" | "action",
  path: FunctionPath,
  args: Record<string, unknown>,
  context?: { holdsTransactionLock?: boolean },
) => Promise<unknown>;

type JsonArgs = Record<string, unknown>;

type TaggedJsonSyscall = Readonly<{
  op: string;
  args: JsonArgs;
}>;

type TaggedJsSyscall = Readonly<{
  op: string;
  args: Record<string, unknown>;
}>;

type SyncSyscallHandler = (args: JsonArgs) => string;
type AsyncSyscallHandler = (args: JsonArgs) => Promise<string>;
type JsSyscallHandler = (args: Record<string, unknown>) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function blobSha(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return btoa(String.fromCharCode(...hashArray));
}

function decodeJsonSyscall(op: string, jsonArgs: string): TaggedJsonSyscall {
  return {
    op,
    args: JSON.parse(jsonArgs) as JsonArgs,
  };
}

function decodeJsSyscall(
  op: string,
  args: Record<string, unknown>,
): TaggedJsSyscall {
  return { op, args };
}

function extractQueryDependencies(query: unknown): QueryDependency[] {
  const current = query as SerializedQuery | undefined;
  const source = current?.source;
  if (!source) {
    return [];
  }
  if (source.type === "FullTableScan") {
    return [{ type: "FullTableScan", tableName: source.tableName }];
  }
  if (source.type === "IndexRange") {
    const [tableName, indexName] = source.indexName.split(".");
    return [
      {
        type: "IndexRange",
        tableName,
        indexName,
        range: source.range,
        order: source.order,
      },
    ];
  }
  if (source.type === "Search") {
    const [tableName, indexName] = source.indexName.split(".");
    return [
      {
        type: "Search",
        tableName,
        indexName,
        filters: source.filters,
      },
    ];
  }
  return [];
}

function unsupportedSyncSyscall(op: string): never {
  throw new Error(`\`convex-embedded\` does not support syscall: "${op}"`);
}

function unsupportedAsyncSyscall(op: string): never {
  throw new Error(
    `\`convex-embedded\` does not support async syscall: "${op}"`,
  );
}

function unsupportedJsSyscall(op: string): never {
  throw new Error(`\`convex-embedded\` does not support js syscall: "${op}"`);
}

function dispatchSyncSyscall(
  request: TaggedJsonSyscall,
  handlers: Record<string, SyncSyscallHandler>,
): string {
  const handler = handlers[request.op];
  return handler ? handler(request.args) : unsupportedSyncSyscall(request.op);
}

async function dispatchAsyncSyscall(
  request: TaggedJsonSyscall,
  handlers: Record<string, AsyncSyscallHandler>,
): Promise<string> {
  const handler = handlers[request.op];
  return handler
    ? await handler(request.args)
    : unsupportedAsyncSyscall(request.op);
}

async function dispatchJsSyscall(
  request: TaggedJsSyscall,
  handlers: Record<string, JsSyscallHandler>,
): Promise<unknown> {
  const handler = handlers[request.op];
  return handler
    ? await handler(request.args)
    : unsupportedJsSyscall(request.op);
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
  options?: { onDependency?: (dependency: QueryDependency) => void },
): (op: string, jsonArgs: string) => string {
  const handlers: Record<string, SyncSyscallHandler> = {
    "1.0/queryStream": (args) => {
      const { query } = args as { query: unknown };
      for (const dependency of extractQueryDependencies(query)) {
        options?.onDependency?.(dependency);
      }
      const queryId = db.startQuery(query);
      return JSON.stringify({ queryId });
    },
    "1.0/queryCleanup": () => {
      return JSON.stringify({});
    },
    "1.0/db/normalizeId": (args) => {
      const { table, idString } = args as { table: string; idString: string };
      const normalized = db.normalizeId(table, idString);
      return JSON.stringify({ id: normalized });
    },
  };

  return (op: string, jsonArgs: string): string =>
    dispatchSyncSyscall(decodeJsonSyscall(op, jsonArgs), handlers);
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
  options?: {
    getIdentity?: () => Promise<unknown>;
    /**
     * Optional set of active timer IDs. When provided, `setTimeout` calls
     * from the `1.0/schedule` syscall register their timer IDs here so the
     * runtime can clear them on shutdown (prevents leaked timers).
     */
    activeTimers?: Set<ReturnType<typeof setTimeout>>;
    onDependency?: (dependency: QueryDependency) => void;
  },
): (op: string, jsonArgs: string) => Promise<string> {
  const scheduleHandler: AsyncSyscallHandler = async (args) => {
    const {
      name,
      reference,
      functionHandle,
      args: fnArgs,
      ts: tsInSecs,
    } = args as {
      name?: string;
      reference?: unknown;
      functionHandle?: unknown;
      args: unknown;
      ts: number;
    };
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

    const timerId = setTimeout(
      () => {
        options?.activeTimers?.delete(timerId);

        Fx.detach(
          () =>
            Fx.run(
              Fx.gen(function* () {
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

                yield* Fx.bracket(
                  Fx.sync(() => db.startTransaction()),
                  () =>
                    Fx.sync(() => {
                      db.patch("_scheduled_functions", jobId, {
                        state: { kind: "inProgress" },
                      });
                    }),
                  () =>
                    Fx.sync(() => {
                      db.commit();
                    }),
                );

                const finalState: string = yield* Fx.from({
                  ok: () => runUdf("mutation", functionPath, parsedArgs),
                  err: (e) => e,
                }).pipe(
                  Fx.fold({
                    ok: () => "success" as string,
                    err: (error) => {
                      console.error(
                        `Error when running scheduled function ${functionPath.udfPath}`,
                        error,
                      );
                      return "failed" as string;
                    },
                  }),
                );

                const finishedJob = db.get("_scheduled_functions", jobId);
                const finishedState = finishedJob?.state as {
                  kind: string;
                } | null;

                if (
                  finalState === "failed" ||
                  (finishedJob !== null && finishedState?.kind === "inProgress")
                ) {
                  yield* Fx.bracket(
                    Fx.sync(() => db.startTransaction()),
                    () =>
                      Fx.sync(() => {
                        db.patch("_scheduled_functions", jobId, {
                          state: { kind: finalState },
                          ...(finalState === "failed"
                            ? { completedTime: Date.now() }
                            : {}),
                        });
                      }),
                    () =>
                      Fx.sync(() => {
                        db.commit();
                      }),
                  );
                }

                const dbExt = db as unknown as Record<string, unknown>;
                if (typeof dbExt.jobFinished === "function") {
                  (dbExt.jobFinished as (id: string) => void)(jobId);
                }
              }),
            ),
          `[convex-embedded] scheduled function ${functionPath.udfPath}:`,
        );
      },
      Math.max(0, tsInSecs * 1000 - Date.now()),
    );
    options?.activeTimers?.add(timerId);

    return JSON.stringify(convexToJson(jobId));
  };

  const cancelJobHandler: AsyncSyscallHandler = async (args) => {
    const { id } = args as { id: string };
    db.patch("_scheduled_functions", id, { state: { kind: "canceled" } });
    return JSON.stringify({});
  };

  const actionHandler =
    (type: "query" | "mutation" | "action"): AsyncSyscallHandler =>
    async (args) => {
      const { name, args: udfArgs } = args as {
        name: string;
        args: Record<string, unknown>;
      };
      const functionPath = resolveFunctionPath({ name });
      const result = await runUdf(type, functionPath, udfArgs);
      return JSON.stringify(convexToJson(result as Value));
    };

  const handlers: Record<string, AsyncSyscallHandler> = {
    "1.0/get": async (args) => {
      const { table, id } = args as { table: string; id: string };
      options?.onDependency?.({ type: "FullTableScan", tableName: table });
      const doc = db.get(table, id);
      return JSON.stringify(convexToJson(doc));
    },
    "1.0/queryStreamNext": async (args) => {
      const { queryId } = args as { queryId: number };
      const { value, done } = db.queryNext(queryId);
      return JSON.stringify(convexToJson({ value, done }));
    },
    "1.0/queryPage": async (args) => {
      const { query, cursor, pageSize } = args as {
        query: unknown;
        cursor: string | null;
        pageSize: number;
      };
      for (const dependency of extractQueryDependencies(query)) {
        options?.onDependency?.(dependency);
      }
      const { page, isDone, continueCursor } = db.paginate({
        query: query as any,
        cursor,
        pageSize,
      });
      return JSON.stringify(convexToJson({ page, isDone, continueCursor }));
    },
    "1.0/insert": async (args) => {
      const { table, value } = args as { table: string; value: unknown };
      const _id = db.insert(
        table,
        jsonToConvex(value) as Record<string, unknown>,
      );
      return JSON.stringify({ _id });
    },
    "1.0/shallowMerge": async (args) => {
      const { table, id, value } = args as {
        table: string;
        id: string;
        value: Record<string, unknown>;
      };
      db.patch(table, id, value);
      return JSON.stringify({});
    },
    "1.0/replace": async (args) => {
      const { table, id, value } = args as {
        table: string;
        id: string;
        value: Record<string, unknown>;
      };
      db.replace(table, id, value);
      return JSON.stringify({});
    },
    "1.0/remove": async (args) => {
      const { table, id } = args as { table: string; id: string };
      db.delete(table, id);
      return JSON.stringify({});
    },
    "1.0/count": async (args) => {
      const { table } = args as { table: string };
      options?.onDependency?.({ type: "FullTableScan", tableName: table });
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
    },
    "1.0/getUserIdentity": async () => {
      if (options?.getIdentity) {
        const identity = await options.getIdentity();
        return JSON.stringify(identity);
      }
      return JSON.stringify(null);
    },
    "1.0/schedule": scheduleHandler,
    "1.0/cancel_job": cancelJobHandler,
    "1.0/actions/query": actionHandler("query"),
    "1.0/actions/mutation": actionHandler("mutation"),
    "1.0/actions/action": actionHandler("action"),
    "1.0/actions/schedule": scheduleHandler,
    "1.0/actions/cancel_job": cancelJobHandler,
    "1.0/actions/vectorSearch": async (args) => {
      const {
        query: { indexName, limit, vector, expressions },
      } = args as {
        query: {
          indexName: string;
          limit: number;
          vector: number[];
          expressions: unknown;
        };
      };
      const results = db.vectorSearch(
        indexName,
        vector,
        expressions === null ? [] : [expressions as any],
        limit,
      );
      options?.onDependency?.({
        type: "IndexRange",
        tableName: indexName.split(".")[0] ?? indexName,
        indexName: indexName.split(".")[1] ?? indexName,
        range: expressions === null ? [] : ([expressions] as any),
        order: "desc",
      });
      return JSON.stringify(convexToJson({ results }));
    },
    "1.0/runUdf": async (args) => {
      const {
        udfType,
        name,
        reference,
        functionHandle,
        args: udfArgsJson,
      } = args as {
        udfType: string;
        name?: string;
        reference?: unknown;
        functionHandle?: unknown;
        args: unknown;
      };
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
    },
    "1.0/createFunctionHandle": async (args) => {
      const { name, reference, functionHandle } = args as {
        name?: string;
        reference?: unknown;
        functionHandle?: unknown;
      };
      const functionPath = resolveFunctionPath({
        name,
        reference,
        functionHandle,
      });
      const handle = createFunctionHandle(functionPath);
      return JSON.stringify(handle);
    },
    "1.0/storageDelete": async (args) => {
      const { storageId } = args as { storageId: string };
      db.delete("_storage", storageId);
      db.deleteBlob(storageId);
      return JSON.stringify({});
    },
    "1.0/storageGetUrl": async (args) => {
      const { storageId } = args as { storageId: string };
      const metadata = db.get("_storage", storageId);
      if (metadata === null) {
        return JSON.stringify(null);
      }
      const { sha256 } = metadata;
      const url =
        "https://some-deployment.convex.cloud/api/storage/" +
        (sha256 as string);
      return JSON.stringify(convexToJson(url));
    },
    "1.0/storageGenerateUploadUrl": async () => {
      const url =
        "https://some-deployment.convex.cloud/api/storage/upload?token=" +
        Math.random();
      return JSON.stringify(convexToJson(url));
    },
    "1.0/storageGetMetadata": async (args) => {
      const { storageId } = args as { storageId: string };
      const doc = db.get("_storage", storageId);
      if (doc === null) {
        return JSON.stringify(null);
      }
      return JSON.stringify({
        storageId,
        sha256: doc.sha256,
        size: doc.size,
        contentType: doc.contentType,
      });
    },
  };

  const self = async (op: string, jsonArgs: string): Promise<string> =>
    dispatchAsyncSyscall(decodeJsonSyscall(op, jsonArgs), handlers);

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
  const handlers: Record<string, JsSyscallHandler> = {
    "storage/storeBlob": async (args) => {
      const { blob } = args as { blob: Blob };
      const storageId = db.insert("_storage", {
        size: blob.size,
        sha256: await blobSha(blob),
        contentType: blob.type || undefined,
      });
      db.storeFile(storageId, blob);
      return storageId;
    },
    "storage/getBlob": async (args) => {
      const { storageId } = args as { storageId: DocumentId };
      return db.getFile(storageId);
    },
  };

  return async (
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    return await dispatchJsSyscall(decodeJsSyscall(op, args), handlers);
  };
}
