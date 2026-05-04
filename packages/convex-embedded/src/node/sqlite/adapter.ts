import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createNodeSqlClient } from "@/node/sqlite/client";
import { createLogger } from "@/shared/logger";
import { SqliteAdapter } from "@/storage/sqlite/adapter";
import type { InternalTableSpec } from "@/storage/sqlite/factory";

const log = createLogger("node-sqlite");

const now = () => globalThis.performance?.now?.() ?? Date.now();

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

  return new SqliteAdapter(
    {
      query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        return Promise.resolve(
          client.db.prepare(sql).all(...(params ?? [])) as T[],
        );
      },
      async execute(sql, params) {
        client.db.prepare(sql).run(...(params ?? []));
      },
      async executeBatch(statements) {
        const txn = client.db.transaction(() => {
          for (const statement of statements) {
            client.db.prepare(statement.sql).run(...(statement.params ?? []));
          }
        });
        txn();
      },
      close: async () => client.close(),
    },
    { userTableSpecs: options.userTableSpecs },
  );
}
