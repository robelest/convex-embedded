import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createNodeSqlClient } from "@/node/sqlite/client";
import { SqliteAdapter } from "@/persistence/sqlite/adapter";

const now = () => globalThis.performance?.now?.() ?? Date.now();

export async function openNodePersistence(options: {
  filename: string;
}): Promise<SqliteAdapter> {
  const filename = resolve(options.filename);
  await mkdir(dirname(filename), { recursive: true });

  const openStarted = now();
  const client = await createNodeSqlClient(filename);

  console.info(
    `[convex-embedded] node sqlite schema ready for ${filename} in ${(now() - openStarted).toFixed(1)}ms`,
  );

  return SqliteAdapter.open({
    async query(sql, params) {
      return client.db.prepare(sql).all(...(params ?? [])) as Record<
        string,
        unknown
      >[];
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
  });
}
