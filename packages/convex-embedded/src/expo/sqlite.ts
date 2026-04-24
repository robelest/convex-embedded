import {
  defaultDatabaseDirectory,
  openDatabaseAsync,
  type SQLiteDatabase,
} from "expo-sqlite";

import { SqliteAdapter } from "@/persistence/sqlite/adapter";

export interface ExpoSqliteOptions {
  name: string;
  directory?: string;
}

export async function openExpoSqlitePersistence(
  options: ExpoSqliteOptions,
): Promise<SqliteAdapter> {
  const database = await openDatabaseAsync(
    `${options.name}.db`,
    undefined,
    options.directory ?? defaultDatabaseDirectory,
  );

  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: (db: SQLiteDatabase) => Promise<T>): Promise<T> => {
    const op = queue.catch(() => undefined).then(() => work(database));
    queue = op.catch(() => undefined);
    return op;
  };

  return SqliteAdapter.open({
    query: (sql, params) =>
      enqueue((db) => db.getAllAsync(sql, [...(params ?? [])])) as Promise<
        Record<string, unknown>[]
      >,
    execute: (sql, params) =>
      enqueue((db) => db.runAsync(sql, [...(params ?? [])])),
    executeBatch: (statements) =>
      enqueue((db) =>
        db.withExclusiveTransactionAsync(async (txn) => {
          for (const statement of statements) {
            await txn.runAsync(statement.sql, [...(statement.params ?? [])]);
          }
        }),
      ),
    close: async () => {
      await enqueue((db) => db.closeAsync());
    },
  });
}
