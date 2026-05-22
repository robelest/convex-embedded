import { ConvexHttpClient } from "convex/browser";
import type { DefaultFunctionArgs, FunctionReference } from "convex/server";
import { convexToJson, type JSONValue } from "convex/values";

type PrefetchDocument = Record<string, JSONValue>;

type PrefetchDocumentMetadata = {
  docId: string;
  seq: number;
};

type PrefetchTableMetadata = {
  collectionSeq: number;
  documents: PrefetchDocumentMetadata[];
};

/**
 * Serializable prefetch payload for embedded runtime hydration.
 *
 * @remarks
 * This artifact is intentionally transport-safe. Build it on the server with
 * {@link createEmbeddedPrefetch} and pass it into `createEmbeddedRuntime(...)`
 * or `createConvexClient(...)` as the `prefetch` option.
 *
 * @example
 * ```ts
 * const { embedded } = await createEmbeddedPrefetch({
 *   url,
 *   queries: {
 *     tasks: { query: api.tasks.list, args: {}, collection: "tasks" },
 *   },
 * });
 * ```
 */
export interface Prefetch {
  /** Identity scope that the prefetched tables belong to. */
  identityKey: string | null;
  /** Authoritative documents grouped by embedded collection name. */
  tables: Record<string, PrefetchDocument[]>;
  /** Resolve metadata used to seed incremental synchronization state. */
  metadata: Record<string, PrefetchTableMetadata>;
}

/**
 * Describes one remote query to run while building prefetched data.
 *
 * @typeParam TResult - The query result type returned by the referenced Convex
 * query.
 */
export type EmbeddedPrefetchQuerySpec<TResult> = {
  /** Public query function to execute against the remote deployment. */
  query: FunctionReference<"query", "public", DefaultFunctionArgs, TResult>;
  /** Serializable arguments to pass to the query. */
  args: Record<string, unknown>;
  /** Optional embedded collection name to hydrate from this query result. */
  collection?: string;
  /**
   * Optional projector used when the raw query result is not already an array of
   * embedded documents.
   */
  selectDocuments?: (result: TResult) => Array<{ _id: string }>;
};

type AnyEmbeddedPrefetchQuerySpec = {
  query: FunctionReference<"query">;
  args: Record<string, unknown>;
  collection?: string;
  selectDocuments?: (result: never) => Array<{ _id: string }>;
};

/**
 * Options for {@link createEmbeddedPrefetch}.
 *
 * @typeParam TQueries - Map of named SSR/prefetch queries.
 */
export interface CreateEmbeddedPrefetchOptions<
  TQueries extends Record<string, AnyEmbeddedPrefetchQuerySpec>,
> {
  /** Remote Convex deployment URL. */
  url: string;
  /** Optional auth token used for the remote prefetch reads. */
  token?: string | null;
  /** Optional identity scope to attach to the resulting embedded payload. */
  identityKey?: string | null;
  /**
   * Embedded tables to hydrate via their `bind` (resolve) ref returned from
   * `bindTable(...)`. Keyed by embedded collection name.
   */
  tables?: Record<string, FunctionReference<"query">>;
  /** Optional per-table scope args forwarded to the resolve call. */
  scopeArgs?: Record<string, Record<string, unknown>>;
  /** Non-embedded remote queries the app wants prefetched. */
  queries?: TQueries;
}

/**
 * Result returned by {@link createEmbeddedPrefetch}.
 *
 * @typeParam TQueries - The prefetch query map passed into the factory.
 */
export type CreateEmbeddedPrefetchResult<
  TQueries extends Record<string, AnyEmbeddedPrefetchQuerySpec>,
> = {
  /** Embedded prefetch payload to pass into runtime/client load. */
  embedded: Prefetch;
  /** Raw remote query results keyed by the input query names. */
  results: {
    [K in keyof TQueries]: TQueries[K] extends EmbeddedPrefetchQuerySpec<
      infer TResult
    >
      ? TResult
      : never;
  };
  /** Row snapshots hydrated via the `tables` option, keyed by collection. */
  snapshots: Record<string, PrefetchDocument[]>;
};

function normalizePrefetchDocuments(
  tableName: string,
  result: unknown,
): PrefetchDocument[] {
  if (!Array.isArray(result)) {
    throw new Error(
      `[convex-embedded] prefetch expected "${tableName}" documents to be an array.`,
    );
  }

  return result.map((doc, index) => {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error(
        `[convex-embedded] prefetch expected "${tableName}" row ${index} to be a document object.`,
      );
    }
    if (typeof (doc as { _id?: unknown })._id !== "string") {
      throw new Error(
        `[convex-embedded] prefetch expected "${tableName}" row ${index} to include a string _id.`,
      );
    }
    if (
      typeof (doc as { _creationTime?: unknown })._creationTime !== "number"
    ) {
      throw new Error(
        `[convex-embedded] prefetch expected "${tableName}" row ${index} to include a numeric _creationTime.`,
      );
    }
    const encoded = convexToJson(doc as never);
    if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) {
      throw new Error(
        `[convex-embedded] prefetch expected "${tableName}" row ${index} to encode to a document object.`,
      );
    }
    return encoded as PrefetchDocument;
  });
}

type ResolveFullResponse = {
  mode: "full" | "incremental";
  collectionSeq: number;
  documents: Array<{
    docId: string;
    seq?: number | null;
    document?: Record<string, unknown>;
    deleted?: true;
  }>;
};

function hydrateCollectionFromResolve(
  embedded: Prefetch,
  collection: string,
  response: ResolveFullResponse,
): void {
  if (response.mode !== "full") {
    throw new Error(
      `[convex-embedded] prefetch expected "${collection}" resolve response to be in "full" mode; got "${response.mode}".`,
    );
  }
  const rows: unknown[] = [];
  const metadata: PrefetchDocumentMetadata[] = [];
  for (const entry of response.documents) {
    if (entry.deleted) continue;
    if (!entry.document) {
      throw new Error(
        `[convex-embedded] prefetch expected "${collection}" resolve row "${entry.docId}" to carry a "document" payload.`,
      );
    }
    rows.push(entry.document);
    metadata.push({ docId: entry.docId, seq: entry.seq ?? 0 });
  }
  embedded.tables[collection] = normalizePrefetchDocuments(collection, rows);
  embedded.metadata[collection] = {
    collectionSeq: response.collectionSeq,
    documents: metadata,
  };
}

function inferDocuments(result: unknown): Array<{ _id: string }> {
  if (!Array.isArray(result)) {
    throw new Error(
      "[convex-embedded] prefetch requires selectDocuments for non-array query results.",
    );
  }
  return result.filter(
    (doc): doc is { _id: string } =>
      Boolean(doc && typeof doc === "object" && !Array.isArray(doc)) &&
      typeof (doc as { _id?: unknown })._id === "string",
  );
}

/**
 * Create an empty prefetch payload.
 *
 * @param identityKey - Optional identity scope to attach to the payload.
 * @returns An empty embedded prefetch artifact with no tables.
 */
export function emptyEmbeddedPrefetch(identityKey?: string | null): Prefetch {
  return {
    identityKey: identityKey ?? null,
    tables: {},
    metadata: {},
  };
}

/**
 * Execute remote Convex queries and convert them into an embedded prefetch
 * payload.
 *
 * @typeParam TQueries - Map of named prefetch queries.
 * @param options - Prefetch query configuration.
 * @returns The embedded prefetch artifact and the raw remote query results.
 *
 * @throws {Error} When a query marked with `collection` does not produce
 * document-shaped rows or when `selectDocuments` is missing for a non-array
 * query result.
 *
 * @example
 * ```ts
 * const { embedded, results } = await createEmbeddedPrefetch({
 *   url,
 *   queries: {
 *     tasks: { query: api.tasks.list, args: {}, collection: "tasks" },
 *   },
 * });
 * ```
 */
export async function createEmbeddedPrefetch<
  TQueries extends Record<string, AnyEmbeddedPrefetchQuerySpec>,
>(
  options: CreateEmbeddedPrefetchOptions<TQueries>,
): Promise<CreateEmbeddedPrefetchResult<TQueries>> {
  const remoteClient = new ConvexHttpClient(options.url, {
    auth: options.token ?? undefined,
    logger: false,
  });

  const embedded = emptyEmbeddedPrefetch(options.identityKey);
  const results = {} as CreateEmbeddedPrefetchResult<TQueries>["results"];
  const snapshots: Record<string, PrefetchDocument[]> = {};

  if (options.tables) {
    for (const [collection, bindRef] of Object.entries(options.tables)) {
      const response = (await remoteClient.consistentQuery(bindRef, {
        collectionSeq: null,
        documents: [],
        scopeArgs: options.scopeArgs?.[collection],
      })) as ResolveFullResponse;
      hydrateCollectionFromResolve(embedded, collection, response);
      snapshots[collection] = embedded.tables[collection] ?? [];
    }
  }

  if (options.queries) {
    for (const [name, spec] of Object.entries(options.queries) as Array<
      [keyof TQueries & string, AnyEmbeddedPrefetchQuerySpec]
    >) {
      const result: unknown = await remoteClient.consistentQuery(
        spec.query,
        spec.args,
      );
      results[name] =
        result as CreateEmbeddedPrefetchResult<TQueries>["results"][typeof name];

      if (!spec.collection) {
        continue;
      }

      const select = spec.selectDocuments as
        | ((result: unknown) => Array<{ _id: string }>)
        | undefined;
      const documents = select ? select(result) : inferDocuments(result);
      embedded.tables[spec.collection] = normalizePrefetchDocuments(
        spec.collection,
        documents,
      );
      embedded.metadata[spec.collection] = {
        collectionSeq: -1,
        documents: [],
      };
    }
  }

  return { embedded, results, snapshots };
}
