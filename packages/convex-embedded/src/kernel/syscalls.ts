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
import type { JSONValue, Value } from "convex/values";
import { ConvexError, convexToJson, jsonToConvex } from "convex/values";

import type { FunctionPath } from "@/kernel/modules";
import { resolveFunctionPath, createFunctionHandle } from "@/kernel/modules";
import {
  blobShaBase64,
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import type { Database } from "@/runtime/db/database";
import type {
  DocumentId,
  QueryDependency,
  SerializedQuery,
  VectorSearchExpression,
} from "@/runtime/db/types";
import type { StoreMigrationManifest } from "@/runtime/migrations/types";
import {
  missingStorageSurfaceError,
  type StorageSurface,
} from "@/runtime/storage";

export const STORAGE_METADATA_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "storageMetadata",
  scope: "global",
  version: 1,
};

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

function dispatchSyncSyscall(
  request: TaggedJsonSyscall,
  handlers: Record<string, SyncSyscallHandler>,
): string {
  const handler = handlers[request.op];
  if (handler) {
    return handler(request.args);
  }

  throw new ConvexError({
    code: "LOCAL_SYSCALL_UNSUPPORTED",
    message:
      `[convex-embedded] Local execution does not support syscall "${request.op}" in alpha. ` +
      "Use route.remote() or mark the caller remoteOnly().",
    op: request.op,
    kind: "sync",
  });
}

async function dispatchAsyncSyscall(
  request: TaggedJsonSyscall,
  handlers: Record<string, AsyncSyscallHandler>,
): Promise<string> {
  const handler = handlers[request.op];
  if (handler) {
    return await handler(request.args);
  }

  throw new ConvexError({
    code: "LOCAL_SYSCALL_UNSUPPORTED",
    message:
      `[convex-embedded] Local execution does not support async syscall "${request.op}" in alpha. ` +
      "Use route.remote() or mark the caller remoteOnly().",
    op: request.op,
    kind: "async",
  });
}

async function dispatchJsSyscall(
  request: TaggedJsSyscall,
  handlers: Record<string, JsSyscallHandler>,
): Promise<unknown> {
  const handler = handlers[request.op];
  if (handler) {
    return await handler(request.args);
  }

  throw new ConvexError({
    code: "LOCAL_SYSCALL_UNSUPPORTED",
    message:
      `[convex-embedded] Local execution does not support js syscall "${request.op}" in alpha. ` +
      "Use route.remote() or mark the caller remoteOnly().",
    op: request.op,
    kind: "js",
  });
}

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
      const queryId = db.startQueryAsync(query as SerializedQuery);
      return JSON.stringify({ queryId });
    },
    "1.0/queryCleanup": (args) => {
      const { queryId } = args as { queryId: number };
      db.queryCleanup(queryId);
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
    getStorageSurface?: () => StorageSurface | null;
    /**
     * Optional set of active timer IDs. When provided, `setTimeout` calls
     * from the `1.0/schedule` syscall register their timer IDs here so the
     * runtime can clear them on shutdown (prevents leaked timers).
     */
    activeTimers?: Set<ReturnType<typeof setTimeout>>;
    onDependency?: (dependency: QueryDependency) => void;
  },
): (op: string, jsonArgs: string) => Promise<string> {
  const resolveTableForWrite = async (
    database: Database,
    table: string | undefined,
    id: string,
  ): Promise<string> => {
    if (table !== undefined) {
      return table;
    }
    const fromMap = database.getTableForId(id);
    if (fromMap !== undefined) {
      return fromMap;
    }
    await database.getAsync(undefined, id as DocumentId);
    const afterProbe = database.getTableForId(id);
    if (afterProbe !== undefined) {
      return afterProbe;
    }
    throw new Error(
      `[convex-embedded] cannot resolve table for document id "${id}" — load the document first or pass the table name explicitly.`,
    );
  };

  const scheduleHandler: AsyncSyscallHandler = async (args) => {
    const {
      name,
      reference,
      functionHandle,
      args: fnArgs,
      ts: tsInSecs,
    } = args as {
      name?: string;
      reference?: string;
      functionHandle?: string;
      args: unknown;
      ts: number;
    };
    const functionPath = resolveFunctionPath({
      name,
      reference,
      functionHandle,
    });
    const parsedArgs = jsonToConvex(fnArgs as JSONValue) as Record<
      string,
      unknown
    >;
    const jobId = db.insert("_scheduled_functions", {
      args: [parsedArgs],
      name: functionPath.udfPath,
      scheduledTime: tsInSecs * 1000,
      state: { kind: "pending" },
    });

    const timerId = setTimeout(
      () => {
        options?.activeTimers?.delete(timerId);

        void (async () => {
          try {
            db.startTransaction();
            try {
              const job = db.get("_scheduled_functions", jobId);
              const jobState = job?.state as { kind: string } | null;
              if (job === null || jobState?.kind === "canceled") {
                db.rollbackWrites();
                return;
              }
              if (jobState?.kind !== "pending") {
                db.rollbackWrites();
                throw new Error(
                  `\`convex-embedded\` invariant error: Unexpected scheduled function state when starting it: ${jobState?.kind}`,
                );
              }

              db.patch("_scheduled_functions", jobId, {
                state: { kind: "inProgress" },
              });
              await db.commitAsync();
            } catch (error) {
              db.rollbackWrites();
              throw error;
            }

            let finalState: string;
            try {
              await runUdf("mutation", functionPath, parsedArgs);
              finalState = "success";
            } catch (error) {
              console.error(
                `Error when running scheduled function ${functionPath.udfPath}`,
                error,
              );
              finalState = "failed";
            }

            db.startTransaction();
            try {
              const finishedJob = db.get("_scheduled_functions", jobId);
              const finishedState = finishedJob?.state as {
                kind: string;
              } | null;

              if (
                finalState === "failed" ||
                (finishedJob !== null && finishedState?.kind === "inProgress")
              ) {
                db.patch("_scheduled_functions", jobId, {
                  state: { kind: finalState },
                  ...(finalState === "failed"
                    ? { completedTime: Date.now() }
                    : {}),
                });
                await db.commitAsync();
              } else {
                db.rollbackWrites();
              }
            } catch (error) {
              db.rollbackWrites();
              throw error;
            }

            const dbExt = db as unknown as Record<string, unknown>;
            if (typeof dbExt.jobFinished === "function") {
              (dbExt.jobFinished as (id: string) => void)(jobId);
            }
          } catch (error) {
            console.error(
              `[convex-embedded] scheduled function ${functionPath.udfPath}:`,
              error,
            );
          }
        })();
      },
      Math.max(0, tsInSecs * 1000 - Date.now()),
    );
    options?.activeTimers?.add(timerId);

    return JSON.stringify(convexToJson(jobId));
  };

  const cancelJobHandler: AsyncSyscallHandler = async (args) => {
    const { id } = args as { id: string };
    db.patch("_scheduled_functions", id as DocumentId, {
      state: { kind: "canceled" },
    });
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
      const { table, id } = args as { table: string | undefined; id: string };
      const resolvedTable = table ?? db.getTableForId(id);
      const doc = await db.getAsync(resolvedTable, id as DocumentId);
      const dependencyTable = resolvedTable ?? db.getTableForId(id);
      if (dependencyTable !== undefined) {
        options?.onDependency?.({
          type: "DocumentRead",
          tableName: dependencyTable,
          id,
        });
      }
      return JSON.stringify(convexToJson(doc));
    },
    "1.0/queryStreamNext": async (args) => {
      const { queryId } = args as { queryId: number };
      const { value, done } = await db.queryNextAsync(queryId);
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
      const { page, isDone, continueCursor } = await db.paginateAsync({
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
        jsonToConvex(value as JSONValue) as Record<string, unknown>,
      );
      return JSON.stringify({ _id });
    },
    "1.0/shallowMerge": async (args) => {
      const { table, id, value } = args as {
        table: string | undefined;
        id: string;
        value: Record<string, unknown>;
      };
      const resolvedTable = await resolveTableForWrite(db, table, id);
      await db.ensureCommittedDocumentForWrite(resolvedTable, id as DocumentId);
      db.patch(resolvedTable, id as DocumentId, value);
      return JSON.stringify({});
    },
    "1.0/replace": async (args) => {
      const { table, id, value } = args as {
        table: string | undefined;
        id: string;
        value: Record<string, unknown>;
      };
      const resolvedTable = await resolveTableForWrite(db, table, id);
      await db.ensureCommittedDocumentForWrite(resolvedTable, id as DocumentId);
      db.replace(resolvedTable, id as DocumentId, value);
      return JSON.stringify({});
    },
    "1.0/remove": async (args) => {
      const { table, id } = args as { table: string | undefined; id: string };
      const resolvedTable = await resolveTableForWrite(db, table, id);
      await db.ensureCommittedDocumentForWrite(resolvedTable, id as DocumentId);
      db.delete(resolvedTable, id as DocumentId);
      return JSON.stringify({});
    },
    "1.0/count": async (args) => {
      const { table } = args as { table: string };
      options?.onDependency?.({ type: "FullTableScan", tableName: table });
      return JSON.stringify(await db.countAsync(table));
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
          limit?: number;
          vector: number[];
          expressions: unknown;
        };
      };
      const results = await db.vectorSearchAsync(
        indexName,
        vector,
        (expressions as VectorSearchExpression | null) ?? null,
        limit,
      );
      options?.onDependency?.({
        type: "VectorSearch",
        tableName: indexName.split(".")[0] ?? indexName,
        indexName: indexName.split(".")[1] ?? indexName,
        filter: (expressions as VectorSearchExpression | null) ?? null,
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
        reference?: string;
        functionHandle?: string;
        args: unknown;
      };
      const udfArgs = jsonToConvex(udfArgsJson as JSONValue) as Record<
        string,
        unknown
      >;
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
      throw new ConvexError({
        code: "NESTED_UDF_TYPE_UNSUPPORTED",
        message:
          `[convex-embedded] Local execution does not support nested udf type "${udfType}" in alpha. ` +
          "Use route.remote() or mark the caller remoteOnly().",
        udfType,
      });
    },
    "1.0/createFunctionHandle": async (args) => {
      const { name, reference, functionHandle } = args as {
        name?: string;
        reference?: string;
        functionHandle?: string;
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
      db.delete("_storage", storageId as DocumentId);
      db.deleteBlob(storageId);
      return JSON.stringify({});
    },
    "1.0/storageGetUrl": async (args) => {
      const { storageId } = args as { storageId: string };
      const metadata = db.get("_storage", storageId as DocumentId);
      if (metadata === null) {
        return JSON.stringify(null);
      }
      const surface = options?.getStorageSurface?.();
      if (surface === null || surface === undefined) {
        throw missingStorageSurfaceError("getUrl");
      }
      const url = await surface.getUrl(storageId);
      return JSON.stringify(convexToJson(url));
    },
    "1.0/storageGenerateUploadUrl": async () => {
      const surface = options?.getStorageSurface?.();
      if (surface === null || surface === undefined) {
        throw missingStorageSurfaceError("generateUploadUrl");
      }
      const url = await surface.generateUploadUrl();
      return JSON.stringify(convexToJson(url));
    },
    "1.0/storageGetMetadata": async (args) => {
      const { storageId } = args as { storageId: string };
      const doc = db.get("_storage", storageId as DocumentId);
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

/**
 * Create the JS syscall router for blob storage.
 *
 * Handles:
 * - `storage/storeBlob`
 * - `storage/getBlob`
 */
export interface JsSyscallOptions {
  /**
   * Returns the active identity key for the current request, used to
   * partition upload-queue rows. Defaults to `null` (anonymous).
   */
  getIdentityKey?: () => string | null;
  /**
   * When `true`, `storage/storeBlob` also writes a row into
   * `_resolve_pending_uploads` so the engine can replay the upload to the
   * remote deployment on reconnect. Set when a sync engine is configured.
   */
  shouldQueueUploads?: () => boolean;
}

export function createJsSyscall(
  db: Database,
  crypto: EmbeddedCryptoProvider = createAmbientCryptoProvider(),
  options: JsSyscallOptions = {},
): (op: string, args: Record<string, unknown>) => Promise<unknown> {
  const handlers: Record<string, JsSyscallHandler> = {
    "storage/storeBlob": async (args) => {
      const { blob } = args as { blob: Blob };
      const sha256 = await blobShaBase64(blob, crypto);
      const contentType = blob.type || undefined;
      const storageId = db.insert("_storage", {
        size: blob.size,
        sha256,
        contentType,
      });
      await db.storeFile(storageId, blob);
      if (options.shouldQueueUploads?.() === true) {
        db.insert("_resolve_pending_uploads", {
          localStorageId: String(storageId),
          sha256,
          size: blob.size,
          contentType: contentType ?? "application/octet-stream",
          identityKey: options.getIdentityKey?.() ?? null,
          state: "pending" as const,
          owner: { $undefined: true },
          processingStartedAt: { $undefined: true },
          leaseExpiresAt: { $undefined: true },
          createdAt: Date.now(),
        });
      }
      return storageId;
    },
    "storage/getBlob": async (args) => {
      const { storageId } = args as { storageId: DocumentId };
      return await db.loadFile(storageId);
    },
  };

  return async (
    op: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    return await dispatchJsSyscall(decodeJsSyscall(op, args), handlers);
  };
}
