/**
 * Migration types and runner for local schema versioning.
 *
 * @module
 */
import { Fx } from "@robelest/fx";

import { createLogger } from "@/shared/logger";
import type { Definition } from "@/shared/schema";
import type {
  MigrationErrorHandler,
  RecoveryAction,
  RecoveryContext,
} from "@/shared/types";

const log = createLogger("migration");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalTableDocsApi {
  all(): Promise<Array<Record<string, unknown>>>;
  patchMissing(fields: Record<string, unknown>): Promise<number>;
  patch(id: unknown, fields: Record<string, unknown>): Promise<void>;
  replace(id: unknown, fields: Record<string, unknown>): Promise<void>;
  delete(id: unknown): Promise<void>;
  modify(
    transform: (
      doc: Record<string, unknown>,
    ) =>
      | Record<string, unknown>
      | null
      | void
      | Promise<Record<string, unknown> | null | void>,
  ): Promise<number>;
}

export interface LocalTableMigrationContext {
  table: string;
  fromVersion: number;
  toVersion: number;
  targetVersion: number;
  schema: Definition;
  docs: LocalTableDocsApi;
}

export type LocalTableMigrationStep = (
  ctx: LocalTableMigrationContext,
) => Promise<void> | void;

export interface LocalMigrationAdapter {
  transaction<T>(work: () => Promise<T> | T): Promise<T>;
  list(table: string): Promise<Array<Record<string, unknown>>>;
  patch(
    table: string,
    id: unknown,
    fields: Record<string, unknown>,
  ): Promise<void>;
  replace(
    table: string,
    id: unknown,
    fields: Record<string, unknown>,
  ): Promise<void>;
  delete(table: string, id: unknown): Promise<void>;
}

/** Generic mutation reference type. At runtime this is a Convex `FunctionReference<"mutation">`. */
export type MutationRef = Record<string, unknown>;

export interface MigrationConfig {
  /** Table name being migrated. */
  table: string;

  /** Current schema definition. */
  schema: Definition;

  /** Per-version migration functions (keyed by target version number). */
  migrations?: Record<number, MutationRef | LocalTableMigrationStep>;

  /** Error handler when a migration fails. */
  onMigrationError?: MigrationErrorHandler;
}

// ---------------------------------------------------------------------------
// Schema version table name — used in local embedded runtime docstore
// ---------------------------------------------------------------------------

const VERSION_TABLE = "_resolve_schema_versions";

// ---------------------------------------------------------------------------
// Minimal structural type for a mutation context used by the migration runner.
// ---------------------------------------------------------------------------

interface MigrationCtx {
  db: {
    query(table: string): {
      withIndex(
        indexName: string,
        builder: (q: {
          eq(fieldName: string, value: unknown): unknown;
        }) => unknown,
      ): {
        collect(): Promise<Array<Record<string, unknown>>>;
      };
      collect(): Promise<Array<Record<string, unknown>>>;
    };
    patch(id: unknown, fields: Record<string, unknown>): Promise<void>;
    insert(table: string, doc: Record<string, unknown>): Promise<unknown>;
    delete(id: unknown): Promise<void>;
  };
  runMutation(fn: MutationRef, args: Record<string, unknown>): Promise<unknown>;
  local?: LocalMigrationAdapter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDocsApi(
  local: LocalMigrationAdapter,
  table: string,
): LocalTableDocsApi {
  return {
    all() {
      return local.list(table);
    },

    async patchMissing(fields) {
      const docs = await local.list(table);
      let patched = 0;
      for (const doc of docs) {
        const updates: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(fields)) {
          if (doc[field] === undefined) {
            updates[field] = value;
          }
        }
        if (Object.keys(updates).length === 0) continue;
        await local.patch(table, doc._id, updates);
        patched++;
      }
      return patched;
    },

    patch(id, fields) {
      return local.patch(table, id, fields);
    },

    replace(id, fields) {
      return local.replace(table, id, fields);
    },

    delete(id) {
      return local.delete(table, id);
    },

    async modify(transform) {
      const docs = await local.list(table);
      let changed = 0;
      for (const doc of docs) {
        const next = await transform(doc);
        if (next === undefined) {
          continue;
        }
        if (next === null) {
          await local.delete(table, doc._id);
          changed++;
          continue;
        }

        const { _id, _creationTime, ...rest } = next;
        await local.replace(table, doc._id, {
          ...rest,
          _id: doc._id,
          _creationTime: doc._creationTime,
        });
        changed++;
      }
      return changed;
    },
  };
}

async function runLocalMigration(
  ctx: MigrationCtx,
  table: string,
  schemaDef: Definition,
  version: number,
  migrationFn: LocalTableMigrationStep,
): Promise<void> {
  const local = ctx.local;
  if (!local) {
    throw new Error(
      `Local migration step for table "${table}" requires a local migration adapter`,
    );
  }

  await local.transaction(async () => {
    await migrationFn({
      table,
      fromVersion: version - 1,
      toVersion: version,
      targetVersion: schemaDef.version,
      schema: schemaDef,
      docs: createDocsApi(local, table),
    });
  });
}

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
export async function runMigrations(
  ctx: MigrationCtx,
  config: MigrationConfig,
): Promise<boolean> {
  const {
    table,
    schema: schemaDef,
    migrations = {},
    onMigrationError,
  } = config;
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
    throw new Error(
      `runMigrations: ${table} is at version ${storedVersion} but target is ${targetVersion}. Forward-only migrations do not support opening newer local data with an older app.`,
    );
  }

  // Run migrations from storedVersion+1 to targetVersion, in sequence
  for (let v = storedVersion + 1; v <= targetVersion; v++) {
    log.info(`runMigrations: migrating ${table} from v${v - 1} to v${v}`);

    const migrationFn = migrations[v];

    const stepResult = await Fx.run(
      Fx.gen(function* () {
        if (migrationFn) {
          if (typeof migrationFn === "function") {
            yield* Fx.from({
              ok: () =>
                runLocalMigration(ctx, table, schemaDef, v, migrationFn),
              err: (e) => e as Error,
            });
          } else {
            yield* Fx.from({
              ok: () => ctx.runMutation(migrationFn, {}),
              err: (e) => e as Error,
            });
          }
          log.info(`runMigrations: ${table} v${v} migration completed`);
        } else {
          yield* Fx.from({
            ok: () => applyDefaults(ctx, table, schemaDef, v),
            err: (e) => e as Error,
          });
          log.info(`runMigrations: ${table} v${v} defaults applied`);
        }

        yield* Fx.from({
          ok: () => setStoredVersion(ctx, table, v),
          err: (e) => e as Error,
        });

        return "ok" as const;
      }).pipe(
        Fx.recover((err) =>
          Fx.gen(function* () {
            log.error(`runMigrations: ${table} v${v} migration failed`, err);

            if (onMigrationError) {
              const recoveryCtx: RecoveryContext = {
                canResetSafely: true,
                currentVersion: v - 1,
                targetVersion,
              };

              const recovery = yield* Fx.from({
                ok: () =>
                  onMigrationError(
                    err instanceof Error ? err : new Error(String(err)),
                    recoveryCtx,
                  ),
                err: (e) => e as Error,
              });

              yield* Fx.from({
                ok: () => handleRecovery(ctx, table, recovery, targetVersion),
                err: (e) => e as Error,
              });
            } else {
              return yield* Fx.fail(err);
            }

            return "recovered" as const;
          }),
        ),
      ),
    );

    if (stepResult === "recovered") {
      return true;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Version storage helpers
// ---------------------------------------------------------------------------

async function getStoredVersion(
  ctx: MigrationCtx,
  table: string,
): Promise<number | null> {
  return Fx.run(
    Fx.from({
      ok: async () => {
        const records = await ctx.db
          .query(VERSION_TABLE)
          .withIndex("by_table", (q) => q.eq("table", table))
          .collect();

        if (records.length === 0) return null;
        if (records.length > 1) {
          log.warn(
            `getStoredVersion: found ${records.length} version rows for ${table}`,
          );
        }

        const versions = records
          .map((record) => Number(record.version))
          .filter(Number.isFinite);

        return versions.length > 0 ? Math.max(...versions) : null;
      },
      err: (e) => e as Error,
    }).pipe(Fx.recover(() => Fx.succeed(null))),
  );
}

async function setStoredVersion(
  ctx: MigrationCtx,
  table: string,
  version: number,
): Promise<void> {
  const effect = Fx.from({
    ok: async () => {
      const existing = await ctx.db
        .query(VERSION_TABLE)
        .withIndex("by_table", (q) => q.eq("table", table))
        .collect();

      if (existing.length === 0) {
        await ctx.db.insert(VERSION_TABLE, { table, version });
        return;
      }

      const [primary, ...duplicates] = existing;
      let staleRows = duplicates;

      try {
        await ctx.db.patch(primary._id, { version });
      } catch (patchError) {
        log.warn(
          `setStoredVersion: patch failed for ${table}, inserting replacement row`,
          patchError,
        );
        await ctx.db.insert(VERSION_TABLE, { table, version });
        staleRows = [primary, ...duplicates];
      }

      for (const stale of staleRows) {
        await ctx.db.delete(stale._id);
      }

      if (staleRows.length > 0) {
        log.warn(
          `setStoredVersion: removed ${staleRows.length} stale version row(s) for ${table}`,
        );
      }
    },
    err: (err) => err as Error,
  }).pipe(
    Fx.inspect((err) =>
      Fx.sync(() =>
        log.warn(`setStoredVersion: could not store version for ${table}`, err),
      ),
    ),
  );

  await Fx.run(effect);
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

  if (ctx.local) {
    await ctx.local.transaction(async () => {
      await createDocsApi(ctx.local!, table).patchMissing(defaults);
    });
    return;
  }

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
