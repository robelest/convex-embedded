/// <reference lib="webworker" />

import * as WaSqlite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import { OPFSCoopSyncVFS } from "wa-sqlite/src/examples/OPFSCoopSyncVFS.js";

import { createSqlitePersistenceAdapter } from "@/persistence/sqlite/factory";
import type { StoredDocument } from "@/runtime/db/types";
import type { SqlPersistenceAdapter } from "@/storage/adapter";
import type { StoredDocumentWithTable } from "@/storage/adapter";

import type {
  BlobPayload,
  StorageWorkerRequest,
  StorageWorkerResponse,
} from "./protocol";

let sqlite3: ReturnType<typeof WaSqlite.Factory> | null = null;
let db: number | null = null;
let closeVfs: (() => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();
let sqliteModule: { retryOps?: Array<Promise<unknown>> } | null = null;
let persistenceAdapter: SqlPersistenceAdapter | null = null;

const MAX_RETRY_OP_ATTEMPTS = 20;

async function resetWorkerState() {
  persistenceAdapter = null;
  try {
    if (sqlite3 !== null && db !== null) {
      await Promise.resolve(sqlite3.close(db));
    }
  } catch {
    // Best-effort cleanup.
  }
  sqlite3 = null;
  db = null;
  sqliteModule = null;
  closeVfs?.();
  closeVfs = null;
}

function invariantReady(): {
  sqlite3: ReturnType<typeof WaSqlite.Factory>;
  db: number;
} {
  if (sqlite3 === null || db === null) {
    throw new Error(
      "[convex-embedded] browser sqlite worker is not initialized.",
    );
  }
  return { sqlite3, db };
}

function invariantAdapterReady(): SqlPersistenceAdapter {
  if (persistenceAdapter === null) {
    throw new Error(
      "[convex-embedded] browser sqlite worker persistence is not initialized.",
    );
  }
  return persistenceAdapter;
}

async function collectRows(sql: string, params?: Array<unknown>) {
  const ready = invariantReady();
  return withRetryOps(async () => {
    const rows: Array<Record<string, unknown>> = [];
    for await (const stmt of ready.sqlite3.statements(ready.db, sql)) {
      if (params !== undefined) {
        ready.sqlite3.bind_collection(stmt, params as any[]);
      }
      let columnNames: Array<string> | undefined;
      while (
        (await Promise.resolve(ready.sqlite3.step(stmt))) ===
        WaSqlite.SQLITE_ROW
      ) {
        columnNames ??= ready.sqlite3.column_names(stmt);
        const values = ready.sqlite3.row(stmt) as Array<unknown>;
        const row: Record<string, unknown> = {};
        for (let index = 0; index < columnNames.length; index += 1) {
          row[columnNames[index]!] = values[index];
        }
        rows.push(row);
      }
    }
    return rows;
  });
}

async function execute(sql: string, params?: Array<unknown>) {
  void (await collectRows(sql, params));
}

async function withSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(operation);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function flushRetryOps(): Promise<boolean> {
  const pending = sqliteModule?.retryOps;
  if (pending === undefined || pending.length === 0) {
    return false;
  }
  const operations = pending.splice(0, pending.length);
  await Promise.all(operations);
  return true;
}

async function withRetryOps<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRY_OP_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const flushed = await flushRetryOps();
      if (!flushed) {
        throw error;
      }
    }
  }
  throw new Error(
    `[convex-embedded] browser sqlite worker exceeded ${MAX_RETRY_OP_ATTEMPTS} retry-op attempts.`,
  );
}

async function handleInit(name: string) {
  if (sqlite3 !== null) {
    return null;
  }

  try {
    const started = globalThis.performance?.now?.() ?? Date.now();
    const module = await SQLiteESMFactory();
    const moduleReady = globalThis.performance?.now?.() ?? Date.now();
    const sqlite = WaSqlite.Factory(module);
    const vfs: any = await withRetryOps(() =>
      OPFSCoopSyncVFS.create("opfs", module as never),
    );
    const vfsReady = globalThis.performance?.now?.() ?? Date.now();
    sqlite.vfs_register(vfs, true);

    sqliteModule = module as { retryOps?: Array<Promise<unknown>> };
    const openedDb = await withRetryOps(async () =>
      Promise.resolve(sqlite.open_v2(name, undefined, "opfs")),
    );
    const openReady = globalThis.performance?.now?.() ?? Date.now();
    sqlite3 = sqlite;
    db = openedDb;
    closeVfs = () => {
      if (typeof vfs.close === "function") {
        vfs.close();
      }
    };
    persistenceAdapter = await createSqlitePersistenceAdapter({
      driver: {
        query: (sql, params) => collectRows(sql, params),
        execute,
        executeBatch: async (statements) => {
          await execute("BEGIN");
          try {
            for (const statement of statements) {
              await execute(
                statement.sql,
                statement.params as unknown[] | undefined,
              );
            }
            await execute("COMMIT");
          } catch (error) {
            try {
              await execute("ROLLBACK");
            } catch {
              // Ignore rollback failures so the original write error surfaces.
            }
            throw error;
          }
        },
      },
    });
    await execute("PRAGMA temp_store = MEMORY");
    await execute("PRAGMA cache_size = -8000");
    const ended = globalThis.performance?.now?.() ?? Date.now();
    console.info(
      `[convex-embedded] sqlite worker init: wasm=${(moduleReady - started).toFixed(1)}ms vfs=${(vfsReady - moduleReady).toFixed(1)}ms open=${(openReady - vfsReady).toFixed(1)}ms schema=${(ended - openReady).toFixed(1)}ms total=${(ended - started).toFixed(1)}ms`,
    );
  } catch (error) {
    await resetWorkerState();
    throw error;
  }
  return null;
}

async function handleQuery(input: {
  sql: string;
  params?: unknown[];
}): Promise<Record<string, unknown>[]> {
  return collectRows(input.sql, input.params);
}

async function handleExecute(input: {
  sql: string;
  params?: unknown[];
}): Promise<null> {
  await execute(input.sql, input.params);
  return null;
}

async function handleExecuteBatch(input: {
  statements: Array<{ sql: string; params?: unknown[] }>;
}): Promise<null> {
  await execute("BEGIN");
  try {
    for (const statement of input.statements) {
      await execute(statement.sql, statement.params);
    }
    await execute("COMMIT");
    return null;
  } catch (error) {
    try {
      await execute("ROLLBACK");
    } catch {
      // Ignore rollback failures so the original write error surfaces.
    }
    throw error;
  }
}

async function handleListDocuments(
  tableName: string,
): Promise<StoredDocument[]> {
  return invariantAdapterReady().listDocuments(tableName);
}

async function handleGetDocument(
  tableName: string,
  id: string,
): Promise<StoredDocument | null> {
  return invariantAdapterReady().getDocument(tableName, id);
}

async function handleCountDocuments(tableName: string): Promise<number> {
  return invariantAdapterReady().countDocuments(tableName);
}

async function handleGetDocuments(): Promise<StoredDocumentWithTable[]> {
  return invariantAdapterReady().getDocuments();
}

async function handleGetDocumentsByTable(
  tableName: string,
): Promise<StoredDocument[]> {
  return invariantAdapterReady().getDocumentsByTable(tableName);
}

async function handleHasAnyDocuments(tableName: string): Promise<boolean> {
  return invariantAdapterReady().hasAnyDocuments(tableName);
}

async function handleGetMeta() {
  return invariantAdapterReady().getMeta();
}

async function handleGetBlobs(): Promise<BlobPayload[]> {
  const rows = await invariantAdapterReady().getBlobs();
  return Promise.all(
    rows.map(async ({ id, blob }) => ({
      id,
      data: await blob.arrayBuffer(),
    })),
  );
}

async function handleGetBlob(id: string): Promise<ArrayBuffer | null> {
  const blob = await invariantAdapterReady().getBlob(id);
  return blob ? blob.arrayBuffer() : null;
}

async function handleStoreBlob(id: string, data: ArrayBuffer) {
  await invariantAdapterReady().storeBlob(id, new Blob([data]));
  return null;
}

async function handleDeleteBlob(id: string) {
  await invariantAdapterReady().deleteBlob(id);
  return null;
}

async function handleClear() {
  await invariantAdapterReady().clear();
  return null;
}

async function handleClose() {
  await resetWorkerState();
  return null;
}

async function dispatch(message: StorageWorkerRequest) {
  switch (message.method) {
    case "init":
      return handleInit(message.payload.name);
    case "query":
      return handleQuery(message.payload);
    case "execute":
      return handleExecute(message.payload);
    case "executeBatch":
      return handleExecuteBatch(message.payload);
    case "getDocuments":
      return handleGetDocuments();
    case "getDocumentsByTable":
      return handleGetDocumentsByTable(message.payload.tableName);
    case "hasAnyDocuments":
      return handleHasAnyDocuments(message.payload.tableName);
    case "listDocuments":
      return handleListDocuments(message.payload.tableName);
    case "readSource":
      return invariantAdapterReady().readSource(
        message.payload.source,
        message.payload.options,
      );
    case "readQuery":
      return invariantAdapterReady().readQuery(message.payload);
    case "getDocument":
      return handleGetDocument(message.payload.tableName, message.payload.id);
    case "countDocuments":
      return handleCountDocuments(message.payload.tableName);
    case "getMeta":
      return handleGetMeta();
    case "getBlobs":
      return handleGetBlobs();
    case "getBlob":
      return handleGetBlob(message.payload.id);
    case "commit":
      await invariantAdapterReady().commit(message.payload.batch);
      return null;
    case "storeBlob":
      return handleStoreBlob(message.payload.id, message.payload.data);
    case "deleteBlob":
      return handleDeleteBlob(message.payload.id);
    case "clear":
      return handleClear();
    case "close":
      return handleClose();
  }
}

function collectTransferables(result: unknown): Array<Transferable> {
  if (result === null) {
    return [];
  }
  if (result instanceof ArrayBuffer) {
    return [result];
  }
  if (Array.isArray(result)) {
    return result.flatMap((value) => collectTransferables(value));
  }
  if (typeof result === "object") {
    if (
      result !== null &&
      "data" in result &&
      result.data instanceof ArrayBuffer
    ) {
      return [result.data];
    }
  }
  return [];
}

self.addEventListener(
  "message",
  (event: MessageEvent<StorageWorkerRequest>) => {
    void withSerialized(async () => {
      const message = event.data;
      try {
        const result = await dispatch(message);
        const response: StorageWorkerResponse = {
          id: message.id,
          ok: true,
          result,
        };
        self.postMessage(response, collectTransferables(result));
      } catch (error) {
        const response: StorageWorkerResponse = {
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        self.postMessage(response);
      }
    });
  },
);
