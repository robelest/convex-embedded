/**
 * Dedicated Worker entry point for wa-sqlite persistence.
 *
 * Runs the wa-sqlite WASM engine with `IDBBatchAtomicVFS` inside a
 * Dedicated Worker. The main thread communicates via a typed
 * request/response protocol over `postMessage`.
 *
 * Only plain JSON data crosses the boundary — documents, metadata,
 * and blob `ArrayBuffer`s. No functions, no Proxy objects, no Convex
 * module references.
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";

// ---------------------------------------------------------------------------
// Worker protocol types
// ---------------------------------------------------------------------------

/** Discriminated union of all requests the main thread can send. */
export type StorageRequest =
  | { id: number; method: "init"; name: string; wasmModule: WebAssembly.Module }
  | { id: number; method: "getDocuments" }
  | { id: number; method: "getDocumentsByTable"; tableName: string }
  | { id: number; method: "getMeta" }
  | { id: number; method: "getBlobs" }
  | {
      id: number;
      method: "commit";
      puts: Array<{ _id: string; tableName: string; data: string }>;
      deletes: string[];
      meta: { timestamp: number; lastCreationTime: number };
    }
  | { id: number; method: "storeBlob"; blobId: string; data: ArrayBuffer }
  | { id: number; method: "deleteBlob"; blobId: string }
  | { id: number; method: "clear" }
  | { id: number; method: "close" };

/** Response envelope sent back to the main thread. */
export type StorageResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CDN base for wa-sqlite ESM + VFS modules. */
const CDN_BASE = "https://wa-sqlite.trestle.inc/v1.0.0";

// ---------------------------------------------------------------------------
// SQL execution helper
// ---------------------------------------------------------------------------

/**
 * Execute a SQL statement and return result rows as plain objects.
 *
 * wa-sqlite's API is statement-based, so this helper iterates through
 * compiled statements, binds parameters, and collects column-keyed rows.
 */
async function execute(
  sqlite3: any,
  db: number,
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params?.length) sqlite3.bind_collection(stmt, params);
    const columns: string[] = sqlite3.column_names(stmt);
    while ((await sqlite3.step(stmt)) === 100) {
      const row = sqlite3.row(stmt);
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      rows.push(obj);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SQLite initialisation
// ---------------------------------------------------------------------------

/**
 * Load wa-sqlite from CDN, instantiate the VFS backed by IndexedDB,
 * and open (or create) the named database.
 */
async function initSqlite(
  name: string,
  wasmModule: WebAssembly.Module,
): Promise<{ sqlite3: any; db: number; vfs: any }> {
  const [{ default: SQLiteESMFactory }, { IDBBatchAtomicVFS }, SQLite] =
    await Promise.all([
      import(/* @vite-ignore */ `${CDN_BASE}/dist/wa-sqlite-async.mjs`),
      import(
        /* @vite-ignore */ `${CDN_BASE}/src/examples/IDBBatchAtomicVFS.js`
      ),
      import(/* @vite-ignore */ `${CDN_BASE}/src/sqlite-api.js`),
    ]);

  const module = await SQLiteESMFactory({
    instantiateWasm(
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance) => void,
    ) {
      WebAssembly.instantiate(wasmModule, imports).then(successCallback);
      return {};
    },
  });

  const sqlite3 = SQLite.Factory(module);
  const vfs = await IDBBatchAtomicVFS.create(name, module);
  sqlite3.vfs_register(vfs, true);
  const db: number = await sqlite3.open_v2(name);

  // Performance pragmas
  await sqlite3.exec(db, "PRAGMA cache_size = -8000;");
  await sqlite3.exec(db, "PRAGMA synchronous = NORMAL;");
  await sqlite3.exec(db, "PRAGMA temp_store = MEMORY;");

  return { sqlite3, db, vfs };
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    table_name TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    timestamp REAL NOT NULL,
    last_creation_time REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let sqlite3: any = null;
let db: number = 0;
let vfs: any = null;

/** Mutex for serialised SQL access. */
let mutex: Promise<unknown> = Promise.resolve();

function serializedExecute(
  sql: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> {
  const op = mutex
    .catch(() => {})
    .then(() => execute(sqlite3, db, sql, params));
  mutex = op;
  return op;
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleInit(
  name: string,
  wasmModule: WebAssembly.Module,
): Promise<void> {
  const result = await initSqlite(name, wasmModule);
  sqlite3 = result.sqlite3;
  db = result.db;
  vfs = result.vfs;
  await execute(sqlite3, db, SCHEMA_SQL);
}

async function handleGetDocuments(): Promise<
  Array<{ data: string; tableName: string }>
> {
  const rows = await serializedExecute(
    "SELECT data, table_name FROM documents",
  );
  return rows.map((row) => ({
    data: row.data as string,
    tableName: (row.table_name as string) ?? "",
  }));
}

async function handleGetDocumentsByTable(tableName: string): Promise<string[]> {
  const rows = await serializedExecute(
    "SELECT data FROM documents WHERE table_name = ?",
    [tableName],
  );
  return rows.map((row) => row.data as string);
}

async function handleGetMeta(): Promise<{
  timestamp: number;
  lastCreationTime: number;
} | null> {
  const rows = await serializedExecute("SELECT * FROM meta WHERE id = 1");
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    timestamp: row.timestamp as number,
    lastCreationTime: row.last_creation_time as number,
  };
}

async function handleGetBlobs(): Promise<
  Array<{ id: string; data: ArrayBuffer }>
> {
  const rows = await serializedExecute("SELECT id, data FROM blobs");
  return rows.map((row) => ({
    id: row.id as string,
    // wa-sqlite returns Uint8Array for BLOB columns — extract the buffer.
    data:
      row.data instanceof Uint8Array
        ? (row.data.buffer as ArrayBuffer).slice(
            row.data.byteOffset,
            row.data.byteOffset + row.data.byteLength,
          )
        : (row.data as ArrayBuffer),
  }));
}

async function handleCommit(
  puts: Array<{ _id: string; tableName: string; data: string }>,
  deletes: string[],
  meta: { timestamp: number; lastCreationTime: number },
): Promise<void> {
  const op = mutex
    .catch(() => {})
    .then(() =>
      Fx.run(
        Fx.bracket(
          // Acquire: begin transaction
          Fx.from({
            ok: () => execute(sqlite3, db, "BEGIN;"),
            err: (e) => e as Error,
          }),
          // Use: run DML statements and commit
          () =>
            Fx.gen(function* () {
              for (const doc of puts) {
                yield* Fx.from({
                  ok: () =>
                    execute(
                      sqlite3,
                      db,
                      "INSERT OR REPLACE INTO documents (id, table_name, data) VALUES (?, ?, ?)",
                      [doc._id, doc.tableName, doc.data],
                    ),
                  err: (e) => e as Error,
                });
              }

              for (const id of deletes) {
                yield* Fx.from({
                  ok: () =>
                    execute(sqlite3, db, "DELETE FROM documents WHERE id = ?", [
                      id,
                    ]),
                  err: (e) => e as Error,
                });
              }

              yield* Fx.from({
                ok: () =>
                  execute(
                    sqlite3,
                    db,
                    "INSERT OR REPLACE INTO meta (id, timestamp, last_creation_time) VALUES (1, ?, ?)",
                    [meta.timestamp, meta.lastCreationTime],
                  ),
                err: (e) => e as Error,
              });

              yield* Fx.from({
                ok: () => execute(sqlite3, db, "COMMIT;"),
                err: (e) => e as Error,
              });
            }),
          // Release: rollback on failure only
          (_tx, exit) =>
            Fx.sync(() => {
              if (exit._tag === "Failure") {
                execute(sqlite3, db, "ROLLBACK;").catch(() => {});
              }
            }),
        ),
      ),
    );

  mutex = op;
  await op;
}

async function handleStoreBlob(
  blobId: string,
  data: ArrayBuffer,
): Promise<void> {
  await serializedExecute(
    "INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)",
    [blobId, new Uint8Array(data)],
  );
}

async function handleDeleteBlob(blobId: string): Promise<void> {
  await serializedExecute("DELETE FROM blobs WHERE id = ?", [blobId]);
}

async function handleClear(): Promise<void> {
  await serializedExecute(
    "DELETE FROM documents; DELETE FROM meta; DELETE FROM blobs;",
  );
}

async function handleClose(): Promise<void> {
  if (sqlite3 && db) {
    await sqlite3.close(db);
  }
  if (vfs && typeof vfs.close === "function") {
    vfs.close();
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

async function handleMessage(request: StorageRequest): Promise<void> {
  try {
    let result: unknown = undefined;
    const transferables: Transferable[] = [];

    switch (request.method) {
      case "init":
        await handleInit(request.name, request.wasmModule);
        break;

      case "getDocuments":
        result = await handleGetDocuments();
        break;

      case "getDocumentsByTable":
        result = await handleGetDocumentsByTable(request.tableName);
        break;

      case "getMeta":
        result = await handleGetMeta();
        break;

      case "getBlobs": {
        const blobs = await handleGetBlobs();
        // Transfer ArrayBuffers for zero-copy.
        for (const b of blobs) {
          transferables.push(b.data);
        }
        result = blobs;
        break;
      }

      case "commit":
        await handleCommit(request.puts, request.deletes, request.meta);
        break;

      case "storeBlob":
        await handleStoreBlob(request.blobId, request.data);
        break;

      case "deleteBlob":
        await handleDeleteBlob(request.blobId);
        break;

      case "clear":
        await handleClear();
        break;

      case "close":
        await handleClose();
        break;
    }

    const response: StorageResponse = { id: request.id, ok: true, result };
    self.postMessage(response, { transfer: transferables });
  } catch (err) {
    const response: StorageResponse = {
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

self.addEventListener("message", (event: MessageEvent<StorageRequest>) => {
  void handleMessage(event.data);
});
