import type { SchemaOp } from "@/storage/adapter";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import { migratePendingEntries } from "@/runtime/migrations/pending";
import type { MigrationCoordinatorOptions } from "@/runtime/migrations/types";
import {
  getStoredVersion,
  setStoredVersion,
} from "@/runtime/migrations/versions";
import {
  runMigrations,
  type MigrationRuntimeAdapter,
  type SystemIndexRange,
} from "@/shared/migrations/migrate";

async function readPendingEntriesByIdentity(
  runtime: EmbeddedRuntime,
  identityKey: string | null,
): Promise<Array<Record<string, unknown>>> {
  return readRowsByIndex(runtime, {
    tableName: "_resolve_pending",
    indexName: "by_identity_key_and_creation_time",
    range: [{ fieldPath: "identityKey", value: identityKey }],
  });
}

async function readRowsByIndex(
  runtime: EmbeddedRuntime,
  input: {
    tableName: string;
    indexName: string;
    range: SystemIndexRange[];
  },
): Promise<Array<Record<string, unknown>>> {
  const qid = runtime.db.startQueryAsync({
    source: {
      type: "IndexRange",
      indexName: `${input.tableName}.${input.indexName}`,
      range: input.range.map((entry) => ({
        type: "Eq",
        fieldPath: entry.fieldPath,
        value: entry.value,
      })),
      order: "asc",
    } as never,
    operators: [],
  });

  const rows: Array<Record<string, unknown>> = [];
  try {
    while (true) {
      const next = await runtime.db.queryNextAsync(qid);
      if (next.done) return rows;
      rows.push(next.value as Record<string, unknown>);
    }
  } finally {
    runtime.db.queryCleanup(qid);
  }
}

function createMigrationAdapter(
  runtime: EmbeddedRuntime,
): MigrationRuntimeAdapter {
  const txWrite = async <T>(work: () => Promise<T> | T): Promise<T> => {
    runtime.db.startTransaction();
    try {
      const result = await work();
      await runtime.db.commitAsync();
      return result;
    } catch (error) {
      runtime.db.rollbackWrites();
      throw error;
    }
  };

  return {
    systemReadByIndex: (input) =>
      readRowsByIndex(runtime, {
        tableName: input.table,
        indexName: input.indexName,
        range: input.range,
      }),
    systemInsert: (table, doc) =>
      txWrite(async () => runtime.db.insert(table, doc) as unknown as string),
    systemPatch: (id, fields) =>
      txWrite(async () => {
        runtime.db.patch(undefined, id as never, fields);
      }),
    systemDelete: (id) =>
      txWrite(async () => {
        runtime.db.delete(undefined, id as never);
      }),

    tableList: (table) => runtime.db.listDocumentsAsync(table),
    tableGet: async (table, id) => {
      const docs = await runtime.db.listDocumentsAsync(table);
      return (docs as Array<Record<string, unknown>>).find(
        (doc) => doc._id === id,
      ) ?? null;
    },
    tableInsert: (table, doc) =>
      txWrite(async () => runtime.db.insert(table, doc) as unknown as string),
    tablePatch: (_table, id, fields) =>
      txWrite(async () => {
        runtime.db.patch(undefined, id as never, fields);
      }),
    tableReplace: (_table, id, fields) =>
      txWrite(async () => {
        runtime.db.replace(undefined, id as never, fields);
      }),
    tableDelete: (_table, id) =>
      txWrite(async () => {
        runtime.db.delete(undefined, id as never);
      }),

    applySchemaOps: async (table: string, ops: readonly SchemaOp[]) => {
      const storage = runtime.getStorage() as unknown as
        | { applySchemaOps?: (t: string, o: readonly SchemaOp[]) => Promise<void> }
        | null;
      if (!storage || typeof storage.applySchemaOps !== "function") return;
      await storage.applySchemaOps(table, ops);
    },
  };
}

export async function runLocalMigrations(
  runtime: EmbeddedRuntime,
  options: MigrationCoordinatorOptions,
): Promise<void> {
  const adapter = createMigrationAdapter(runtime);

  for (const manifest of options.storeManifests) {
    await runStoreManifest(runtime, options.identityKey, manifest);
  }

  await migratePendingEntries(
    {
      transaction: async <T>(work: () => Promise<T> | T): Promise<T> => {
        runtime.db.startTransaction();
        try {
          const result = await work();
          await runtime.db.commitAsync();
          return result;
        } catch (error) {
          runtime.db.rollbackWrites();
          throw error;
        }
      },
      list: async (identityKey) =>
        readPendingEntriesByIdentity(runtime, identityKey),
      patch: async (id, fields) => {
        runtime.db.patch("_resolve_pending", id as never, fields);
      },
    },
    options.identityKey,
    options.replayMetadata,
  );

  for (const [table, schema] of options.tableDefinitions) {
    await runMigrations({ table, schema, adapter });
  }
}

async function runStoreManifest(
  runtime: EmbeddedRuntime,
  identityKey: string | null,
  manifest: import("@/runtime/migrations/types").StoreMigrationManifest,
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
