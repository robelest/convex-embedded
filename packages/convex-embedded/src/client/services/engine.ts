import type { ConvexClient } from "convex/browser";

import type { IngestDocumentsOptions } from "@/runtime/embedded";

export interface EngineResolveInput {
  readonly remoteClient: ConvexClient;
  readonly ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
    options?: IngestDocumentsOptions,
  ) => Promise<void>;
  readonly getDocumentsForTable: (
    table: string,
  ) => Promise<Array<Record<string, unknown>>>;
}
