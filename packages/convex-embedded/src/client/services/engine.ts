import type { ConvexClient } from "convex/browser";

export interface EngineResolveInput {
  readonly remoteClient: ConvexClient;
  readonly ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  readonly getDocumentsForTable: (
    table: string,
  ) => Promise<Array<Record<string, unknown>>>;
}
