export interface SqliteStatement {
  sql: string;
  params?: readonly unknown[];
}

export interface SqliteDriver {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<void>;
  executeBatch(statements: readonly SqliteStatement[]): Promise<void>;
  close?(): Promise<void>;
}
