/**
 * Persistence adapter public surface.
 *
 * Pick an adapter. Pass it to the runtime. Done.
 *
 * ```ts
 * import {
 *   SqliteAdapter,
 *   OpaqueAdapter,
 * } from "@robelest/convex-embedded";
 *
 * // In-memory, zero config
 * const ephemeral = new OpaqueAdapter();
 *
 * // SQL-backed — pass a platform driver
 * const durable = await SqliteAdapter.open(driver);
 * ```
 *
 * Both extend the same abstract {@link PersistenceAdapter} class. Future
 * backends slot in the same way — extend the base class, done. No `kind`
 * field, no registry, no capability flags to set.
 *
 * @module
 * @public
 */

export {
  PersistenceAdapter,
  type AtomicCommitOptions,
  type AtomicCommitResult,
  type CommitBatch,
  type CommittedTableSnapshot,
  type DatabaseMeta,
  type QueryRead,
  type ReadOptions,
  type StoredDocumentDelete,
  type StoredDocumentWithTable,
  type VectorRead,
} from "./adapter";

export { OpaqueAdapter } from "./opaque/adapter";
export { SqliteAdapter } from "./sqlite/adapter";
