import { Platform } from "react-native";
import {
  ANDROID_DATABASE_PATH,
  IOS_LIBRARY_PATH,
  open,
  type DB,
  type PreparedStatement,
  type Scalar,
} from "@op-engineering/op-sqlite";

import { logSlow, nowMs } from "@/shared/perf";
import { SqliteAdapter } from "@/storage/sqlite/adapter";
import type { InternalTableSpec } from "@/storage/sqlite/factory";
import { withSpan } from "@/tracing/spans";

export interface OpSqliteStorageOptions {
  name: string;
  directory?: string;
  userTableSpecs?: Map<string, InternalTableSpec>;
}

function defaultLocation(): string | undefined {
  if (Platform.OS === "ios") {
    return (IOS_LIBRARY_PATH as string | undefined) ?? undefined;
  }
  if (Platform.OS === "android") {
    return (ANDROID_DATABASE_PATH as string | undefined) ?? undefined;
  }
  return undefined;
}

function bindParams(params?: readonly unknown[]): Scalar[] {
  if (!params || params.length === 0) {
    return [];
  }
  return params.map((value) => value as Scalar);
}

export async function openOpSqliteStorage(
  options: OpSqliteStorageOptions,
): Promise<SqliteAdapter> {
  const location = options.directory ?? defaultLocation();
  const database: DB = open({
    name: `${options.name}.db`,
    ...(location ? { location } : {}),
  });

  await database.execute("PRAGMA journal_mode = WAL");
  await database.execute("PRAGMA synchronous = NORMAL");
  await database.execute("PRAGMA temp_store = MEMORY");
  await database.execute("PRAGMA busy_timeout = 5000");
  await database.execute("PRAGMA cache_size = -32000");
  await database.execute("PRAGMA mmap_size = 268435456");
  await database.execute("PRAGMA wal_autocheckpoint = 10000");

  let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;

  const scheduleCheckpoint = (): void => {
    if (closing) return;
    if (checkpointTimer !== null) clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null;
      if (closing) return;
      void database
        .execute("PRAGMA wal_checkpoint(PASSIVE)")
        .catch(() => undefined);
    }, 500);
  };

  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(
    label: string,
    work: (db: DB) => Promise<T>,
    details?: Record<string, unknown>,
  ): Promise<T> => {
    const queuedAt = nowMs();
    const op = queue.catch(() => undefined).then(async () =>
      withSpan(
        `convex-embedded.sqlite.${label}`,
        async (span) => {
          const queueWaitMs = nowMs() - queuedAt;
          span.setAttributes({
            "convex.sqlite.queue_wait_ms": +queueWaitMs.toFixed(1),
            "convex.sqlite.params": (details?.params as number) ?? 0,
            ...(typeof details?.sql === "string"
              ? { "convex.sqlite.sql": details.sql as string }
              : {}),
            ...(typeof details?.statements === "number"
              ? { "convex.sqlite.statements": details.statements as number }
              : {}),
          });
          logSlow(`sqlite.${label}.queue_wait`, queuedAt, details, 16);
          const startedAt = nowMs();
          try {
            return await work(database);
          } finally {
            const durationMs = nowMs() - startedAt;
            span.setAttributes({
              "convex.sqlite.exec_ms": +durationMs.toFixed(1),
            });
            logSlow(`sqlite.${label}`, startedAt, details);
          }
        },
      ),
    );
    queue = op.catch(() => undefined);
    return op;
  };

  return new SqliteAdapter(
    {
      query: <T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) =>
        enqueue(
          "query",
          async (db) => {
            const result = await db.execute(sql, bindParams(params));
            return (result.rows ?? []) as T[];
          },
          { params: params?.length ?? 0, sql: sql.slice(0, 160) },
        ),
      execute: (sql, params) =>
        enqueue(
          "execute",
          async (db) => {
            await db.execute(sql, bindParams(params));
            scheduleCheckpoint();
          },
          { params: params?.length ?? 0, sql: sql.slice(0, 160) },
        ),
      executeBatch: (statements) =>
        enqueue(
          "executeBatch",
          (db) =>
            db.transaction(async (tx) => {
              const prepared = new Map<string, PreparedStatement>();
              const execBuffer: string[] = [];

              const flushExecBuffer = async () => {
                if (execBuffer.length === 0) {
                  return;
                }
                await tx.execute(`${execBuffer.join(";\n")};`);
                execBuffer.length = 0;
              };

              for (const statement of statements) {
                const params = bindParams(statement.params);
                if (params.length === 0) {
                  execBuffer.push(statement.sql);
                  continue;
                }

                await flushExecBuffer();
                let compiled = prepared.get(statement.sql);
                if (!compiled) {
                  compiled = db.prepareStatement(statement.sql);
                  prepared.set(statement.sql, compiled);
                }
                await compiled.bind(params);
                await compiled.execute();
              }
              await flushExecBuffer();
            }),
          { statements: statements.length },
        ).then((result) => {
          scheduleCheckpoint();
          return result;
        }),
      close: async () => {
        closing = true;
        if (checkpointTimer !== null) {
          clearTimeout(checkpointTimer);
          checkpointTimer = null;
        }
        await enqueue("close", async (db) => {
          await db.closeAsync();
        });
      },
    },
    { userTableSpecs: options.userTableSpecs },
  );
}
