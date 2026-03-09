/**
 * Migration runner for local schema versioning.
 *
 * Tracks which schema version each local embedded runtime instance is on,
 * diffs against the current app version, and runs user-supplied
 * migration functions in sequence before the app renders.
 *
 * This is distinct from @convex-dev/migrations, which handles
 * remote data backfills. This runner handles local device migrations.
 */
import type { FunctionReference } from "convex/server";
import type {
  MigrationErrorHandler,
  RecoveryAction,
  RecoveryContext,
} from "$/shared/types";
import type { Definition } from "$/server/schema";
import { createLogger } from "$/shared/logger";

const log = createLogger("migration");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationConfig {
  /** Table name being migrated. */
  table: string;

  /** Current schema definition. */
  schema: Definition;

  /** Per-version migration functions (keyed by target version number). */
  migrations?: Record<number, FunctionReference<"mutation">>;

  /** Error handler when a migration fails. */
  onMigrationError?: MigrationErrorHandler;
}

interface VersionRecord {
  table: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Schema version table name — used in local embedded runtime docstore
// ---------------------------------------------------------------------------

const VERSION_TABLE = "_resolve_schema_versions";

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Check the current schema version and run any pending migrations.
 * Returns true if migrations were run, false if already up to date.
 *
 * This should be called during app startup, before rendering.
 * It blocks until all migrations complete.
 *
 * @param ctx - A Convex mutation context (ctx from a mutation handler)
 * @param config - Migration configuration
 */
/** Minimal structural type for a Convex mutation context used by the migration runner. */
interface MigrationCtx {
  db: {
    query(table: string): { filter(predicate: (q: unknown) => unknown): { collect(): Promise<Array<Record<string, unknown>>> }; collect(): Promise<Array<Record<string, unknown>>> };
    patch(id: unknown, fields: Record<string, unknown>): Promise<void>;
    insert(table: string, doc: Record<string, unknown>): Promise<unknown>;
    delete(id: unknown): Promise<void>;
  };
  runMutation(fn: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export async function runMigrations(
  ctx: MigrationCtx,
  config: MigrationConfig,
): Promise<boolean> {
  const { table, schema: schemaDef, migrations = {}, onMigrationError } = config;
  const targetVersion = schemaDef.version;

  log.info(`runMigrations: checking ${table}, target version=${targetVersion}`);

  // Read stored version
  let storedVersion = await getStoredVersion(ctx, table);

  if (storedVersion === targetVersion) {
    log.debug(`runMigrations: ${table} already at version ${targetVersion}`);
    return false;
  }

  if (storedVersion === null) {
    // First time — set to version 1 (assume initial schema)
    storedVersion = 1;
    await setStoredVersion(ctx, table, storedVersion);
    log.info(`runMigrations: ${table} initialized at version 1`);
  }

  if (storedVersion > targetVersion) {
    log.warn(
      `runMigrations: ${table} is at version ${storedVersion} but target is ${targetVersion}. ` +
        `Downgrade detected — this is not supported.`,
    );
    return false;
  }

  // Run migrations from storedVersion+1 to targetVersion, in sequence
  for (let v = storedVersion + 1; v <= targetVersion; v++) {
    log.info(`runMigrations: migrating ${table} from v${v - 1} to v${v}`);

    const migrationFn = migrations[v];

    try {
      if (migrationFn) {
        // Run the user-supplied migration function
        await ctx.runMutation(migrationFn, {});
        log.info(`runMigrations: ${table} v${v} migration completed`);
      } else {
        // No explicit migration — apply defaults for added fields
        await applyDefaults(ctx, table, schemaDef, v);
        log.info(`runMigrations: ${table} v${v} defaults applied`);
      }

      // Update stored version after each successful step
      await setStoredVersion(ctx, table, v);
    } catch (err) {
      log.error(`runMigrations: ${table} v${v} migration failed`, err);

      if (onMigrationError) {
        const recoveryCtx: RecoveryContext = {
          canResetSafely: true, // Assume we can always reset local data
          currentVersion: v - 1,
          targetVersion,
        };

        const recovery = await onMigrationError(
          err instanceof Error ? err : new Error(String(err)),
          recoveryCtx,
        );

        await handleRecovery(ctx, table, recovery, targetVersion);
      } else {
        // No error handler — throw
        throw err;
      }

      return true;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Version storage helpers
// ---------------------------------------------------------------------------

async function getStoredVersion(ctx: MigrationCtx, table: string): Promise<number | null> {
  try {
    const records = await ctx.db
      .query(VERSION_TABLE)
      .filter((q: unknown) => (q as { eq(a: unknown, b: unknown): unknown; field(name: string): unknown }).eq((q as { field(name: string): unknown }).field("table"), table))
      .collect();

    if (records.length === 0) return null;
    return records[0].version as number;
  } catch {
    // Table might not exist yet on local embedded runtime
    return null;
  }
}

async function setStoredVersion(ctx: MigrationCtx, table: string, version: number): Promise<void> {
  try {
    const existing = await ctx.db
      .query(VERSION_TABLE)
      .filter((q: unknown) => (q as { eq(a: unknown, b: unknown): unknown; field(name: string): unknown }).eq((q as { field(name: string): unknown }).field("table"), table))
      .collect();

    if (existing.length > 0) {
      await ctx.db.patch(existing[0]._id, { version });
    } else {
      await ctx.db.insert(VERSION_TABLE, { table, version });
    }
  } catch {
    // Best effort — if the table doesn't exist, try to create the record
    try {
      await ctx.db.insert(VERSION_TABLE, { table, version });
    } catch {
      log.warn(`setStoredVersion: could not store version for ${table}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Default application
// ---------------------------------------------------------------------------

async function applyDefaults(
  ctx: MigrationCtx,
  table: string,
  schemaDef: Definition,
  _targetVersion: number,
): Promise<void> {
  const defaults = schemaDef.defaults;
  if (!defaults || Object.keys(defaults).length === 0) return;

  // Patch all documents in the table with default values for new fields
  const docs = await ctx.db.query(table).collect();

  for (const doc of docs) {
    const patches: Record<string, unknown> = {};
    for (const [field, defaultValue] of Object.entries(defaults)) {
      if (doc[field] === undefined) {
        patches[field] = defaultValue;
      }
    }
    if (Object.keys(patches).length > 0) {
      await ctx.db.patch(doc._id, patches);
    }
  }

  log.debug(`applyDefaults: patched ${docs.length} docs in ${table}`);
}

// ---------------------------------------------------------------------------
// Recovery handlers
// ---------------------------------------------------------------------------

async function handleRecovery(
  ctx: MigrationCtx,
  table: string,
  recovery: RecoveryAction,
  targetVersion: number,
): Promise<void> {
  switch (recovery.action) {
    case "reset":
      // Wipe all local data for this table and set version to target
      log.info(`recovery: resetting ${table} — wiping local data`);
      const docs = await ctx.db.query(table).collect();
      for (const doc of docs) {
        await ctx.db.delete(doc._id);
      }
      await setStoredVersion(ctx, table, targetVersion);
      break;

    case "keep-old-schema":
      log.warn(`recovery: keeping old schema for ${table}`);
      // Don't update the version — limp along with stale shape
      break;

    case "retry":
      log.info(`recovery: will retry migration for ${table} on next startup`);
      // Don't update version — next startup will retry
      break;

    case "custom":
      log.info(`recovery: running custom handler for ${table}`);
      await recovery.handler();
      break;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const migration = {
  run: runMigrations,
  VERSION_TABLE,
};
