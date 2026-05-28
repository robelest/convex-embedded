import { openBrowserSqlClient } from "@/browser/sqlite/client";
import { createLogger } from "@/shared/logger";
import { SqliteAdapter } from "@/storage/sqlite/adapter";
import type { InternalTableSpec } from "@/storage/sqlite/factory";

const log = createLogger("browser-sqlite");

const now = () => performance.now();

export async function openBrowserStorage(options: {
  name: string;
  userTableSpecs?: Map<string, InternalTableSpec>;
}): Promise<SqliteAdapter> {
  const openStarted = now();
  const client = await openBrowserSqlClient(options);

  log.debug(
    `schema ready for ${options.name} in ${(now() - openStarted).toFixed(1)}ms`,
  );

  return new SqliteAdapter(
    {
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
    },
    { userTableSpecs: options.userTableSpecs },
  );
}
