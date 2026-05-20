export interface NodeSqlClient {
  db: {
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): unknown;
    };
    transaction(fn: () => void): () => void;
    pragma(sql: string): unknown;
    close(): void;
  };
  close(): void;
}

export async function createNodeSqlClient(
  filename: string,
): Promise<NodeSqlClient> {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return { db, close: () => db.close() };
}
