---
title: Persistence
description:
  How documents are persisted through browser sqlite backed by OPFS, and how to
  configure storage options.
---

<svelte:head>

  <title>Persistence - convex-embedded</title>
</svelte:head>

# Persistence

By default, `convex-embedded` persists documents through browser sqlite backed
by OPFS. This page starts with the parts you actually configure, then explains
how the storage layer works.

## What you configure

```ts
const client = createConvexClient({
  modules,
  name: "my-app-data",
  encryption: myEncryptionHooks,
});
```

The important browser-facing knobs are:

- `name` for database sharing/isolation
- `encryption` if you want persisted local state encrypted at rest

## Browser SQLite (Default)

The default storage backend uses `@effect/sql-sqlite-wasm` with an OPFS-backed
worker. This gives you a full relational database with ACID transactions inside
the browser.

### Dedicated Worker

Browser sqlite runs in a **Dedicated Worker** to keep heavy database operations
off the main thread. The main-thread `PersistenceAdapter` proxy communicates
with the worker through the sqlite-wasm worker protocol:

- **JSON strings** for document data and metadata.
- **`ArrayBuffer`s** for binary blobs (transferred, not copied). No Convex
  modules, functions, or other non-cloneable objects cross the boundary.

### Initialization Flow

When `createConvexClient()` is called:

1. A Dedicated Worker is spawned.
2. The worker initializes OPFS-backed sqlite for the configured database name.
3. All persisted documents are read from SQLite and loaded into the in-memory
   database (hydration).
4. The hydration gate resolves, and the `ConvexClient` starts processing
   messages.

### Operations

The `PersistenceAdapter` interface exposes these operations, all delegated to
the browser sqlite adapter:

| Method                       | Description                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `getDocuments()`             | Return all persisted documents with their table names. Used during hydration.         |
| `getDocumentsByTable(table)` | Return documents for a single table. Used by cross-tab remote for incremental reload. |
| `getMeta()`                  | Return database metadata (timestamp, last creation time).                             |
| `getBlobs()`                 | Return all persisted binary blobs.                                                    |
| `commit(batch)`              | Atomically persist a batch of puts, deletes, and metadata.                            |
| `storeBlob(id, blob)`        | Store a binary blob.                                                                  |
| `deleteBlob(id)`             | Delete a binary blob.                                                                 |
| `clear()`                    | Delete all data.                                                                      |
| `close()`                    | Close the database and terminate the worker.                                          |

Each RPC call has a 15-second timeout. If the worker fails to respond, the
promise rejects with a timeout error.

## Browser Storage URLs (Alpha)

When you use `createConvexClient()` in the browser, `convex-embedded` installs a
browser storage surface on top of the persisted blob store.

- `ctx.storage.getUrl(storageId)` returns a local `blob:` URL.
- Repeated `getUrl()` calls for the same blob reuse the same object URL until
  the stored blob changes or is deleted.
- When the blob is deleted, the cached object URL is revoked and `getUrl()`
  returns `null`.
- `ctx.storage.generateUploadUrl()` returns a local upload URL that can be used
  with normal browser `fetch(...)`.

This keeps the DX aligned with standard Convex storage code while still using
local browser-backed persistence under the hood.

```ts
const uploadUrl = await client.mutation(api.files.generateUploadUrl, {});

const response = await fetch(uploadUrl, {
  method: "POST",
  headers: { "Content-Type": file.type },
  body: file,
});

const { storageId } = await response.json();
```

### Alpha Semantics

- Browser download URLs are `blob:` URLs for alpha.
- Upload URLs are single-use and expire after a successful upload.
- Upload URLs accept `POST` requests only.
- The storage surface is implemented by the platform entry point (`/browser`),
  not by `PersistenceAdapter` itself.
- If a runtime has no platform storage surface installed, `getUrl()` and
  `generateUploadUrl()` fail closed with a clear error.

## Database Naming

The `name` option controls the IndexedDB database name:

```ts
const client = createConvexClient({
  modules,
  name: "my-app-data", // default: "convex-embedded"
});
```

### Shared Data Across Tabs

Tabs that use the same `name` share the same underlying SQLite database in
IndexedDB. This means:

- A mutation in Tab A is persisted to IndexedDB.
- Tab A broadcasts a write notification listing the written tables.
- Tab B receives the notification, re-reads the affected tables from IndexedDB,
  and updates its in-memory state.
- Tab B's `ConvexClient` receives updated query results instantly.

### Isolated Data Between Names

Different names create completely separate databases:

```ts
// These two clients have independent data stores
const clientA = createConvexClient({ modules, name: "workspace-1" });
const clientB = createConvexClient({ modules, name: "workspace-2" });
```

This is useful for multi-tenant apps or when you want to isolate data per user
account.

## Ephemeral Storage

If no storage adapter is provided (or the storage layer is intentionally
skipped), the runtime operates as a purely in-memory database. All data is lost
on page refresh.

This mode is primarily useful for testing or for transient UI state that does
not need to persist. When `createConvexClient()` is called and the wa-sqlite
worker fails to initialize, the runtime falls back to ephemeral mode.

## PersistenceAdapter Interface

You can implement a custom storage backend by providing an object that satisfies
the `PersistenceAdapter` interface:

```ts
interface PersistenceAdapter {
  // Hydration -- called once on startup
  getDocuments(): Promise<StoredDocumentWithTable[]>;
  getDocumentsByTable(tableName: string): Promise<StoredDocument[]>;
  getMeta(): Promise<DatabaseMeta | null>;
  getBlobs(): Promise<Array<{ id: string; blob: Blob }>>;

  // Persistence -- called on each commit
  commit(batch: CommitBatch): Promise<void>;
  storeBlob(id: string, blob: Blob): Promise<void>;
  deleteBlob(id: string): Promise<void>;

  // Lifecycle
  clear(): Promise<void>;
  close?(): Promise<void>;
}
```

### CommitBatch

Each call to `commit()` receives a batch containing:

```ts
interface CommitBatch {
  puts: Array<{ doc: StoredDocument; tableName: string }>;
  deletes: string[];
  meta: { timestamp: number; lastCreationTime: number };
}
```

The adapter should write all puts, deletes, and meta in a **single atomic
transaction** when the backend supports it. If atomicity is not possible, writes
must be applied in the order: puts, deletes, then meta.

### Custom Backend Example

```ts
const customStorage: PersistenceAdapter = {
  async getDocuments() {
    // Read all documents from your backend
    return [];
  },
  async getDocumentsByTable(tableName) {
    // Read documents for a single table
    return [];
  },
  async getMeta() {
    // Return stored metadata, or null on first run
    return null;
  },
  async getBlobs() {
    // Return stored binary blobs
    return [];
  },
  async commit(batch) {
    // Write puts, apply deletes, update meta atomically
  },
  async storeBlob(id, blob) {
    // Store binary data
  },
  async deleteBlob(id) {
    // Remove binary data
  },
  async clear() {
    // Delete everything
  },
};
```

This could be used to back the embedded database with a different storage engine
(e.g., OPFS, a custom server, or an in-memory store for tests).

## Worker Asset

The browser sqlite worker is bundled and resolved by the package. Most apps do
not need to configure or reference it directly.
