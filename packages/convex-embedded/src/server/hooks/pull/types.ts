import type { ComponentBinding } from "@/server/schema";
import type { Definition } from "@/shared/schema";
import type { QueryPageRange } from "@/shared/types";

export interface PullSpec {
  tableName: string;
  schemaDef: Definition;
  component: ComponentBinding;
  declaredIndexes: Map<string, readonly string[]>;
}

export interface PullHandlerArgs {
  collectionSeq: number | null;
  documents: Array<{
    docId: string;
    vector: ArrayBuffer;
    lastSeq: number | null;
  }>;
  docIds?: string[];
  scopeArgs?: Record<string, unknown>;
  fullCursor?: string | null;
  queryPageRange?: QueryPageRange;
}

export type LiveStateRecord = {
  docId: string;
  update: ArrayBuffer;
  seq: number;
  docCreationTime?: number;
  _creationTime?: number;
};
