import type {
  DocumentId,
  Source,
  StoredDocument,
  TableName,
} from "@/runtime/db/types";
import type {
  PersistenceVectorRead,
  PersistenceQueryRead,
  PersistenceReadOptions,
} from "@/storage/adapter";

export interface AsyncReadBackend {
  listDocuments?(tableName: TableName): Promise<StoredDocument[]>;
  readQuery?(args: PersistenceQueryRead): Promise<StoredDocument[] | null>;
  readVectorCandidates?(
    args: PersistenceVectorRead,
  ): Promise<StoredDocument[] | null>;
  readSource?(
    source: Source,
    options?: PersistenceReadOptions,
  ): Promise<StoredDocument[] | null>;
  getDocument?(
    tableName: TableName,
    id: DocumentId,
  ): Promise<StoredDocument | null>;
  countDocuments?(tableName: TableName): Promise<number>;
}
