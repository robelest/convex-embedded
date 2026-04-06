import {
  defaultDatabaseDirectory,
  openDatabaseAsync,
  type SQLiteDatabase,
} from "expo-sqlite";

import type { StoredDocument } from "@/runtime/db/types";
import type {
  CommitBatch,
  DatabaseMeta,
  StorageAdapter,
  StoredDocumentWithTable,
} from "@/storage/adapter";

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;

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

export interface ExpoSqliteOptions {
  name: string;
  directory?: string;
}

export async function openExpoSqliteStorage(
  options: ExpoSqliteOptions,
): Promise<StorageAdapter> {
  const db = await openDatabaseAsync(
    `${options.name}.db`,
    undefined,
    options.directory ?? defaultDatabaseDirectory,
  );
  await db.execAsync(SCHEMA_SQL);

  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: (db: SQLiteDatabase) => Promise<T>): Promise<T> => {
    const op = queue.catch(() => undefined).then(() => work(db));
    queue = op.catch(() => undefined);
    return op;
  };

  return {
    getDocuments: () =>
      enqueue(async (database) => {
        const rows = await database.getAllAsync<{
          data: string;
          table_name: string;
        }>("SELECT data, table_name FROM documents");
        return rows.map(({ data, table_name }) => ({
          doc: JSON.parse(data) as StoredDocument,
          tableName: table_name,
        })) satisfies StoredDocumentWithTable[];
      }),

    getDocumentsByTable: (tableName: string) =>
      enqueue(async (database) => {
        const rows = await database.getAllAsync<{ data: string }>(
          "SELECT data FROM documents WHERE table_name = ?",
          [tableName],
        );
        return rows.map(({ data }) => JSON.parse(data) as StoredDocument);
      }),

    getMeta: () =>
      enqueue(async (database) => {
        const row = await database.getFirstAsync<{
          timestamp: number;
          last_creation_time: number;
        }>("SELECT timestamp, last_creation_time FROM meta WHERE id = 1");
        if (!row) {
          return null;
        }
        return {
          timestamp: row.timestamp,
          lastCreationTime: row.last_creation_time,
        } satisfies DatabaseMeta;
      }),

    getBlobs: () =>
      enqueue(async (database) => {
        const rows = await database.getAllAsync<{
          id: string;
          data: Uint8Array;
        }>("SELECT id, data FROM blobs");
        return rows.map(({ id, data }) => ({
          id,
          blob: new Blob([new Uint8Array(data)]),
        }));
      }),

    commit: (batch: CommitBatch) =>
      enqueue(async (database) => {
        await database.withExclusiveTransactionAsync(async (txn) => {
          for (const { doc, tableName } of batch.puts) {
            await txn.runAsync(
              "INSERT OR REPLACE INTO documents (id, table_name, data) VALUES (?, ?, ?)",
              [String(doc._id), tableName, JSON.stringify(doc)],
            );
          }

          for (const id of batch.deletes) {
            await txn.runAsync("DELETE FROM documents WHERE id = ?", [id]);
          }

          await txn.runAsync(
            "INSERT OR REPLACE INTO meta (id, timestamp, last_creation_time) VALUES (1, ?, ?)",
            [batch.meta.timestamp, batch.meta.lastCreationTime],
          );
        });
      }),

    storeBlob: (id: string, blob: Blob) =>
      enqueue(async (database) => {
        await database.runAsync(
          "INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)",
          [id, new Uint8Array(await blob.arrayBuffer())],
        );
      }),

    deleteBlob: (id: string) =>
      enqueue(async (database) => {
        await database.runAsync("DELETE FROM blobs WHERE id = ?", [id]);
      }),

    clear: () =>
      enqueue(async (database) => {
        await database.execAsync(
          "DELETE FROM documents; DELETE FROM meta; DELETE FROM blobs;",
        );
      }),

    close: () =>
      enqueue(async (database) => {
        await database.closeAsync();
      }),
  };
}
