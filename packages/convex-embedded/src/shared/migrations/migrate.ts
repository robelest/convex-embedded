import type { Validator } from "convex/values";

import { createLogger } from "@/shared/logger";
import type {
  MigrationContext,
  MigrationDb,
  MigrationLogger,
  MigrationSchema,
  MigrationStep,
  MigrationSystem,
  MigrationSystemTable,
} from "@/shared/migrations/types";
import type { Definition } from "@/shared/schema";
import type {
  MigrationErrorHandler,
  RecoveryAction,
  RecoveryContext,
} from "@/shared/types";
import type { SchemaOp } from "@/storage/adapter";

const log = createLogger("migration");

const VERSION_TABLE = "_resolve_schema_versions";

export interface SystemIndexRange {
  fieldPath: string;
  value: unknown;
}

export interface MigrationRuntimeAdapter {
  systemReadByIndex(input: {
    table: string;
    indexName: string;
    range: SystemIndexRange[];
  }): Promise<Array<Record<string, unknown>>>;
  systemInsert(table: string, doc: Record<string, unknown>): Promise<string>;
  systemPatch(id: string, fields: Record<string, unknown>): Promise<void>;
  systemDelete(id: string): Promise<void>;

  tableList(table: string): Promise<Array<Record<string, unknown>>>;
  tableGet(table: string, id: string): Promise<Record<string, unknown> | null>;
  tableInsert(table: string, doc: Record<string, unknown>): Promise<string>;
  tablePatch(
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  tableReplace(
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  tableDelete(table: string, id: string): Promise<void>;

  applySchemaOps(table: string, ops: readonly SchemaOp[]): Promise<void>;
}

export interface RunMigrationsOptions {
  table: string;
  schema: Definition;
  adapter: MigrationRuntimeAdapter;
  onMigrationError?: MigrationErrorHandler;
}

function createMigrationLogger(table: string): MigrationLogger {
  return {
    info: (message, ...rest) => log.info(`[${table}] ${message}`, ...rest),
    warn: (message, ...rest) => log.warn(`[${table}] ${message}`, ...rest),
    error: (message, ...rest) => log.error(`[${table}] ${message}`, ...rest),
  };
}

function validatorToSqlType(
  validator: Validator<unknown, "required" | "optional", string>,
): "TEXT" | "REAL" | "INTEGER" | "BLOB" {
  const kind = (validator as { kind?: string }).kind;
  switch (kind) {
    case "string":
    case "id":
    case "literal":
      return "TEXT";
    case "float64":
    case "number":
      return "REAL";
    case "int64":
    case "boolean":
      return "INTEGER";
    case "bytes":
      return "BLOB";
    default:
      return "TEXT";
  }
}

function createMigrationDb(
  adapter: MigrationRuntimeAdapter,
  table: string,
): MigrationDb {
  return {
    all: () => adapter.tableList(table),
    iter: async function* () {
      const rows = await adapter.tableList(table);
      for (const row of rows) yield row;
    },
    get: (id) => adapter.tableGet(table, id),
    insert: (fields) => adapter.tableInsert(table, fields),
    patch: (id, fields) => adapter.tablePatch(table, id, fields),
    patchMissing: async (fields) => {
      const rows = await adapter.tableList(table);
      let patched = 0;
      for (const row of rows) {
        const updates: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (row[key] === undefined) updates[key] = value;
        }
        if (Object.keys(updates).length === 0) continue;
        await adapter.tablePatch(table, row._id as string, updates);
        patched += 1;
      }
      return patched;
    },
    replace: (id, fields) => adapter.tableReplace(table, id, fields),
    delete: (id) => adapter.tableDelete(table, id),
    modify: async (transform) => {
      const rows = await adapter.tableList(table);
      let changed = 0;
      for (const row of rows) {
        const next = await transform(row);
        if (next === undefined) continue;
        if (next === null) {
          await adapter.tableDelete(table, row._id as string);
          changed += 1;
          continue;
        }
        const { _id: _omitId, _creationTime: _omitTime, ...rest } = next;
        await adapter.tableReplace(table, row._id as string, {
          ...rest,
          _id: row._id,
          _creationTime: row._creationTime,
        });
        changed += 1;
      }
      return changed;
    },
  };
}

function createSystemTable(
  adapter: MigrationRuntimeAdapter,
  table: string,
): MigrationSystemTable {
  return {
    all: () => adapter.tableList(table),
    get: (id) => adapter.tableGet(table, id),
    insert: (fields) => adapter.tableInsert(table, fields),
    patch: (id, fields) => adapter.tablePatch(table, id, fields),
    delete: (id) => adapter.tableDelete(table, id),
  };
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<boolean> {
  const { table, schema, adapter, onMigrationError } = options;
  const { migrations } = schema;
  const targetVersion = schema.version;
  const logger = createMigrationLogger(table);

  logger.info(`checking, target version=${targetVersion}`);

  let storedVersion = await getStoredVersion(adapter, table);

  if (storedVersion === targetVersion) {
    return false;
  }

  if (storedVersion === null) {
    await setStoredVersion(adapter, table, 1);
    storedVersion = 1;
    if (storedVersion === targetVersion) return true;
  }

  if (storedVersion > targetVersion) {
    throw new Error(
      `runMigrations: ${table} is at version ${storedVersion} but target is ${targetVersion}. Forward-only migrations do not support opening newer local data with an older app.`,
    );
  }

  for (let v = storedVersion + 1; v <= targetVersion; v++) {
    const migrationFn = migrations[v];
    if (!migrationFn) {
      logger.info(`v${v}: no migration step, advancing version`);
      await setStoredVersion(adapter, table, v);
      continue;
    }

    try {
      await runMigrationStep(adapter, table, schema, v, migrationFn, logger);
      await setStoredVersion(adapter, table, v);
      logger.info(`v${v} completed`);
    } catch (err) {
      logger.error(`v${v} migration failed`, err);

      if (onMigrationError) {
        const recoveryCtx: RecoveryContext = {
          canResetSafely: true,
          currentVersion: v - 1,
          targetVersion,
        };
        const recovery = await Promise.resolve(
          onMigrationError(
            err instanceof Error ? err : new Error(String(err)),
            recoveryCtx,
          ),
        );
        await handleRecovery(adapter, table, recovery, targetVersion, logger);
        return true;
      }
      throw err;
    }
  }

  return true;
}

async function runMigrationStep(
  adapter: MigrationRuntimeAdapter,
  table: string,
  _schema: Definition,
  version: number,
  migrationFn: MigrationStep,
  logger: MigrationLogger,
): Promise<void> {
  const db = createMigrationDb(adapter, table);
  const system: MigrationSystem = {
    table: (name) => createSystemTable(adapter, name),
  };

  const schemaCtx: MigrationSchema = {
    fromVersion: version - 1,
    toVersion: version,
    addColumn: async (name, validator, opts) => {
      await adapter.applySchemaOps(table, [
        {
          type: "addColumn",
          column: name,
          sqlType: validatorToSqlType(validator),
          defaultSql: opts?.defaultSql,
        },
      ]);
    },
    dropColumn: async (name) => {
      await adapter.applySchemaOps(table, [
        { type: "dropColumn", column: name },
      ]);
    },
    addIndex: async (name, fields, opts) => {
      await adapter.applySchemaOps(table, [
        {
          type: "addIndex",
          name,
          fields: [...fields],
          unique: opts?.unique,
        },
      ]);
    },
    dropIndex: async (name) => {
      await adapter.applySchemaOps(table, [{ type: "dropIndex", name }]);
    },
  };

  const ctx: MigrationContext = {
    table,
    db,
    schema: schemaCtx,
    system,
    log: logger,
  };

  await migrationFn(ctx);
}

async function getStoredVersion(
  adapter: MigrationRuntimeAdapter,
  table: string,
): Promise<number | null> {
  const rows = await adapter.systemReadByIndex({
    table: VERSION_TABLE,
    indexName: "by_table",
    range: [{ fieldPath: "table", value: table }],
  });
  if (rows.length === 0) return null;
  const versions = rows
    .map((row) => Number(row.version))
    .filter((value) => Number.isFinite(value));
  return versions.length > 0 ? Math.max(...versions) : null;
}

async function setStoredVersion(
  adapter: MigrationRuntimeAdapter,
  table: string,
  version: number,
): Promise<void> {
  const existing = await adapter.systemReadByIndex({
    table: VERSION_TABLE,
    indexName: "by_table",
    range: [{ fieldPath: "table", value: table }],
  });

  if (existing.length === 0) {
    await adapter.systemInsert(VERSION_TABLE, { table, version });
    return;
  }

  const [primary, ...duplicates] = existing;
  await adapter.systemPatch(primary!._id as string, { version });
  for (const stale of duplicates) {
    await adapter.systemDelete(stale._id as string);
  }
}

async function handleRecovery(
  adapter: MigrationRuntimeAdapter,
  table: string,
  recovery: RecoveryAction,
  targetVersion: number,
  logger: MigrationLogger,
): Promise<void> {
  if (recovery.action === "reset") {
    logger.info("recovery: resetting table");
    const docs = await adapter.tableList(table);
    for (const doc of docs) {
      await adapter.tableDelete(table, doc._id as string);
    }
    await setStoredVersion(adapter, table, targetVersion);
  } else if (recovery.action === "keep-old-schema") {
    logger.warn("recovery: keeping old schema");
  } else if (recovery.action === "retry") {
    logger.info("recovery: will retry on next load");
  } else if (recovery.action === "custom") {
    logger.info("recovery: running custom handler");
    await recovery.handler();
  }
}

export const migration = {
  run: runMigrations,
  VERSION_TABLE,
};
