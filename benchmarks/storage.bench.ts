import { openNodeStorage } from "@embedded/node/sqlite/adapter";
import type { Database } from "@embedded/runtime/db/database";
import type { SqliteAdapter } from "@embedded/storage/sqlite/adapter";
import { temporaryDatabasePath, uniqueSuffix } from "@tests/helpers/storage";
import { bench, describe } from "@tests/testkit";

import { emptyIndexedDb, makeRows } from "./helpers";

const INSERT_BATCH = 5_000;
const insertRows = makeRows(INSERT_BATCH);

function makeBlob(bytes: number): Blob {
  const data = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 64) {
    data[index] = index % 251;
  }
  return new Blob([data]);
}

const BLOB_64K = makeBlob(64 * 1024);
const BLOB_1M = makeBlob(1024 * 1024);

const PUT_KEY_WINDOW = 256;

let writeDb: Database | null = null;
let blobStore: SqliteAdapter | null = null;
let readStore: SqliteAdapter | null = null;
let readKeys: string[] = [];
let deleteStore: SqliteAdapter | null = null;
let blobCounter = 0;

async function freshStore(): Promise<SqliteAdapter> {
  const file = temporaryDatabasePath(uniqueSuffix("bench-blob"));
  return openNodeStorage({ filename: file });
}

async function seedBlobs(
  store: SqliteAdapter,
  blob: Blob,
  count: number,
  prefix: string,
): Promise<string[]> {
  const keys = Array.from(
    { length: count },
    (_, index) => `${prefix}-${index}`,
  );
  for (const key of keys) {
    await store.storeBlob(key, blob);
  }
  return keys;
}

describe("storage substrate", () => {
  bench(
    "sqlite bulk insert x5000 (indexed, batched commit)",
    async () => {
      const db = writeDb;
      if (!db) throw new Error("write db not initialized");
      db.startTransaction();
      for (let index = 0; index < insertRows.length; index += 1) {
        db.insert(
          "tasks",
          insertRows[index] as unknown as Record<string, unknown>,
        );
      }
      await db.commitAsync();
      await db.waitForPersistence();
    },
    {
      time: 2_000,
      setup: async () => {
        const created = await emptyIndexedDb({ trackResources: false });
        writeDb = created.db;
      },
      teardown: async () => {
        if (writeDb) {
          await writeDb.waitForPersistence();
        }
        writeDb = null;
      },
    },
  );

  bench(
    "blob storeBlob 64KB",
    async () => {
      if (!blobStore) throw new Error("blob store not initialized");
      blobCounter += 1;
      await blobStore.storeBlob(
        `blob-64k-${blobCounter % PUT_KEY_WINDOW}`,
        BLOB_64K,
      );
    },
    {
      setup: async () => {
        blobStore = await freshStore();
      },
      teardown: async () => {
        await blobStore?.close();
        blobStore = null;
      },
    },
  );

  bench(
    "blob storeBlob 1MB",
    async () => {
      if (!blobStore) throw new Error("blob store not initialized");
      blobCounter += 1;
      await blobStore.storeBlob(
        `blob-1m-${blobCounter % PUT_KEY_WINDOW}`,
        BLOB_1M,
      );
    },
    {
      setup: async () => {
        blobStore = await freshStore();
      },
      teardown: async () => {
        await blobStore?.close();
        blobStore = null;
      },
    },
  );

  bench(
    "blob getBlob 64KB",
    async () => {
      if (!readStore) throw new Error("read store not initialized");
      const key = readKeys[blobCounter % readKeys.length];
      if (key) {
        await readStore.getBlob(key);
      }
      blobCounter += 1;
    },
    {
      setup: async () => {
        readStore = await freshStore();
        readKeys = await seedBlobs(readStore, BLOB_64K, 200, "read-64k");
      },
      teardown: async () => {
        await readStore?.close();
        readStore = null;
      },
    },
  );

  bench(
    "blob getBlob 1MB",
    async () => {
      if (!readStore) throw new Error("read store not initialized");
      const key = readKeys[blobCounter % readKeys.length];
      if (key) {
        await readStore.getBlob(key);
      }
      blobCounter += 1;
    },
    {
      setup: async () => {
        readStore = await freshStore();
        readKeys = await seedBlobs(readStore, BLOB_1M, 100, "read-1m");
      },
      teardown: async () => {
        await readStore?.close();
        readStore = null;
      },
    },
  );

  bench(
    "blob put+delete churn 64KB",
    async () => {
      if (!deleteStore) throw new Error("delete store not initialized");
      blobCounter += 1;
      const key = `churn-64k-${blobCounter}`;
      await deleteStore.storeBlob(key, BLOB_64K);
      await deleteStore.deleteBlob(key);
    },
    {
      setup: async () => {
        deleteStore = await freshStore();
      },
      teardown: async () => {
        await deleteStore?.close();
        deleteStore = null;
      },
    },
  );
});
