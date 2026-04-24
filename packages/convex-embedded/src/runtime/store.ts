/**
 * Runtime store — single facade over a {@link PersistenceAdapter}.
 *
 * Consumes the normalized adapter surface (`list`, `get`, `query`, `source`,
 * `atomicCommit`, etc.). No `kind` branches; decisions are driven by the
 * adapter's `supportsAtomicCommit` flag. When a capability method returns
 * `null`, the Store falls back to the `list`-based materialized path.
 *
 * @internal
 */

import { PersistenceAdapter } from "@/persistence/adapter";
import type { AsyncReadBackend } from "@/runtime/db/async_backend";
import type { Source, StoredDocument } from "@/runtime/db/types";
import type {
  CommitBatch,
  DatabaseMeta,
  PersistenceQueryRead,
  PersistenceReadOptions,
  PersistenceVectorRead,
  SqlCommitApplyOptions,
  SqlCommitApplyResult,
  StoredDocumentWithTable,
} from "@/storage/adapter";

export interface Store {
  setPersistence(storage: PersistenceAdapter | null): void;
  setReadBackendForTests(readBackend: AsyncReadBackend | null): void;
  load(input?: { tables?: string[] }): Promise<{
    documents: StoredDocumentWithTable[];
    meta: DatabaseMeta | null;
  }>;
  refreshTable(input: { tableName: string }): Promise<{
    docs: StoredDocument[] | null;
    meta: DatabaseMeta | null;
  }>;
  usesExternalCommitPath(): boolean;
  applyTopLevelCommit(
    batch: CommitBatch,
    options: SqlCommitApplyOptions,
  ): Promise<SqlCommitApplyResult | null>;
  countDocuments(tableName: string): Promise<number | null>;
  getDocument(tableName: string, id: string): Promise<StoredDocument | null>;
  listDocuments(tableName: string): Promise<StoredDocument[] | null>;
  readSource(
    source: Source,
    options?: PersistenceReadOptions,
  ): Promise<StoredDocument[] | null>;
  readQuery(args: PersistenceQueryRead): Promise<StoredDocument[] | null>;
  readVectorCandidates(
    args: PersistenceVectorRead,
  ): Promise<StoredDocument[] | null>;
  isAuthoritative(tableName: string): boolean;
}

function isAuthoritative(
  adapter: PersistenceAdapter,
  tableName: string,
): boolean {
  const fn = (adapter as { isAuthoritative?: unknown }).isAuthoritative;
  if (typeof fn !== "function") return false;
  return Boolean((fn as (t: string) => boolean).call(adapter, tableName));
}

class UnifiedStore implements Store {
  private adapter: PersistenceAdapter | null = null;
  private readOverlay: AsyncReadBackend | null = null;

  setPersistence(storage: PersistenceAdapter | null): void {
    this.adapter = storage;
  }

  setReadBackendForTests(readBackend: AsyncReadBackend | null): void {
    // Test-only overlay used by runtime/database tests to exercise pushdown
    // paths without constructing a full adapter.
    this.readOverlay = readBackend;
  }

  async load(input?: { tables?: string[] }): Promise<{
    documents: StoredDocumentWithTable[];
    meta: DatabaseMeta | null;
  }> {
    if (!this.adapter) {
      return { documents: [], meta: null };
    }
    const tables = input?.tables;
    const documents =
      tables === undefined
        ? await this.adapter.listAll()
        : tables.length === 0
          ? []
          : await this.adapter.listMany(tables);
    return { documents, meta: await this.adapter.meta() };
  }

  async refreshTable(input: { tableName: string }): Promise<{
    docs: StoredDocument[] | null;
    meta: DatabaseMeta | null;
  }> {
    if (!this.adapter) {
      return { docs: null, meta: null };
    }
    if (this.adapter.isAuthoritative(input.tableName)) {
      return { docs: null, meta: await this.adapter.meta() };
    }
    return {
      docs: await this.adapter.list(input.tableName),
      meta: await this.adapter.meta(),
    };
  }

  usesExternalCommitPath(): boolean {
    return this.adapter?.supportsAtomicCommit === true;
  }

  async applyTopLevelCommit(
    batch: CommitBatch,
    options: SqlCommitApplyOptions,
  ): Promise<SqlCommitApplyResult | null> {
    if (!this.adapter) return null;
    if (
      typeof (this.adapter as { atomicCommit?: unknown }).atomicCommit !==
      "function"
    ) {
      return null;
    }
    return this.adapter.atomicCommit(batch, options);
  }

  async countDocuments(tableName: string): Promise<number | null> {
    if (this.readOverlay?.countDocuments) {
      return this.readOverlay.countDocuments(tableName);
    }
    if (!this.adapter) return null;
    if (!isAuthoritative(this.adapter, tableName)) return null;
    return this.adapter.count(tableName);
  }

  async getDocument(
    tableName: string,
    id: string,
  ): Promise<StoredDocument | null> {
    if (this.readOverlay?.getDocument) {
      return this.readOverlay.getDocument(tableName, id as never);
    }
    if (!this.adapter) return null;
    if (!isAuthoritative(this.adapter, tableName)) return null;
    return this.adapter.get(tableName, id);
  }

  async listDocuments(tableName: string): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.listDocuments) {
      return this.readOverlay.listDocuments(tableName);
    }
    if (!this.adapter) return null;
    if (!isAuthoritative(this.adapter, tableName)) return null;
    return this.adapter.list(tableName);
  }

  async readSource(
    source: Source,
    options?: PersistenceReadOptions,
  ): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.readSource) {
      const overlayResult = await this.readOverlay.readSource(source, options);
      if (overlayResult !== null && overlayResult !== undefined) {
        return overlayResult;
      }
    }
    if (!this.adapter) return null;
    if (typeof (this.adapter as { source?: unknown }).source !== "function") {
      return null;
    }
    return this.adapter.source(source, options);
  }

  async readQuery(
    args: PersistenceQueryRead,
  ): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.readQuery) {
      const overlayResult = await this.readOverlay.readQuery(args);
      if (overlayResult !== null && overlayResult !== undefined) {
        return overlayResult;
      }
    }
    if (!this.adapter) return null;
    if (typeof (this.adapter as { query?: unknown }).query !== "function") {
      return null;
    }
    return this.adapter.query(args);
  }

  async readVectorCandidates(
    args: PersistenceVectorRead,
  ): Promise<StoredDocument[] | null> {
    if (this.readOverlay?.readVectorCandidates) {
      const overlayResult = await this.readOverlay.readVectorCandidates(args);
      if (overlayResult !== null && overlayResult !== undefined) {
        return overlayResult;
      }
    }
    if (!this.adapter) return null;
    if (
      typeof (this.adapter as { vectorSearch?: unknown }).vectorSearch !==
      "function"
    ) {
      return null;
    }
    return this.adapter.vectorSearch(args);
  }

  isAuthoritative(tableName: string): boolean {
    if (!this.adapter) return false;
    return isAuthoritative(this.adapter, tableName);
  }
}

export function createStore(): Store {
  return new UnifiedStore();
}
