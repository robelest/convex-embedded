import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createNodeSqlClient } from "@/node/sqlite/client";
import { createLogger } from "@/shared/logger";
import { SqliteAdapter } from "@/storage/sqlite/adapter";
import type { InternalTableSpec } from "@/storage/sqlite/factory";

const log = createLogger("node-sqlite");

const now = () => performance.now();

export async function openNodeStorage(options: {
  filename: string;
  userTableSpecs?: Map<string, InternalTableSpec>;
}): Promise<SqliteAdapter> {
  const filename = resolve(options.filename);
  await mkdir(dirname(filename), { recursive: true });

  const openStarted = now();
  const client = await createNodeSqlClient(filename);

  log.debug(
    `schema ready for ${filename} in ${(now() - openStarted).toFixed(1)}ms`,
  );

  const stmtCache = new Map<string, ReturnType<typeof client.db.prepare>>();
  function prepare(sql: string) {
    let stmt = stmtCache.get(sql);
    if (stmt === undefined) {
      stmt = client.db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  return new SqliteAdapter(
    {
      query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        return Promise.resolve(prepare(sql).all(...(params ?? [])) as T[]);
      },
      async execute(sql, params) {
        prepare(sql).run(...(params ?? []));
      },
      async executeBatch(statements) {
        const txn = client.db.transaction(() => {
          for (const statement of statements) {
            prepare(statement.sql).run(...(statement.params ?? []));
          }
        });
        txn();
      },
      close: async () => client.close(),
    },
    { userTableSpecs: options.userTableSpecs },
  );
}
