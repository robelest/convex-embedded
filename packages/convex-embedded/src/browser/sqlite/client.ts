import type {
  WorkerMethod,
  WorkerRequestMap,
  WorkerResultMap,
  StorageWorkerRequest,
  StorageWorkerResponse,
} from "@/browser/sqlite/protocol";
import { createLogger } from "@/shared/logger";
import { recordHistogram } from "@/tracing/metrics";

const log = createLogger("browser-sqlite");

const SLOW_WORKER_OP_MS = 100;

const WRITE_METHODS: ReadonlySet<WorkerMethod> = new Set<WorkerMethod>([
  "execute",
  "executeBatch",
  "commit",
  "storeBlob",
  "deleteBlob",
  "clear",
]);

function laneFor(method: WorkerMethod): "read" | "write" | "control" {
  if (WRITE_METHODS.has(method)) return "write";
  if (method === "init" || method === "close") return "control";
  return "read";
}

export interface BrowserSqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  executeBatch(
    statements: Array<{ sql: string; params?: unknown[] }>,
  ): Promise<void>;
  getDocuments(): Promise<WorkerResultMap["getDocuments"]>;
  getDocumentsByTable(
    tableName: string,
  ): Promise<WorkerResultMap["getDocumentsByTable"]>;
  hasAnyDocuments(
    tableName: string,
  ): Promise<WorkerResultMap["hasAnyDocuments"]>;
  listDocuments(tableName: string): Promise<WorkerResultMap["listDocuments"]>;
  readSource(
    source: WorkerRequestMap["readSource"]["source"],
    options?: WorkerRequestMap["readSource"]["options"],
  ): Promise<WorkerResultMap["readSource"]>;
  readQuery(
    args: WorkerRequestMap["readQuery"],
  ): Promise<WorkerResultMap["readQuery"]>;
  getDocument(
    tableName: string,
    id: string,
  ): Promise<WorkerResultMap["getDocument"]>;
  countDocuments(tableName: string): Promise<WorkerResultMap["countDocuments"]>;
  getMeta(): Promise<WorkerResultMap["getMeta"]>;
  getBlobs(): Promise<WorkerResultMap["getBlobs"]>;
  getBlob(id: string): Promise<WorkerResultMap["getBlob"]>;
  commit(batch: WorkerRequestMap["commit"]["batch"]): Promise<void>;
  /**
   * Transfers ownership of `data` to the worker thread for zero-copy writes.
   * Callers must not reuse the ArrayBuffer after this resolves.
   */
  storeBlob(id: string, data: ArrayBuffer): Promise<void>;
  deleteBlob(id: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

const RPC_TIMEOUT_MS = 15_000;

export async function openBrowserSqlClient(options: {
  name: string;
}): Promise<BrowserSqlClient> {
  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: options.name,
  });
  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timeoutId: ReturnType<typeof globalThis.setTimeout>;
      method: WorkerMethod;
    }
  >();

  const cleanupPending = (id: number) => {
    const entry = pending.get(id);
    if (entry === undefined) {
      return null;
    }
    pending.delete(id);
    globalThis.clearTimeout(entry.timeoutId);
    return entry;
  };

  const rejectAllPending = (error: unknown) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      globalThis.clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
  };

  worker.addEventListener(
    "message",
    (event: MessageEvent<StorageWorkerResponse>) => {
      const response = event.data;
      const entry = cleanupPending(response.id);
      if (entry === null) {
        return;
      }
      if (response.timing) {
        const attributes = {
          method: entry.method,
          lane: laneFor(entry.method),
        };
        recordHistogram(
          "sqlite.queue_wait_ms",
          response.timing.queueWaitMs,
          attributes,
        );
        recordHistogram("sqlite.exec_ms", response.timing.execMs, attributes);
        if (
          response.timing.execMs >= SLOW_WORKER_OP_MS ||
          response.timing.queueWaitMs >= SLOW_WORKER_OP_MS
        ) {
          log.debug(
            `slow worker op ${entry.method} (${laneFor(entry.method)}) exec_ms=${response.timing.execMs.toFixed(1)} queue_wait_ms=${response.timing.queueWaitMs.toFixed(1)}`,
          );
        }
      }
      if (response.ok) {
        entry.resolve(response.result);
      } else {
        entry.reject(new Error(response.error));
      }
    },
  );

  worker.addEventListener("error", (event) => {
    const error = event.error ?? new Error(event.message);
    rejectAllPending(error);
  });

  worker.addEventListener("messageerror", () => {
    rejectAllPending(new Error("Worker message deserialization failed"));
  });

  const request = <K extends WorkerMethod>(
    method: K,
    payload: WorkerRequestMap[K],
    transfer: Array<Transferable> = [],
  ): Promise<WorkerResultMap[K]> => {
    const id = nextId;
    nextId += 1;
    return new Promise<WorkerResultMap[K]>((resolve, reject) => {
      const timeoutId = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `[convex-embedded] browser sqlite worker timed out after ${RPC_TIMEOUT_MS}ms while handling ${method}`,
          ),
        );
      }, RPC_TIMEOUT_MS);

      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId,
        method,
      });
      const message: StorageWorkerRequest = {
        id,
        method,
        payload,
      } as StorageWorkerRequest;
      try {
        worker.postMessage(message, transfer);
      } catch (error) {
        cleanupPending(id)?.reject(error);
      }
    });
  };

  try {
    await request("init", { name: options.name });
  } catch (error) {
    rejectAllPending(error);
    worker.terminate();
    throw error;
  }

  return {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => request("query", { sql, params }) as unknown as Promise<T[]>,
    execute: async (sql, params) => {
      await request("execute", { sql, params });
    },
    executeBatch: async (statements) => {
      await request("executeBatch", { statements });
    },
    getDocuments: () => request("getDocuments", undefined),
    getDocumentsByTable: (tableName) =>
      request("getDocumentsByTable", { tableName }),
    hasAnyDocuments: (tableName) => request("hasAnyDocuments", { tableName }),
    listDocuments: (tableName) => request("listDocuments", { tableName }),
    readSource: (source, options) => request("readSource", { source, options }),
    readQuery: (args) => request("readQuery", args),
    getDocument: (tableName, id) => request("getDocument", { tableName, id }),
    countDocuments: (tableName) => request("countDocuments", { tableName }),
    getMeta: () => request("getMeta", undefined),
    getBlobs: () => request("getBlobs", undefined),
    getBlob: (id) => request("getBlob", { id }),
    commit: async (batch) => {
      await request("commit", { batch });
    },
    storeBlob: async (id, data) => {
      await request("storeBlob", { id, data }, [data]);
    },
    deleteBlob: async (id) => {
      await request("deleteBlob", { id });
    },
    clear: async () => {
      await request("clear", undefined);
    },
    close: async () => {
      try {
        await request("close", undefined);
      } finally {
        worker.terminate();
      }
    },
  };
}
