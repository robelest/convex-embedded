/**
 * Storage adapter public surface.
 *
 * Pick an adapter. Pass it to the runtime. Done.
 *
 * ```ts
 * import { SqliteAdapter } from "@robelest/convex-embedded";
 *
 * // SQL-backed — pass a platform driver
 * const durable = new SqliteAdapter(driver);
 * ```
 *
 * Adapters implement {@link StorageAdapter} (blob-only) or
 * {@link QueryableAdapter} (full document + query support).
 * Future backends slot in the same way — implement the interface, done.
 *
 * @module
 * @public
 */

export {
  isQueryable,
  type StorageAdapter,
  type QueryableAdapter,
  type WriteOptions,
  type WriteResult,
  type WriteBatch,
  type StorageMetadata,
  type QueryArgs,
  type VectorSearchArgs,
} from "./adapter";

// Public adapter surface; types not consumed inside the repo are still part
// of the @robelest/convex-embedded/storage contract for external apps.
export {
  // fallow-ignore-next-line unused-type
  type TableSnapshot,
  // fallow-ignore-next-line unused-type
  type ReadOptions,
  // fallow-ignore-next-line unused-type
  type DocumentDelete,
  // fallow-ignore-next-line unused-type
  type DocumentWithTable,
} from "./adapter";

export { SqliteAdapter } from "./sqlite/adapter";
