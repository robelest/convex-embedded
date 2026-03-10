/**
 * Main-thread {@link StorageAdapter} backed by wa-sqlite running in a
 * Dedicated Worker.
 *
 * This module is imported on the **main thread**. It creates a Dedicated
 * Worker running `wa-sqlite-worker.ts`, sends `StorageAdapter` method
 * calls via `postMessage`, and returns promises that resolve when the
 * worker responds.
 *
 * Only plain JSON data (documents, metadata) and `ArrayBuffer`s (blobs)
 * cross the `postMessage` boundary — no functions, no Proxy objects.
 *
 * @packageDocumentation
 */

import { Fx } from "@robelest/fx";

import type {
  StorageRequest,
  StorageResponse,
} from "@/browser/wa-sqlite-worker";
import type { StoredDocument } from "@/core/types";
import type {
  CommitBatch,
  DatabaseMeta,
  StorageAdapter,
  StoredDocumentWithTable,
} from "@/storage/adapter";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link createWaSqliteStorage}.
 */
export interface WaSqliteStorageOptions {
  /** IndexedDB database name (e.g. `"convex-embedded"`). */
  name: string;
  /**
   * Pre-compiled `WebAssembly.Module` for wa-sqlite.
   * Obtain via `compileWasmModule()` from `preload.ts`.
   */
  wasmModule: WebAssembly.Module;
  /**
   * URL of the wa-sqlite worker script.
   *
   * In development (Vite), this is typically resolved via:
   * ```ts
   * new URL("./wa-sqlite-worker.ts", import.meta.url)
   * ```
   *
   * In production (built package), it defaults to `./wa-sqlite-worker.js`
   * relative to this module.
   */
  workerUrl?: URL | string;
}

// ---------------------------------------------------------------------------
// RPC helper
// ---------------------------------------------------------------------------

/** Auto-incrementing request ID for matching responses. */
let nextId = 1;

/**
 * Send an RPC request to the worker and return a promise that resolves
 * with the result. Rejects if the worker reports an error.
 */
function rpc(
  worker: Worker,
  request: Omit<StorageRequest, "id">,
  transfer?: Transferable[],
): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<StorageResponse>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", handler);
      if (event.data.ok) {
        resolve(event.data.result);
      } else {
        reject(new Error(event.data.error));
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ ...request, id }, { transfer: transfer ?? [] });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link StorageAdapter} backed by wa-sqlite running in a
 * Dedicated Worker with IndexedDB persistence via `IDBBatchAtomicVFS`.
 *
 * The adapter delegates all SQL operations to the worker. Documents are
 * serialised as JSON strings for transport; blobs are transferred as
 * `ArrayBuffer`s.
 *
 * @param options - Database name, pre-compiled WASM module, and optional
 *   worker URL.
 * @returns A promise that resolves to a fully initialised `StorageAdapter`.
 */
export async function createWaSqliteStorage(
  options: WaSqliteStorageOptions,
): Promise<StorageAdapter> {
  const { name, wasmModule } = options;

  // Resolve worker URL.
  const workerUrl = options.workerUrl
    ? typeof options.workerUrl === "string"
      ? options.workerUrl
      : options.workerUrl.href
    : new URL("./wa-sqlite-worker.js", import.meta.url).href;

  // Use Fx.bracket to guarantee the Worker is terminated
  // if initialisation fails (prevents leaked workers).
  return Fx.run(
    Fx.bracket(
      // Acquire: spawn the Dedicated Worker.
      Fx.sync(() => new Worker(workerUrl, { type: "module" })),

      // Use: initialise wa-sqlite and build the StorageAdapter proxy.
      (worker) =>
        Fx.from({
          ok: async () => {
            // WebAssembly.Module is transferable via postMessage (per spec).
            await rpc(worker, { method: "init", name, wasmModule });
            return _buildAdapter(worker);
          },
          err: (err) =>
            new Error(
              `wa-sqlite worker init failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
        }),

      // Release: terminate the worker on failure only.
      (worker, exit) => {
        if (exit._tag === "Failure") {
          worker.terminate();
        }
        return Fx.unit;
      },
    ),
  );
}

/**
 * Build the {@link StorageAdapter} proxy that delegates to the Worker.
 * Extracted from `createWaSqliteStorage` for clarity.
 */
function _buildAdapter(worker: Worker): StorageAdapter {
  return {
    async getDocuments(): Promise<StoredDocumentWithTable[]> {
      const rows = (await rpc(worker, {
        method: "getDocuments",
      })) as Array<{ data: string; tableName: string }>;
      return rows.map((row) => ({
        doc: JSON.parse(row.data) as StoredDocument,
        tableName: row.tableName,
      }));
    },

    async getDocumentsByTable(tableName: string): Promise<StoredDocument[]> {
      const jsonStrings = (await rpc(worker, {
        method: "getDocumentsByTable",
        tableName,
      })) as string[];
      return jsonStrings.map((s) => JSON.parse(s) as StoredDocument);
    },

    async getMeta(): Promise<DatabaseMeta | null> {
      return (await rpc(worker, { method: "getMeta" })) as DatabaseMeta | null;
    },

    async getBlobs(): Promise<Array<{ id: string; blob: Blob }>> {
      const raw = (await rpc(worker, { method: "getBlobs" })) as Array<{
        id: string;
        data: ArrayBuffer;
      }>;
      return raw.map((entry) => ({
        id: entry.id,
        blob: new Blob([entry.data]),
      }));
    },

    async commit(batch: CommitBatch): Promise<void> {
      // Serialise documents to JSON strings for transport.
      const puts = batch.puts.map(({ doc, tableName }) => ({
        _id: String(doc._id),
        tableName,
        data: JSON.stringify(doc),
      }));

      await rpc(worker, {
        method: "commit",
        puts,
        deletes: batch.deletes,
        meta: {
          timestamp: batch.meta.timestamp,
          lastCreationTime: batch.meta.lastCreationTime,
        },
      });
    },

    async storeBlob(id: string, blob: Blob): Promise<void> {
      const buffer = await blob.arrayBuffer();
      await rpc(worker, { method: "storeBlob", blobId: id, data: buffer }, [
        buffer,
      ]);
    },

    async deleteBlob(id: string): Promise<void> {
      await rpc(worker, { method: "deleteBlob", blobId: id });
    },

    async clear(): Promise<void> {
      await rpc(worker, { method: "clear" });
    },

    async close(): Promise<void> {
      await rpc(worker, { method: "close" });
      worker.terminate();
    },
  };
}
