import type { FilterNode } from "@/runtime/db/query";
import type { SearchIndexDefinition } from "@/runtime/db/schema";
import type { Source, StoredDocument } from "@/runtime/db/types";
import type {
  CommitBatch,
  DatabaseMeta,
  StoredDocumentWithTable,
} from "@/storage/adapter";

export type BlobPayload = {
  id: string;
  data: ArrayBuffer;
};

export type WorkerResultMap = {
  init: null;
  query: Record<string, unknown>[];
  execute: null;
  executeBatch: null;
  getDocuments: StoredDocumentWithTable[];
  getDocumentsByTable: StoredDocument[];
  hasAnyDocuments: boolean;
  listDocuments: StoredDocument[];
  readSource: StoredDocument[] | null;
  readQuery: StoredDocument[] | null;
  getDocument: StoredDocument | null;
  countDocuments: number;
  getMeta: DatabaseMeta | null;
  getBlobs: BlobPayload[];
  getBlob: ArrayBuffer | null;
  commit: null;
  storeBlob: null;
  deleteBlob: null;
  clear: null;
  close: null;
};

export type WorkerRequestMap = {
  init: { name: string };
  query: { sql: string; params?: unknown[] };
  execute: { sql: string; params?: unknown[] };
  executeBatch: { statements: Array<{ sql: string; params?: unknown[] }> };
  getDocuments: undefined;
  getDocumentsByTable: { tableName: string };
  hasAnyDocuments: { tableName: string };
  listDocuments: { tableName: string };
  readSource: {
    source: Source;
    options?: {
      limit?: number | null;
      indexFields?: string[];
      searchDefinition?: SearchIndexDefinition;
      activeIdentityKey?: string | null;
    };
  };
  readQuery: {
    source: Source;
    filters: FilterNode[];
    limit: number | null;
    indexFields?: string[];
    searchDefinition?: SearchIndexDefinition;
    activeIdentityKey?: string | null;
  };
  getDocument: { tableName: string; id: string };
  countDocuments: { tableName: string };
  getMeta: undefined;
  getBlobs: undefined;
  getBlob: { id: string };
  commit: { batch: CommitBatch };
  storeBlob: { id: string; data: ArrayBuffer };
  deleteBlob: { id: string };
  clear: undefined;
  close: undefined;
};

export type WorkerMethod = keyof WorkerRequestMap;

export type StorageWorkerRequest = {
  [K in WorkerMethod]: {
    id: number;
    method: K;
    payload: WorkerRequestMap[K];
  };
}[WorkerMethod];

export interface WorkerTiming {
  queueWaitMs: number;
  execMs: number;
}

export type StorageWorkerResponse =
  | {
      id: number;
      ok: true;
      result: WorkerResultMap[WorkerMethod];
      timing?: WorkerTiming;
    }
  | {
      id: number;
      ok: false;
      error: string;
      timing?: WorkerTiming;
    };
