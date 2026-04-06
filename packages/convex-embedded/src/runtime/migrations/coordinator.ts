import { migratePendingEntries } from "@/client/pending";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type {
  MigrationCoordinatorOptions,
  StoreMigrationManifest,
} from "@/runtime/migrations/types";
import {
  getStoredVersion,
  setStoredVersion,
} from "@/runtime/migrations/versions";
import { createLogger } from "@/shared/logger";
import {
  runMigrations,
  type LocalMigrationAdapter,
} from "@/shared/migration-utils";

const log = createLogger("migrations");

function createLocalMigrationAdapter(
  runtime: EmbeddedRuntime,
): LocalMigrationAdapter {
  return {
    async transaction(work) {
      runtime.db.startTransaction();
      try {
        const result = await work();
        runtime.db.commit();
        return result;
      } catch (error) {
        runtime.db.rollbackWrites();
        throw error;
      }
    },

    async list(table) {
      return runtime.db.getDocumentsForTable(table);
    },

    async patch(_table, id, fields) {
      runtime.db.patch(undefined, id as never, fields);
    },

    async replace(_table, id, fields) {
      runtime.db.replace(undefined, id as never, fields);
    },

    async delete(_table, id) {
      runtime.db.delete(undefined, id as never);
    },
  };
}

async function runStoreManifest(
  runtime: EmbeddedRuntime,
  identityKey: string | null,
  manifest: StoreMigrationManifest,
): Promise<void> {
  const storedVersion = await getStoredVersion(runtime.db, {
    store: manifest.store,
    scope: manifest.scope,
    identityKey,
  });

  if (storedVersion === null) {
    await setStoredVersion(runtime.db, {
      store: manifest.store,
      scope: manifest.scope,
      identityKey,
      version: manifest.version,
    });
    return;
  }

  if (storedVersion > manifest.version) {
    throw new Error(
      `Local store "${manifest.store}" is at version ${storedVersion}, but this app only supports ${manifest.version}. Forward-only local migrations cannot open newer persisted data with an older app version.`,
    );
  }

  for (
    let version = storedVersion + 1;
    version <= manifest.version;
    version++
  ) {
    const step = manifest.migrate?.[version];
    if (step) {
      log.info(`migrating local store ${manifest.store} to v${version}`);
      await step({ identityKey });
    }
    await setStoredVersion(runtime.db, {
      store: manifest.store,
      scope: manifest.scope,
      identityKey,
      version,
    });
  }
}

export async function runLocalMigrations(
  runtime: EmbeddedRuntime,
  options: MigrationCoordinatorOptions,
): Promise<void> {
  const local = createLocalMigrationAdapter(runtime);

  for (const manifest of options.storeManifests) {
    await runStoreManifest(runtime, options.identityKey, manifest);
  }

  await migratePendingEntries(
    {
      transaction: (work) => local.transaction(work),
      list: async (identityKey) =>
        runtime.db
          .getDocumentsForTable("_resolve_pending")
          .filter((row) => (row.identityKey ?? null) === identityKey),
      patch: async (id, fields) => {
        runtime.db.patch("_resolve_pending", id as never, fields);
      },
    },
    options.identityKey,
    options.replayMetadata,
  );

  for (const [table, schema] of options.tableDefinitions) {
    await runMigrations(
      {
        db: {
          query: (tableName) => ({
            withIndex: (_indexName, builder) => ({
              collect: async () => {
                const predicate = builder({
                  eq: (fieldName: string, value: unknown) => ({
                    fieldName,
                    value,
                  }),
                }) as { fieldName: string; value: unknown };

                return runtime.db
                  .getDocumentsForTable(tableName)
                  .filter(
                    (row) => row[predicate.fieldName] === predicate.value,
                  );
              },
            }),
            collect: async () => runtime.db.getDocumentsForTable(tableName),
          }),
          patch: async (id, fields) => {
            runtime.db.startTransaction();
            try {
              runtime.db.patch(undefined, id as never, fields);
              runtime.db.commit();
            } catch (error) {
              runtime.db.rollbackWrites();
              throw error;
            }
          },
          insert: async (tableName, doc) => {
            runtime.db.startTransaction();
            try {
              const id = runtime.db.insert(tableName, doc);
              runtime.db.commit();
              return id;
            } catch (error) {
              runtime.db.rollbackWrites();
              throw error;
            }
          },
          delete: async (id) => {
            runtime.db.startTransaction();
            try {
              runtime.db.delete(undefined, id as never);
              runtime.db.commit();
            } catch (error) {
              runtime.db.rollbackWrites();
              throw error;
            }
          },
        },
        runMutation: async () => {
          throw new Error(
            `Remote mutation-based table migrations are not supported during local startup for table "${table}". Use embeddedTable(..., { migrate }) local steps instead.`,
          );
        },
        local,
      },
      {
        table,
        schema,
        migrations: schema.migrate,
      },
    );
  }
}
