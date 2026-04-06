import type { Database } from "@/runtime/db/database";
import type {
  StoreMigrationScope,
  StoreVersionRecord,
} from "@/runtime/migrations/types";

export const STORE_VERSION_TABLE = "_resolve_store_versions";

function matchesVersionRecord(
  row: Record<string, unknown>,
  input: {
    store: string;
    scope: StoreMigrationScope;
    identityKey: string | null;
  },
): boolean {
  return (
    row.store === input.store &&
    row.scope === input.scope &&
    (input.scope === "global"
      ? row.identityKey === undefined || row.identityKey === null
      : row.identityKey === input.identityKey)
  );
}

function withVersionIdentityKey(
  scope: StoreMigrationScope,
  identityKey: string | null,
): string | null | undefined {
  return scope === "identity" ? identityKey : undefined;
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
  const existing = db
    .getDocumentsForTable(STORE_VERSION_TABLE)
    .filter((row) => matchesVersionRecord(row, input));

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
  db.patch(undefined, primary._id, doc);
  for (const stale of duplicates) {
    db.delete(undefined, stale._id);
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
  const rows = db
    .getDocumentsForTable(STORE_VERSION_TABLE)
    .filter((row) => matchesVersionRecord(row, input));
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
    db.commit();
  } catch (error) {
    db.rollbackWrites();
    throw error;
  }
}

export async function listStoredVersions(
  db: Database,
): Promise<StoreVersionRecord[]> {
  return db.getDocumentsForTable(STORE_VERSION_TABLE).map((row) => ({
    store:
      typeof row.store === "string"
        ? row.store
        : JSON.stringify(row.store ?? ""),
    scope: (row.scope as StoreMigrationScope | undefined) ?? "global",
    identityKey: (row.identityKey as string | null | undefined) ?? null,
    version: Number(row.version),
  }));
}
