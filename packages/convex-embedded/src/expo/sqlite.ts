import {
  ANDROID_DATABASE_PATH,
  IOS_LIBRARY_PATH,
  open,
  type DB,
  type Scalar,
} from "@op-engineering/op-sqlite";
import { Platform } from "react-native";

import { logSlow, nowMs } from "@/shared/perf";
import { createDefaultWorkScheduler, type WorkScheduler } from "@/shared/work";
import { SqliteAdapter } from "@/storage/sqlite/adapter";
import type { InternalTableSpec } from "@/storage/sqlite/factory";
import { withSpan } from "@/tracing/spans";

export interface OpSqliteStorageOptions {
  name: string;
  directory?: string;
  userTableSpecs?: Map<string, InternalTableSpec>;
  workScheduler?: WorkScheduler;
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
  const scheduler = options.workScheduler ?? createDefaultWorkScheduler();

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
    const op = queue
      .catch(() => undefined)
      .then(async () =>
        withSpan(`convex-embedded.sqlite.${label}`, async (span) => {
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
        }),
      );
    queue = op.catch(() => undefined);
    return op;
  };

  return new SqliteAdapter(
    {
      query: async <
        T extends Record<string, unknown> = Record<string, unknown>,
      >(
        sql: string,
        params?: readonly unknown[],
      ): Promise<T[]> => {
        const startedAt = nowMs();
        try {
          const result = await database.execute(sql, bindParams(params));
          return (result.rows ?? []) as T[];
        } finally {
          logSlow(`sqlite.query`, startedAt, {
            params: params?.length ?? 0,
            sql: sql.slice(0, 160),
          });
        }
      },
      execute: (sql, params) =>
        enqueue(
          "execute",
          async (db) => {
            await db.execute(sql, bindParams(params));
            scheduleCheckpoint();
          },
          { params: params?.length ?? 0, sql: sql.slice(0, 160) },
        ),
      executeBatch: (statements) => {
        const phases = {
          executeMs: 0,
          bufferFlushMs: 0,
          executeCalls: 0,
          bufferFlushes: 0,
          txOverheadMs: 0,
          error: null as string | null,
        };
        return enqueue(
          "executeBatch",
          async (db) => {
            const txStart = nowMs();
            try {
              await db.transaction(async (tx) => {
                const execBuffer: string[] = [];

                const flushExecBuffer = async () => {
                  if (execBuffer.length === 0) {
                    return;
                  }
                  const start = nowMs();
                  await tx.execute(`${execBuffer.join(";\n")};`);
                  phases.bufferFlushMs += nowMs() - start;
                  phases.bufferFlushes += 1;
                  execBuffer.length = 0;
                };

                let yieldChecks = 0;
                for (const statement of statements) {
                  const params = bindParams(statement.params);
                  if (params.length === 0) {
                    execBuffer.push(statement.sql);
                    continue;
                  }

                  await flushExecBuffer();
                  const start = nowMs();
                  await tx.execute(statement.sql, params);
                  phases.executeMs += nowMs() - start;
                  phases.executeCalls += 1;
                  yieldChecks += 1;
                  if (yieldChecks >= 32 && scheduler.shouldYield()) {
                    yieldChecks = 0;
                    await scheduler.yield();
                  }
                }
                await flushExecBuffer();
              });
            } catch (err) {
              phases.error = err instanceof Error ? err.message : String(err);
              throw err;
            } finally {
              const totalMs = nowMs() - txStart;
              phases.txOverheadMs =
                totalMs - phases.executeMs - phases.bufferFlushMs;
            }
          },
          {
            statements: statements.length,
            phases,
          },
        ).then((result) => {
          scheduleCheckpoint();
          return result;
        });
      },
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
