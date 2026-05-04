import type {
  DocumentId,
  Source,
  StoredDocument,
  TableName,
} from "@/runtime/db/types";
import type {
  VectorSearchArgs,
  QueryArgs,
  ReadOptions,
} from "@/storage/adapter";

export interface AsyncReadBackend {
  getDocuments?(tableName: TableName): Promise<StoredDocument[]>;
  query?(args: QueryArgs): Promise<StoredDocument[] | null>;
  vectorSearch?(args: VectorSearchArgs): Promise<StoredDocument[] | null>;
  source?(
    source: Source,
    options?: ReadOptions,
  ): Promise<StoredDocument[] | null>;
  getDocument?(
    tableName: TableName,
    id: DocumentId,
  ): Promise<StoredDocument | null>;
  countDocuments?(tableName: TableName): Promise<number>;
}
