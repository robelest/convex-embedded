import type { ConvexClient } from "convex/browser";

import type { AuthEntry } from "@/client/auth";
import type { ResolveEntry, RemoteOptions } from "@/client/remote";
import type { ConvexInput } from "@/kernel/modules";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { ConnectivityAdapter } from "@/runtime/platform";

export interface ResolveInput {
  readonly entry: ResolveEntry;
  readonly authEntry: AuthEntry;
  readonly embedded: {
    client: ConvexClient;
    ingestDocuments: (
      table: string,
      documents: Array<Record<string, unknown>>,
    ) => Promise<void>;
    getDocumentsForTable: (
      table: string,
    ) => Promise<Array<Record<string, unknown>>>;
    executeLocal: EmbeddedRuntime["executeLocal"];
    getStorageBlob: EmbeddedRuntime["getStorageBlob"];
    getStorageMetadata: EmbeddedRuntime["getStorageMetadata"];
    registerUploadUrlSource: EmbeddedRuntime["registerUploadUrlSource"];
  };
  readonly remoteClient: ConvexClient;
  readonly resolveOpts: RemoteOptions;
  readonly convex: ConvexInput;
  readonly getIdentityKeyForSync: () => string | null;
  readonly getReplayPayloadVersion?: (refName: string) => number;
  readonly uploadFetch?: typeof globalThis.fetch;
  readonly connectivity?: ConnectivityAdapter;
  readonly processorId?: string;
}
