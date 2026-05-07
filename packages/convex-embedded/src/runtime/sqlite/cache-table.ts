import type { SqliteDriver } from "@/storage/sqlite/driver";

export interface SqliteCacheRow {
  refName: string;
  argsHash: string;
  argsJson: string;
  valueJson: string;
  receivedAt: number;
  ts: number | null;
  paginationCursor: string | null;
  paginationIsDone: number | null;
}

export interface QueryCacheStorage {
  initSchema(): Promise<void>;
  upsert(row: SqliteCacheRow): Promise<void>;
  delete(refName: string, argsHash: string): Promise<void>;
  load(refName: string, argsHash: string): Promise<SqliteCacheRow | null>;
  loadAll(): Promise<SqliteCacheRow[]>;
  clear(): Promise<void>;
  pruneOlderThan(timestampMs: number): Promise<number>;
}

const TABLE_NAME = "_embedded_query_cache";
const RECEIVED_AT_INDEX = "_embedded_query_cache_received_at";

const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    ref_name TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    args_json TEXT NOT NULL,
    value_json TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    ts INTEGER,
    pagination_cursor TEXT,
    pagination_is_done INTEGER,
    PRIMARY KEY (ref_name, args_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS ${RECEIVED_AT_INDEX}
    ON ${TABLE_NAME} (received_at)`,
];

const UPSERT_SQL = `INSERT INTO ${TABLE_NAME}
  (ref_name, args_hash, args_json, value_json, received_at, ts, pagination_cursor, pagination_is_done)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ref_name, args_hash) DO UPDATE SET
    args_json = excluded.args_json,
    value_json = excluded.value_json,
    received_at = excluded.received_at,
    ts = excluded.ts,
    pagination_cursor = excluded.pagination_cursor,
    pagination_is_done = excluded.pagination_is_done`;

const DELETE_SQL = `DELETE FROM ${TABLE_NAME} WHERE ref_name = ? AND args_hash = ?`;

const LOAD_SQL = `SELECT
    ref_name, args_hash, args_json, value_json, received_at, ts, pagination_cursor, pagination_is_done
  FROM ${TABLE_NAME}
  WHERE ref_name = ? AND args_hash = ?
  LIMIT 1`;

const LOAD_ALL_SQL = `SELECT
    ref_name, args_hash, args_json, value_json, received_at, ts, pagination_cursor, pagination_is_done
  FROM ${TABLE_NAME}`;

const CLEAR_SQL = `DELETE FROM ${TABLE_NAME}`;

const PRUNE_SQL = `DELETE FROM ${TABLE_NAME} WHERE received_at < ?`;

const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE_NAME}`;

interface CacheRowRecord extends Record<string, unknown> {
  ref_name: string;
  args_hash: string;
  args_json: string;
  value_json: string;
  received_at: number;
  ts: number | null;
  pagination_cursor: string | null;
  pagination_is_done: number | null;
}

function decodeRow(row: CacheRowRecord): SqliteCacheRow {
  return {
    refName: String(row.ref_name),
    argsHash: String(row.args_hash),
    argsJson: String(row.args_json),
    valueJson: String(row.value_json),
    receivedAt: Number(row.received_at),
    ts: row.ts === null || row.ts === undefined ? null : Number(row.ts),
    paginationCursor:
      row.pagination_cursor === null || row.pagination_cursor === undefined
        ? null
        : String(row.pagination_cursor),
    paginationIsDone:
      row.pagination_is_done === null || row.pagination_is_done === undefined
        ? null
        : Number(row.pagination_is_done),
  };
}

function normalizeIsDone(value: number | null): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

const BATCH_FLUSH_MS = 60;

export function createQueryCacheStorage(
  driver: SqliteDriver,
): QueryCacheStorage {
  let initialized: Promise<void> | null = null;

  const initSchema = async (): Promise<void> => {
    initialized ??= (async () => {
      const existing = await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [TABLE_NAME],
      );
      if (existing.length > 0) {
        return;
      }
      for (const statement of SCHEMA_STATEMENTS) {
        await driver.execute(statement);
      }
    })();
    await initialized;
  };

  const pendingUpserts = new Map<string, SqliteCacheRow>();
  const pendingDeletes = new Map<string, { refName: string; argsHash: string }>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushPromise: Promise<void> | null = null;

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => undefined);
    }, BATCH_FLUSH_MS);
  };

  const flush = async (): Promise<void> => {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        await initSchema();
        const upserts = Array.from(pendingUpserts.values());
        const deletes = Array.from(pendingDeletes.values());
        pendingUpserts.clear();
        pendingDeletes.clear();
        if (upserts.length === 0 && deletes.length === 0) return;
        const statements: Array<{ sql: string; params?: readonly unknown[] }> =
          [];
        for (const row of upserts) {
          statements.push({
            sql: UPSERT_SQL,
            params: [
              row.refName,
              row.argsHash,
              row.argsJson,
              row.valueJson,
              row.receivedAt,
              row.ts,
              row.paginationCursor,
              row.paginationIsDone,
            ],
          });
        }
        for (const target of deletes) {
          statements.push({
            sql: DELETE_SQL,
            params: [target.refName, target.argsHash],
          });
        }
        if (statements.length === 0) return;
        if (typeof driver.executeBatch === "function") {
          await driver.executeBatch(statements);
        } else {
          for (const statement of statements) {
            await driver.execute(statement.sql, statement.params);
          }
        }
      } finally {
        flushPromise = null;
        if (pendingUpserts.size > 0 || pendingDeletes.size > 0) {
          scheduleFlush();
        }
      }
    })();
    return flushPromise;
  };

  const drainPending = async (): Promise<void> => {
    while (true) {
      if (flushPromise) {
        await flushPromise;
      }
      if (pendingUpserts.size === 0 && pendingDeletes.size === 0) {
        return;
      }
      await flush();
    }
  };

  return {
    initSchema,

    async upsert(row: SqliteCacheRow): Promise<void> {
      const key = `${row.refName} ${row.argsHash}`;
      pendingDeletes.delete(key);
      const normalized: SqliteCacheRow = {
        ...row,
        paginationIsDone: normalizeIsDone(row.paginationIsDone),
      };
      pendingUpserts.set(key, normalized);
      scheduleFlush();
    },

    async delete(refName: string, argsHash: string): Promise<void> {
      const key = `${refName} ${argsHash}`;
      pendingUpserts.delete(key);
      pendingDeletes.set(key, { refName, argsHash });
      scheduleFlush();
    },

    async load(
      refName: string,
      argsHash: string,
    ): Promise<SqliteCacheRow | null> {
      await initSchema();
      const key = `${refName} ${argsHash}`;
      const pending = pendingUpserts.get(key);
      if (pending) return pending;
      if (pendingDeletes.has(key)) return null;
      if (flushPromise) await flushPromise;
      const rows = await driver.query<CacheRowRecord>(LOAD_SQL, [
        refName,
        argsHash,
      ]);
      const first = rows[0];
      if (!first) return null;
      return decodeRow(first);
    },

    async loadAll(): Promise<SqliteCacheRow[]> {
      await initSchema();
      await drainPending();
      const rows = await driver.query<CacheRowRecord>(LOAD_ALL_SQL);
      return rows.map(decodeRow);
    },

    async clear(): Promise<void> {
      pendingUpserts.clear();
      pendingDeletes.clear();
      await initSchema();
      await driver.execute(CLEAR_SQL);
    },

    async pruneOlderThan(timestampMs: number): Promise<number> {
      await initSchema();
      await drainPending();
      const before = await driver.query<{ count: number }>(COUNT_SQL);
      const beforeCount = Number(before[0]?.count ?? 0);
      await driver.execute(PRUNE_SQL, [timestampMs]);
      const after = await driver.query<{ count: number }>(COUNT_SQL);
      const afterCount = Number(after[0]?.count ?? 0);
      return Math.max(0, beforeCount - afterCount);
    },
  };
}
