import { openBrowserSqlClient } from "@/browser/sqlite/client";
import { SqliteAdapter } from "@/persistence/sqlite/adapter";

const now = () => globalThis.performance?.now?.() ?? Date.now();

export async function openBrowserPersistence(options: {
  name: string;
}): Promise<SqliteAdapter> {
  const openStarted = now();
  const client = await openBrowserSqlClient(options);

  console.info(
    `[convex-embedded] browser sqlite schema ready for ${options.name} in ${(now() - openStarted).toFixed(1)}ms`,
  );

  return SqliteAdapter.open({
    query: (sql, params) => client.query(sql, [...(params ?? [])]),
    execute: (sql, params) => client.execute(sql, [...(params ?? [])]),
    executeBatch: (statements) =>
      client.executeBatch(
        statements.map((statement) => ({
          sql: statement.sql,
          params: statement.params ? [...statement.params] : undefined,
        })),
      ),
    close: () => client.close(),
  });
}
