---
title: Persistence
description:
  How documents are persisted to IndexedDB via wa-sqlite, and how to configure
  storage options.
---

<svelte:head>

  <title>Persistence - convex-embedded</title>
</svelte:head>

# Persistence

By default, `convex-embedded` persists all documents to IndexedDB using
wa-sqlite compiled to WebAssembly. Data survives page refreshes and browser
restarts. This page covers how the storage layer works and how to configure it.

## wa-sqlite (Default)

The default storage backend uses wa-sqlite with the `IDBBatchAtomicVFS` virtual
file system. This stores SQLite database pages as IndexedDB entries, giving you
a full relational database with ACID transactions inside the browser.

### Dedicated Worker

wa-sqlite runs in a **Dedicated Worker** to keep heavy database operations off
the main thread. The main-thread `StorageAdapter` proxy communicates with the
worker via `postMessage`:

- **JSON strings** for document data and metadata.
- **`ArrayBuffer`s** for binary blobs (transferred, not copied).
- **`WebAssembly.Module`** for the compiled wa-sqlite binary (transferred once
  at init).

No functions, proxies, or other non-cloneable objects cross the boundary.

### Initialization Flow

When `createConvexClient()` is called:

1. The wa-sqlite WASM module is compiled via `compileWasmModule()`.
2. A Dedicated Worker is spawned.
3. The compiled `WebAssembly.Module` is transferred to the worker.
4. The worker initializes wa-sqlite with `IDBBatchAtomicVFS` and the configured
   database name.
5. All persisted documents are read from SQLite and loaded into the in-memory
   database (hydration).
6. The hydration gate resolves, and the `ConvexClient` starts processing
   messages.

### Operations

The `StorageAdapter` interface exposes these operations, all delegated to the
worker via RPC:

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
- Tab A broadcasts a `BroadcastChannel` message listing the written tables.
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

If no storage adapter is provided (and the wa-sqlite setup is skipped), the
runtime operates as a **purely in-memory** database. All data is lost on page
refresh.

This mode is primarily useful for testing or for transient UI state that does
not need to persist. When `createConvexClient()` is called and the wa-sqlite
worker fails to initialize, the runtime falls back to ephemeral mode.

## StorageAdapter Interface

You can implement a custom storage backend by providing an object that satisfies
the `StorageAdapter` interface:

```ts
interface StorageAdapter {
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
const customStorage: StorageAdapter = {
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

## Preloading

The wa-sqlite WASM binary can be preloaded to avoid a cold-start delay. The
`browser` entry point exports utilities for this:

```ts
import {
  preloadLinks,
  injectPreloadLinks,
  compileWasmModule,
  WASM_URL,
} from "@robelest/convex-embedded/browser";
```

| Utility                | Description                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `preloadLinks()`       | Returns an array of `<link rel="preload">` descriptors.                                     |
| `injectPreloadLinks()` | Appends preload links to the document head.                                                 |
| `compileWasmModule()`  | Compiles the WASM binary into a `WebAssembly.Module` that can be transferred to the worker. |
| `WASM_URL`             | The CDN URL of the wa-sqlite binary.                                                        |

These are called automatically by `createConvexClient()` but can be invoked
earlier (e.g., in a service worker or during SSR preload) for faster startup.
