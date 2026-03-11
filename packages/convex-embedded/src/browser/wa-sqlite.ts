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

/** Distributive Omit that works correctly over discriminated unions. */
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;
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
 * Options for the browser wa-sqlite storage backend.
 *
 * @internal
 */
export interface SqliteOptions {
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

/** Default timeout for worker RPC calls (ms). */
const RPC_TIMEOUT_MS = 15_000;

/**
 * Send an RPC request to the worker and return a promise that resolves
 * with the result. Rejects if the worker reports an error, fails to
 * deserialize the message, or does not respond within the timeout.
 *
 * Also listens for `error` and `messageerror` events on the worker so
 * that silent startup failures (e.g. Firefox failing to import CDN
 * modules inside a module worker) surface as rejections instead of
 * hanging the hydration gate forever.
 */
function rpc(
  worker: Worker,
  request: DistributiveOmit<StorageRequest, "id">,
  transfer?: Transferable[],
  timeoutMs: number = RPC_TIMEOUT_MS,
): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      clearTimeout(timer);
    };

    const onMessage = (event: MessageEvent<StorageResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.ok) {
        resolve(event.data.result);
      } else {
        reject(new Error(event.data.error));
      }
    };

    const onError = (event: ErrorEvent) => {
      if (settled) return;
      cleanup();
      reject(
        new Error(
          `wa-sqlite worker error: ${event.message || "unknown error"}`,
        ),
      );
    };

    const onMessageError = (_event: MessageEvent) => {
      if (settled) return;
      cleanup();
      reject(
        new Error(
          "wa-sqlite worker messageerror: could not deserialize message " +
            "(structured clone failed)",
        ),
      );
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(
        new Error(
          `wa-sqlite worker RPC timed out after ${timeoutMs}ms ` +
            `(method: ${(request as any).method})`,
        ),
      );
    }, timeoutMs);

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    worker.postMessage({ ...request, id }, { transfer: transfer ?? [] });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open the browser wa-sqlite storage backend.
 *
 * Spawns a Dedicated Worker, initializes wa-sqlite with IndexedDB
 * persistence via `IDBBatchAtomicVFS`, and returns a fully initialized
 * {@link StorageAdapter}.
 *
 * @internal
 */
export async function openWaSqliteStorage(
  options: SqliteOptions,
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
      // Acquire: spawn the Dedicated Worker and wait for it to load.
      // We race the worker's `error` event against a short settling
      // delay — if the script fails to load (e.g. Firefox blocking
      // CDN module imports inside a module worker), the error event
      // fires before the first RPC is even sent.
      Fx.from({
        ok: () => {
          const worker = new Worker(workerUrl, { type: "module" });
          return new Promise<Worker>((resolve, reject) => {
            let settled = false;

            const onError = (event: ErrorEvent) => {
              if (settled) return;
              settled = true;
              worker.removeEventListener("error", onError);
              reject(
                new Error(
                  `wa-sqlite worker failed to load: ${event.message || "unknown error"}`,
                ),
              );
            };

            worker.addEventListener("error", onError);

            // Give the worker a microtask to fail. If it doesn't, proceed.
            // The init RPC has its own timeout for later failures.
            queueMicrotask(() => {
              if (settled) return;
              settled = true;
              worker.removeEventListener("error", onError);
              resolve(worker);
            });
          });
        },
        err: (err) =>
          new Error(
            `wa-sqlite worker spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      }),

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
 * Extracted from `openWaSqliteStorage` for clarity.
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
