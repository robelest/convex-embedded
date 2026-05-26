import type { Database } from "@/runtime/db/database";
import type { DocumentId } from "@/runtime/db/types";
import type {
  StoreMigrationScope,
  StoreVersionRecord,
} from "@/runtime/migrations/types";

const STORE_VERSION_TABLE = "_resolve_store_versions";

async function readVersionRows(
  db: Database,
  input: {
    store: string;
    scope: StoreMigrationScope;
    identityKey: string | null;
  },
): Promise<Record<string, unknown>[]> {
  const qid = db.startQueryAsync({
    source: {
      type: "IndexRange",
      indexName: `${STORE_VERSION_TABLE}.by_store_scope_and_identity`,
      range: [
        { type: "Eq", fieldPath: "store", value: input.store },
        { type: "Eq", fieldPath: "scope", value: input.scope },
        {
          type: "Eq",
          fieldPath: "identityKey",
          value: withVersionIdentityKey(input.scope, input.identityKey),
        },
      ],
      order: "asc",
    } as never,
    operators: [],
  });

  const rows: Record<string, unknown>[] = [];
  try {
    while (true) {
      const next = await db.queryNextAsync(qid);
      if (next.done) {
        return rows;
      }
      rows.push(next.value as Record<string, unknown>);
    }
  } finally {
    db.queryCleanup(qid);
  }
}

function withVersionIdentityKey(
  scope: StoreMigrationScope,
  identityKey: string | null,
): string | null | undefined {
  return scope === "identity" ? identityKey : null;
}

async function writeVersionRows(
  db: Database,
  input: {
    store: string;
    scope: StoreMigrationScope;
    identityKey: string | null;
    version: number;
  },
): Promise<void> {
  const existing = await readVersionRows(db, input);

  const doc = {
    store: input.store,
    scope: input.scope,
    identityKey: withVersionIdentityKey(input.scope, input.identityKey),
    version: input.version,
  };

  if (existing.length === 0) {
    db.insert(STORE_VERSION_TABLE, doc);
    return;
  }

  const [primary, ...duplicates] = existing;
  db.patch(undefined, primary!._id as DocumentId, doc);
  for (const stale of duplicates) {
    db.delete(undefined, stale._id as DocumentId);
  }
}

export async function getStoredVersion(
  db: Database,
  input: {
    store: string;
    scope: StoreMigrationScope;
    identityKey: string | null;
  },
): Promise<number | null> {
  const rows = await readVersionRows(db, input);
  const versions = rows
    .map((row) => Number(row.version))
    .filter(Number.isFinite);
  return versions.length > 0 ? Math.max(...versions) : null;
}

export async function setStoredVersion(
  db: Database,
  input: {
    store: string;
    scope: StoreMigrationScope;
    identityKey: string | null;
    version: number;
  },
): Promise<void> {
  db.startTransaction();
  try {
    await writeVersionRows(db, input);
    await db.commitAsync();
  } catch (error) {
    db.rollbackWrites();
    throw error;
  }
}

export async function listStoredVersions(
  db: Database,
): Promise<StoreVersionRecord[]> {
  return (await db.listDocumentsAsync(STORE_VERSION_TABLE)).map((row) => ({
    store:
      typeof row.store === "string"
        ? row.store
        : JSON.stringify(row.store ?? ""),
    scope: (row.scope as StoreMigrationScope | undefined) ?? "global",
    identityKey: (row.identityKey as string | null | undefined) ?? null,
    version: Number(row.version),
  }));
}
