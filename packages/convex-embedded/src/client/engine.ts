/**
 * @internal
 *
 * Engine — internal resolve orchestrator between local embedded
 * runtime and remote Convex backend.
 *
 * This module is NOT part of the public API. Use `createConvexClient()`
 * from `@robelest/convex-embedded/browser` instead.
 */

import type { ConvexClient } from "convex/browser";
import * as Y from "yjs";

import { IdMap, extractSchemaIdFields } from "@/client/ids";
import { MAX_REPLAY_RETRIES, PendingQueue } from "@/client/pending/queue";
import type { PendingEntry } from "@/client/pending/queue";
import {
  PendingUploadQueue,
  type PendingUploadEntry,
} from "@/client/pending/uploads";
import { materializeYjsDoc } from "@/client/schema";
import type { EngineResolveInput } from "@/client/services/engine";
import { SystemPaths } from "@/kernel/system";
import type { LocalExecutionRequest } from "@/runtime/embedded";
import {
  createAmbientConnectivityAdapter,
  type ConnectivityAdapter,
} from "@/runtime/platform";
import { createLogger } from "@/shared/logger";
import { matchTag } from "@/shared/match";
import { getFunctionName, makeFunctionReference } from "@/shared/refs";
import { getCrdtType, type Definition } from "@/shared/schema";
import type {
  EngineStatus,
  ResolveDocumentResponse,
  ResolveProgress,
  ResolveResponse,
} from "@/shared/types";
import { initYjsDoc } from "@/shared/yjs";
import { recordCounter, registerGauge } from "@/tracing/metrics";
import { withSpan } from "@/tracing/spans";
import { runDetached } from "@/utils/detached";
import { retryWithBackoff } from "@/utils/retry";

const log = createLogger("resolve");

/**
 * Strip fields marked with `schema.omit()` from a set of documents.
 *
 * Remote documents may contain fields that only exist on the remote
 * Convex backend and should not be synced to the local embedded
 * runtime (e.g. large blobs, server-side computed fields).
 *
 * If there are no omitted fields in the schema, returns the original
 * array as-is (no allocation).
 */
function stripOmittedFields(
  schemaDef: Definition,
  docs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const omittedFields = schemaDef.getOmittedFields();
  if (omittedFields.length === 0) return docs;

  return docs.map((doc) => {
    const stripped = { ...doc };
    for (const field of omittedFields) {
      delete stripped[field];
    }
    return stripped;
  });
}

/**
 * Canonicalize scope args into a stable string key for deduplicating
 * (table, scopeArgs) subscriptions.
 *
 * Empty / missing scope args collapse to the table name — i.e. an unscoped
 * subscription — so existing table-keyed behavior is preserved.
 */
function canonicalizeScopeArgs(
  scopeArgs?: Record<string, unknown>,
): Record<string, unknown> {
  if (!scopeArgs) return {};
  const keys = Object.keys(scopeArgs);
  if (keys.length === 0) return {};
  const sorted = keys.sort();
  const normalized: Record<string, unknown> = {};
  for (const k of sorted) normalized[k] = scopeArgs[k];
  return normalized;
}

function makeScopeKey(
  tableName: string,
  scopeArgs?: Record<string, unknown>,
): string {
  const normalized = canonicalizeScopeArgs(scopeArgs);
  if (Object.keys(normalized).length === 0) return tableName;
  return `${tableName}::${JSON.stringify(normalized)}`;
}

function getFieldValueByPath(
  doc: Record<string, unknown>,
  fieldPath: string,
): unknown {
  return fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, doc);
}

interface ActiveScope {
  tableName: string;
  scopeArgs: Record<string, unknown>;
  unsub?: () => void;
  pendingActivation?: Promise<void>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function isUnsupportedDocIdsResolveError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("extra field") &&
    message.includes("docids") &&
    message.includes("validator")
  );
}

function createRemoteUpdateHandler(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ) => Promise<void>;
  getDocumentsForTable: (
    table: string,
  ) => Promise<Array<Record<string, unknown>>>;
  getPendingEntries: () => readonly PendingEntry[];
  getAliases: (id: string) => Set<string>;
  bufferRemoteSnapshot: (
    table: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ) => Promise<void>;
  translateRemoteSnapshotToLocal: (
    docs: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>;
  schema: Definition;
  scopeArgs?: Record<string, unknown>;
  tableName: string;
}) {
  return (remoteDocs: Array<Record<string, unknown>>) => {
    const cleaned = input.translateRemoteSnapshotToLocal(
      stripOmittedFields(input.schema, remoteDocs),
    );
    runDetached(async () => {
      try {
        const hasPendingForTable = input
          .getPendingEntries()
          .some((entry) => entry.table === input.tableName);
        await input.bufferRemoteSnapshot(
          input.tableName,
          cleaned,
          input.scopeArgs,
        );
        if (hasPendingForTable) {
          return;
        }
      } catch (err) {
        log.error(
          `sync: failed to ingest remote data for "${input.tableName}"`,
          err,
        );
      }
    }, `[sync] ingest ${input.tableName}:`);
  };
}

function createRemoteSubscriptionErrorHandler(tableName: string) {
  return (err: Error) => {
    log.error(`sync: remote subscription error for "${tableName}"`, err);
  };
}

type TableRemoteSyncState = {
  tableName: string;
  scopeArgs: Record<string, unknown>;
  bufferedSnapshot: Array<Record<string, unknown>> | null;
  flushScheduled: boolean;
  epoch: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
};

const MAX_BUFFERED_SNAPSHOT_RETRIES = 8;
const BUFFERED_SNAPSHOT_RETRY_BASE_MS = 25;
const BUFFERED_SNAPSHOT_RETRY_MAX_MS = 1000;

function extractPendingLogicalId(entry: PendingEntry): string | null {
  try {
    const localResult = JSON.parse(entry.localResult) as unknown;
    if (typeof localResult === "string") {
      return localResult;
    }

    const args = JSON.parse(entry.args) as Record<string, unknown>;
    if (typeof args.id === "string") {
      return args.id;
    }
    if (typeof args._id === "string") {
      return args._id;
    }
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && /(^|[a-zA-Z])Id$/.test(key)) {
        return value;
      }
    }
    return null;
  } catch (error) {
    log.warn("sync: failed to parse pending entry identity", error, {
      ref: entry.ref,
      table: entry.table,
      entryId: entry._id,
    });
    return null;
  }
}

class ReplayLeaseLostError extends Error {
  constructor(entry: PendingEntry) {
    super(
      `[convex-embedded] Lost replay lease for pending entry ${entry._id} (${entry.ref}).`,
    );
    this.name = "ReplayLeaseLostError";
  }
}

function parseErrorMetadata(error: Error): {
  code?: string;
  message: string;
} {
  const fallback = error.message ?? String(error);
  try {
    const parsed = JSON.parse(fallback) as {
      code?: unknown;
      message?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      return {
        code: typeof parsed.code === "string" ? parsed.code : undefined,
        message:
          typeof parsed.message === "string"
            ? parsed.message.toLowerCase()
            : fallback.toLowerCase(),
      };
    }
  } catch {}
  return { message: fallback.toLowerCase() };
}

function projectRemoteSnapshot(input: {
  localDocs: Array<Record<string, unknown>>;
  remoteDocs: Array<Record<string, unknown>>;
  pendingEntries: readonly PendingEntry[];
  recentlyReplayedIds: ReadonlySet<string>;
  tableName: string;
  getAliases: (id: string) => Set<string>;
}): Array<Record<string, unknown>> {
  const localById = new Map<string, Record<string, unknown>>();
  for (const doc of input.localDocs) {
    if (typeof doc._id === "string") {
      localById.set(doc._id, doc);
    }
  }

  const dirtyAliasKeys = new Set<string>();
  for (const entry of input.pendingEntries) {
    if (entry.table !== input.tableName) {
      continue;
    }
    const logicalId = extractPendingLogicalId(entry);
    if (!logicalId) {
      continue;
    }
    for (const alias of input.getAliases(logicalId)) {
      dirtyAliasKeys.add(alias);
    }
  }
  for (const id of input.recentlyReplayedIds) {
    for (const alias of input.getAliases(id)) {
      dirtyAliasKeys.add(alias);
    }
  }

  if (dirtyAliasKeys.size === 0) {
    return input.remoteDocs;
  }

  const projected = input.remoteDocs.filter((doc) => {
    const id = doc._id;
    return typeof id !== "string" || !dirtyAliasKeys.has(id);
  });

  const injected = new Set<string>();
  for (const alias of dirtyAliasKeys) {
    const localDoc = localById.get(alias);
    if (!localDoc || typeof localDoc._id !== "string") {
      continue;
    }
    if (injected.has(localDoc._id)) {
      continue;
    }
    projected.push(localDoc);
    injected.add(localDoc._id);
  }

  return projected;
}

function classifyReplayError(
  error: Error,
): "reauthRequired" | "authorizationDenied" | "scopeChanged" | "unknown" {
  const { code, message } = parseErrorMetadata(error);
  const lowered = message.toLowerCase();
  if (code === "UNAUTHENTICATED") {
    return "reauthRequired";
  }
  if (code === "FORBIDDEN") {
    return "authorizationDenied";
  }
  if (
    lowered.includes("unauthenticated") ||
    lowered.includes("invalid token") ||
    lowered.includes("expired token") ||
    lowered.includes("authentication required")
  ) {
    return "reauthRequired";
  }
  if (
    lowered.includes("forbidden") ||
    lowered.includes("not authorized") ||
    lowered.includes("permission denied") ||
    lowered.includes("access denied")
  ) {
    return "authorizationDenied";
  }
  if (
    lowered.includes("scope changed") ||
    lowered.includes("scope mismatch") ||
    lowered.includes("invalid scope")
  ) {
    return "scopeChanged";
  }
  return "unknown";
}

function isAlreadyAppliedReplayError(
  entry: PendingEntry,
  error: Error,
): boolean {
  const { code, message } = parseErrorMetadata(error);
  return (
    entry.ref.endsWith(":remove") &&
    (code === "DOCUMENT_NOT_FOUND" ||
      message.includes("delete on nonexistent document id"))
  );
}

function startReplayLeaseHeartbeat(input: {
  entry: PendingEntry;
  renew: () => Promise<boolean>;
  leaseMs: number;
}) {
  const intervalMs = Math.max(1_000, Math.floor(input.leaseMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => {
    rejectLost = reject;
  });
  lost.catch(() => undefined);

  const schedule = () => {
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        if (stopped) {
          return;
        }
        try {
          const renewed = await input.renew();
          if (stopped) {
            return;
          }
          if (!renewed) {
            stopped = true;
            rejectLost(new ReplayLeaseLostError(input.entry));
            return;
          }
          schedule();
        } catch (error) {
          if (stopped) {
            return;
          }
          stopped = true;
          rejectLost(
            error instanceof Error ? error : new Error(toErrorMessage(error)),
          );
        }
      })();
    }, intervalMs);
  };

  schedule();

  return {
    race<T>(operation: Promise<T>): Promise<T> {
      return Promise.race([operation, lost]);
    },
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  };
}

function registerRemoteSubscription(input: {
  getPendingEntries: () => readonly PendingEntry[];
  getAliases: (id: string) => Set<string>;
  bufferRemoteSnapshot: (
    table: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ) => Promise<void>;
  translateRemoteSnapshotToLocal: (
    docs: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>;
  onUnsubscribe: (unsub: () => void) => void;
  resolveServices: EngineResolveInput;
  tableConfig: TableConfig;
  tableName: string;
  scopeArgs?: Record<string, unknown>;
  consumeExpectedSelfCausedSignal?: (
    table: string,
    signalSeq: number,
  ) => boolean;
  scheduleTableCoalesce?: (input: {
    tableName: string;
    scopeKey: string;
    signalSeq: number;
    runHandler: () => void;
  }) => void;
  onPartialResponse?: () => void;
}) {
  const remoteClient = input.resolveServices.remoteClient;
  const baseHandler = createRemoteUpdateHandler({
    ingestDocuments: (table, documents, scopeArgs) =>
      input.resolveServices.ingestDocuments(table, documents, scopeArgs),
    getDocumentsForTable: (table) =>
      input.resolveServices.getDocumentsForTable(table),
    getPendingEntries: input.getPendingEntries,
    getAliases: input.getAliases,
    bufferRemoteSnapshot: input.bufferRemoteSnapshot,
    translateRemoteSnapshotToLocal: input.translateRemoteSnapshotToLocal,
    schema: input.tableConfig.schema,
    scopeArgs: input.scopeArgs,
    tableName: input.tableName,
  });

  const unwrapResolveResponse = (response: unknown) => {
    const res = response as {
      documents?: Array<{ document?: unknown }>;
      collectionSeq?: number;
      isDone?: boolean;
      mode?: string;
    };
    const signalSeq =
      typeof res?.collectionSeq === "number" ? res.collectionSeq : -1;

    if (
      input.consumeExpectedSelfCausedSignal?.(input.tableName, signalSeq) ===
      true
    ) {
      return;
    }

    if (res?.mode === "full" && res?.isDone === false) {
      input.onPartialResponse?.();
      return;
    }

    const docs: Array<Record<string, unknown>> = [];
    if (res?.documents) {
      for (const entry of res.documents) {
        if (entry.document && typeof entry.document === "object") {
          docs.push(entry.document as Record<string, unknown>);
        }
      }
    }

    if (input.scheduleTableCoalesce) {
      const scopeKey = makeScopeKey(input.tableName, input.scopeArgs);
      input.scheduleTableCoalesce({
        tableName: input.tableName,
        scopeKey,
        signalSeq,
        runHandler: () => baseHandler(docs),
      });
      return;
    }

    baseHandler(docs);
  };

  const unsub = (remoteClient as any).onUpdate(
    input.tableConfig.resolve,
    {
      collectionSeq: null,
      documents: [],
      ...(input.scopeArgs && Object.keys(input.scopeArgs).length > 0
        ? { scopeArgs: input.scopeArgs }
        : {}),
    },
    unwrapResolveResponse,
    createRemoteSubscriptionErrorHandler(input.tableName),
  );

  input.onUnsubscribe(unsub);
}

/**
 * @internal
 *
 * Per-table remote configuration.
 *
 * - `resolve` — the Yjs CRDT catch-up query called on connect/reconnect
 *   to merge any state that diverged while offline.
 * - `query` — the standard Convex query that the remote engine subscribes to
 *   on the remote while online. When the remote pushes new results the
 *   remote engine diffs them against local state and ingests the changes.
 */
export interface TableConfig {
  /**
   * The auto-generated resolve query (from `bindTable`). Used both for
   * catch-up resolves and as the live subscription target (subscribed with
   * stable args so the server returns a fresh full snapshot on every
   * collection mutation).
   */
  resolve: unknown;

  /**
   * The schema {@link Definition} for this table (from `schema.define()`).
   *
   * Required for the Yjs CRDT resolve path: the remote engine uses this to
   * encode local documents into Yjs state vectors, apply server diffs,
   * and materialize merged Yjs docs back to plain records.
   *
   * Also used to strip `schema.omit()`-ed fields from remote documents
   * before ingesting them into the embedded runtime.
   */
  schema: Definition;
}

/**
 * @internal
 *
 * The embedded client — provides both the `ConvexClient` for local
 * mutations and the `ingestDocuments` capability for remote → local remote.
 *
 * This matches the {@link EmbeddedClient} interface exported by
 * `@robelest/convex-embedded/browser`.
 */
export interface EmbeddedClientLike {
  readonly client: ConvexClient;
  ingestDocuments(
    table: string,
    documents: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void>;
  canonicalizeMappedCreate(input: {
    localId: string;
    remoteId: string;
    tableName: string;
    schemas: Record<string, Definition>;
  }): Promise<void>;

  /**
   * Return all documents for a table from the local embedded database.
   *
   * Used by the resolve path to encode local Yjs state vectors before
   * sending them to the server for CRDT diff computation.
   */
  getDocumentsForTable(table: string): Promise<Array<Record<string, unknown>>>;

  /** Check whether a local document ID is currently present in the runtime. */
  hasLocalDocumentId?(id: string): boolean;

  /**
   * Unified local execution primitive.
   *
   * Used for all runtime-first local execution, including system bookkeeping.
   */
  executeLocal?(request: LocalExecutionRequest): Promise<unknown>;

  /** Read a locally stored blob by `_storage` id. */
  getStorageBlob?(storageId: string): Promise<Blob | null>;

  /** Read local `_storage` metadata by `_storage` id. */
  getStorageMetadata?(
    storageId: string,
  ): Promise<Record<string, unknown> | null>;

  /** Associate a local upload URL token with the mutation that produced it. */
  registerUploadUrlSource?(uploadUrl: string, refName: string): void;
}

/** @internal */
export interface EngineConfig {
  /**
   * The embedded client — receives all mutations first for instant
   * local writes, and supports `ingestDocuments` for remote → local remote.
   */
  embedded: EmbeddedClientLike;

  /**
   * A ConvexClient pointed at the remote Convex backend.
   * Used for resolve queries, reactive subscriptions, and forwarding
   * mutations.
   */
  remoteClient: ConvexClient;

  /** Table configurations keyed by table name. */
  tables: Record<string, TableConfig>;

  /** Optional remote mutation reference that returns a one-shot upload URL. */
  uploadUrlRef?: unknown;

  /** Maximum number of retries for resolve calls (default: 3). */
  maxRetries?: number;

  /** Delay between retries in ms (default: 1000). Doubles on each retry. */
  retryDelayMs?: number;

  /**
   * Returns the active identity key for identity-scoped local remote state.
   */
  getIdentityKey?: () => string | null;

  uploadFetch?: typeof globalThis.fetch;

  connectivity?: ConnectivityAdapter;

  processorId?: string;

  /** Replay lease duration in ms for pending entry claims. */
  leaseMs?: number;

  /** Return the current queued payload version for a mutation ref. */
  getReplayPayloadVersion?: (refName: string) => number;
}

type ChangeListener = (status: EngineStatus) => void;

type SyncCycleRoute =
  | { _tag: "Skip" }
  | { _tag: "DeferUntilQueueDrains" }
  | { _tag: "Resolve" };

type QueueEntryRoute =
  | { _tag: "Stop" }
  | { _tag: "DropMappedCreate"; localResult: string }
  | { _tag: "Push"; localResult: unknown };

type StartLifecycleRoute =
  | { _tag: "Offline" }
  | { _tag: "WaitForHydrationThenOnline" };

type LocalYjsEntry = {
  localDoc: Record<string, unknown>;
};

type ResolveDocument = {
  docId: string;
  vector: ArrayBuffer;
  lastSeq: number | null;
};

type ResolveArgs = {
  collectionSeq: number | null;
  documents: Array<ResolveDocument>;
  docIds?: string[];
  scopeArgs?: Record<string, unknown>;
  fullCursor?: string | null;
};

type ResolveResultRow = ResolveDocumentResponse;

type ResolveMetadata = {
  collectionSeq: number | null;
  documentSeqById: Map<string, number>;
};

type PreparedResolveInput = {
  localDocs: Array<Record<string, unknown>>;
  localYjsMap: Map<string, LocalYjsEntry>;
  resolveDocuments: Array<ResolveDocument>;
  schemaDef: Definition;
};

type MergeResolveOutput = {
  deletedDocIds: string[];
  diffCount: number;
  mergedDocs: Array<Record<string, unknown>>;
  metadataEntries: Array<{ docId: string; seq: number }>;
};

type StorageDependency = {
  localStorageId: string;
  metadata: Record<string, unknown>;
  blob: Blob;
};

type MissingReference = {
  tableName: string;
  id: string;
};

function normalizeResolveResponse(
  response: ResolveResponse | Array<ResolveResultRow>,
  fallbackCollectionSeq: number | null,
): ResolveResponse {
  if (Array.isArray(response)) {
    return {
      mode: "incremental",
      collectionSeq: fallbackCollectionSeq ?? -1,
      documents: response,
    };
  }
  return response;
}

/** @internal */
export interface EngineInstance {
  /** Start monitoring network state and triggering resolves. */
  start(): void;

  /** Stop monitoring and clean up listeners. */
  stop(): void;

  /** Subscribe to status changes. Returns unsubscribe function. */
  on(event: "change", listener: ChangeListener): () => void;

  /** Get the current status. */
  getStatus(): EngineStatus;

  /**
   * Proxy a mutation through the remote engine.
   *
   * 1. Writes to the local embedded client (instant, always awaited).
   * 2. Persists to the pending queue for durability.
   * 3. When online: processes queue serially with ID translation.
   * 4. When offline: queue waits until reconnect.
   *
   * Returns the local mutation result immediately.
   */
  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown>;

  /** Manually trigger a resolve cycle (e.g., after coming back online). */
  resolveNow(): Promise<void>;

  /** Ensure a table is hydrated/resolved before first use. */
  ensureTableReady(tableName: string): Promise<void>;

  /**
   * Ensure a scoped subscription for `(tableName, scopeArgs)` is active.
   *
   * An empty or missing `scopeArgs` is equivalent to {@link ensureTableReady}
   * — the unscoped, table-wide subscription. Different non-empty scope args
   * produce independent subscriptions so reads against the same table with
   * different args (e.g. `comments.list({ issueId })`) do not collide.
   */
  ensureScopeReady(
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void>;

  /** Re-hydrate identity-scoped state and resume remote for the active identity. */
  reloadIdentity(): Promise<void>;

  /** Number of mutations waiting to be pushed to remote. */
  pendingCount(): number;

  /** Access the ID map (for testing / advanced use). */
  readonly idMap: IdMap;

  /** Access the pending queue (for testing / advanced use). */
  readonly pendingQueue: PendingQueue;

  /** Async dispose — delegates to stop(). */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Infer the table name from a mutation function reference.
 *
 * Convex function references have an internal structure with the UDF path.
 * The convention is `"tableName:functionName"` — we extract the table part.
 * Falls back to empty string if the ref doesn't match expected patterns.
 */
function inferTableFromRef(
  ref: unknown,
  tables: Record<string, TableConfig>,
): string | null {
  const name = getFunctionName(ref as any);

  const moduleName = name.split(":")[0] ?? "";
  if (moduleName in tables) {
    return moduleName;
  }

  return null;
}

function getSyncCycleRoute(input: {
  aborted: boolean;
  forceResolve: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
  offlineTransitionsSinceBoot: number;
  hasDirtyCrdtRows: boolean;
}): SyncCycleRoute {
  if (input.aborted) return { _tag: "Skip" };
  if (!input.forceResolve && (!input.started || !input.isOnline)) {
    return { _tag: "Skip" };
  }
  if (input.hasPending) {
    return { _tag: "DeferUntilQueueDrains" };
  }
  if (
    !input.forceResolve &&
    input.offlineTransitionsSinceBoot === 0 &&
    !input.hasDirtyCrdtRows
  ) {
    return { _tag: "Skip" };
  }
  return { _tag: "Resolve" };
}

function shouldStartRemoteSubscriptions(input: {
  aborted: boolean;
  forceResolve: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
}): boolean {
  return (
    !input.aborted &&
    input.started &&
    input.isOnline &&
    !input.hasPending &&
    !input.forceResolve
  );
}

function getStartLifecycleRoute(input: {
  hasNavigator: boolean;
  navigatorOnline: boolean | undefined;
}): StartLifecycleRoute {
  return input.hasNavigator && input.navigatorOnline === false
    ? { _tag: "Offline" }
    : { _tag: "WaitForHydrationThenOnline" };
}

function createHydrationAwareOnlineHandler(input: {
  handleOnline: () => void;
  hydrationPromise: Promise<unknown>;
  isStarted: () => boolean;
}): () => void {
  return () => {
    void input.hydrationPromise.then(() => {
      if (input.isStarted()) {
        input.handleOnline();
      }
    });
  };
}

function unwrapSchemaField(field: unknown): unknown {
  if (
    typeof field === "object" &&
    field !== null &&
    "validator" in field &&
    typeof (field as { validator?: unknown }).validator !== "undefined"
  ) {
    return (field as { validator: unknown }).validator;
  }
  return field;
}

function collectReferencedTables(
  field: unknown,
  referenced: Set<string>,
): void {
  const unwrapped = unwrapSchemaField(field);
  if (typeof unwrapped !== "object" || unwrapped === null) {
    return;
  }

  const validator = unwrapped as Record<string, unknown> & { kind?: string };
  if (validator.kind === "id") {
    const tableName = validator.tableName;
    if (typeof tableName === "string") {
      referenced.add(tableName);
    }
    return;
  } else if (validator.kind === "array") {
    collectReferencedTables(validator.element, referenced);
    return;
  } else if (validator.kind === "record") {
    collectReferencedTables(validator.value, referenced);
    return;
  } else if (validator.kind === "object") {
    const fields = validator.fields as Record<string, unknown> | undefined;
    if (!fields) {
      return;
    }
    for (const nested of Object.values(fields)) {
      collectReferencedTables(nested, referenced);
    }
    return;
  } else if (validator.kind === "union") {
    const members = validator.members;
    if (!Array.isArray(members)) {
      return;
    }
    for (const member of members) {
      collectReferencedTables(member, referenced);
    }
    return;
  } else if (validator.kind === "optional") {
    collectReferencedTables(validator.field, referenced);
    return;
  }
}

function orderTablesByDependencies(
  tables: Record<string, TableConfig>,
): Array<string> {
  const tableNames = Object.keys(tables);
  const dependencyMap = new Map<string, Set<string>>(
    tableNames.map((tableName) => {
      const referenced = new Set<string>();
      const schema = tables[tableName]?.schema;
      if (schema) {
        for (const field of Object.values(schema.getShape())) {
          collectReferencedTables(field, referenced);
        }
      }
      referenced.delete(tableName);
      return [
        tableName,
        new Set([...referenced].filter((dependency) => dependency in tables)),
      ];
    }),
  );

  const ordered: Array<string> = [];
  const remaining = new Set(tableNames);
  while (remaining.size > 0) {
    const ready = tableNames.filter((tableName) => {
      if (!remaining.has(tableName)) {
        return false;
      }
      const dependencies = dependencyMap.get(tableName);
      return (
        !dependencies || [...dependencies].every((dep) => !remaining.has(dep))
      );
    });

    if (ready.length === 0) {
      return tableNames;
    }

    for (const tableName of ready) {
      remaining.delete(tableName);
      ordered.push(tableName);
    }
  }

  return ordered;
}

function rootTablesByDependencies(
  tables: Record<string, TableConfig>,
): Array<string> {
  return Object.entries(tables)
    .filter(([, tableConfig]) => {
      const referenced = new Set<string>();
      const schema = tableConfig?.schema;
      if (!schema) {
        return true;
      }
      for (const field of Object.values(schema.getShape())) {
        collectReferencedTables(field, referenced);
      }
      return referenced.size === 0;
    })
    .map(([tableName]) => tableName);
}

async function runSpan<A>(input: {
  name: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  run: () => Promise<A> | A;
}): Promise<A> {
  return Promise.resolve(input.run());
}

function hasResolvableReferences(
  value: unknown,
  field: unknown,
  hasDocumentId: (id: string) => boolean,
  getAliases: (id: string) => Set<string>,
): boolean {
  const unwrapped = unwrapSchemaField(field);
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof unwrapped === "string") {
    return true;
  }
  if (typeof unwrapped !== "object" || unwrapped === null) {
    return true;
  }

  const validator = unwrapped as Record<string, unknown> & { kind?: string };
  if (validator.kind === "id") {
    return (
      typeof value !== "string" ||
      hasDocumentId(value) ||
      Array.from(getAliases(value)).some((alias) => hasDocumentId(alias))
    );
  } else if (validator.kind === "array") {
    return (
      !Array.isArray(value) ||
      value.every((entry) =>
        hasResolvableReferences(
          entry,
          validator.element,
          hasDocumentId,
          getAliases,
        ),
      )
    );
  } else if (validator.kind === "record") {
    return (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.values(value).every((entry) =>
        hasResolvableReferences(
          entry,
          validator.value,
          hasDocumentId,
          getAliases,
        ),
      )
    );
  } else if (validator.kind === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return true;
    }
    const fields = validator.fields as Record<string, unknown> | undefined;
    if (!fields) {
      return true;
    }
    return Object.entries(fields).every(([key, nestedField]) =>
      hasResolvableReferences(
        (value as Record<string, unknown>)[key],
        nestedField,
        hasDocumentId,
        getAliases,
      ),
    );
  } else if (validator.kind === "union") {
    const members = validator.members;
    if (!Array.isArray(members)) {
      return true;
    }
    return members.some((member) =>
      hasResolvableReferences(value, member, hasDocumentId, getAliases),
    );
  } else if (validator.kind === "optional") {
    return hasResolvableReferences(
      value,
      validator.field,
      hasDocumentId,
      getAliases,
    );
  }
  return true;
}

function collectMissingReferences(
  value: unknown,
  field: unknown,
  hasDocumentId: (id: string) => boolean,
  getAliases: (id: string) => Set<string>,
  missing: Map<string, Set<string>>,
): void {
  const unwrapped = unwrapSchemaField(field);
  if (value === null || value === undefined) {
    return;
  }
  if (typeof unwrapped !== "object" || unwrapped === null) {
    return;
  }

  const validator = unwrapped as Record<string, unknown> & { kind?: string };
  if (validator.kind === "id") {
    const tableName = validator.tableName;
    if (
      typeof value === "string" &&
      typeof tableName === "string" &&
      !hasDocumentId(value) &&
      !Array.from(getAliases(value)).some((alias) => hasDocumentId(alias))
    ) {
      const ids = missing.get(tableName) ?? new Set<string>();
      ids.add(value);
      missing.set(tableName, ids);
    }
    return;
  }
  if (validator.kind === "array") {
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectMissingReferences(
          entry,
          validator.element,
          hasDocumentId,
          getAliases,
          missing,
        );
      }
    }
    return;
  }
  if (validator.kind === "record") {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const entry of Object.values(value)) {
        collectMissingReferences(
          entry,
          validator.value,
          hasDocumentId,
          getAliases,
          missing,
        );
      }
    }
    return;
  }
  if (validator.kind === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    const fields = validator.fields as Record<string, unknown> | undefined;
    if (!fields) {
      return;
    }
    for (const [key, nestedField] of Object.entries(fields)) {
      collectMissingReferences(
        (value as Record<string, unknown>)[key],
        nestedField,
        hasDocumentId,
        getAliases,
        missing,
      );
    }
    return;
  }
  if (validator.kind === "union") {
    const members = validator.members;
    if (Array.isArray(members)) {
      if (
        members.some((member) =>
          hasResolvableReferences(value, member, hasDocumentId, getAliases),
        )
      ) {
        return;
      }
      for (const member of members) {
        collectMissingReferences(
          value,
          member,
          hasDocumentId,
          getAliases,
          missing,
        );
      }
    }
    return;
  }
  if (validator.kind === "optional") {
    collectMissingReferences(
      value,
      validator.field,
      hasDocumentId,
      getAliases,
      missing,
    );
  }
}

function getMissingReferences(input: {
  docs: Array<Record<string, unknown>>;
  schema?: Definition;
  hasDocumentId: (id: string) => boolean;
  getAliases?: (id: string) => Set<string>;
}): MissingReference[] {
  if (!input.schema) {
    return [];
  }

  const missing = new Map<string, Set<string>>();
  const getAliases = input.getAliases ?? (() => new Set<string>());
  for (const doc of input.docs) {
    for (const [fieldName, field] of Object.entries(input.schema.getShape())) {
      collectMissingReferences(
        doc[fieldName],
        field,
        input.hasDocumentId,
        getAliases,
        missing,
      );
    }
  }

  return Array.from(missing.entries()).flatMap(([tableName, ids]) =>
    Array.from(ids).map((id) => ({ tableName, id })),
  );
}

function filterDocumentsWithResolvableReferences(input: {
  docs: Array<Record<string, unknown>>;
  schema?: Definition;
  hasDocumentId: (id: string) => boolean;
  getAliases?: (id: string) => Set<string>;
}): {
  accepted: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
} {
  if (!input.schema) {
    return { accepted: input.docs, skipped: [] };
  }

  const accepted: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const doc of input.docs) {
    const resolvable = Object.entries(input.schema.getShape()).every(
      ([fieldName, field]) =>
        hasResolvableReferences(
          doc[fieldName],
          field,
          input.hasDocumentId,
          input.getAliases ?? (() => new Set()),
        ),
    );
    if (resolvable) {
      accepted.push(doc);
    } else {
      skipped.push(doc);
    }
  }

  return { accepted, skipped };
}

function getConnectivityAdapter(
  connectivity?: ConnectivityAdapter,
): ConnectivityAdapter {
  return connectivity ?? createAmbientConnectivityAdapter();
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function isLocalUploadUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value, "http://convex-embedded.local");
    return url.pathname.startsWith("/__convex_embedded/upload/");
  } catch {
    return false;
  }
}

function collectCandidateStorageIds(
  value: unknown,
  seen = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    if (isUuidLike(value)) {
      seen.add(value);
    }
    return seen;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectCandidateStorageIds(entry, seen));
    return seen;
  }

  if (
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array ||
    value === null ||
    typeof value !== "object"
  ) {
    return seen;
  }

  Object.values(value).forEach((entry) =>
    collectCandidateStorageIds(entry, seen),
  );
  return seen;
}

async function uploadBlobToRemote(input: {
  remoteClient: ConvexClient;
  uploadUrlRef: unknown;
  blob: Blob;
  contentType?: string;
  uploadFetch?: typeof globalThis.fetch;
}): Promise<string> {
  const uploadUrl = (await (input.remoteClient as any).mutation(
    input.uploadUrlRef,
    {},
  )) as string;

  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    throw new Error(
      "[convex-embedded] remote upload URL mutation did not return a URL string.",
    );
  }

  const headers: Record<string, string> = {};
  if (input.contentType) {
    headers["content-type"] = input.contentType;
  }

  const doFetch = input.uploadFetch ?? globalThis.fetch;
  const response = await doFetch(uploadUrl, {
    method: "POST",
    body: input.blob,
    headers,
  });

  const payloadText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch (parseError) {
    throw new Error(
      `[convex-embedded] remote blob upload returned invalid JSON: ${String(parseError)}`,
    );
  }

  const parsed = payload as {
    storageId?: unknown;
    error?: unknown;
  };

  if (response.status >= 200 && response.status < 300) {
    if (typeof parsed.storageId === "string") {
      return parsed.storageId;
    }
    throw new Error(
      "[convex-embedded] remote blob upload response did not include a storageId.",
    );
  }

  throw new Error(
    typeof parsed.error === "string"
      ? parsed.error
      : `[convex-embedded] remote blob upload failed with status ${response.status}.`,
  );
}

function prepareResolveInput(
  schemaDef: Definition,
  localDocs: Array<Record<string, unknown>>,
  metadata: ResolveMetadata,
): PreparedResolveInput {
  return localDocs.reduce<PreparedResolveInput>(
    (acc, doc) => {
      const docId = doc._id as string | undefined;
      if (!docId) {
        return acc;
      }

      const yjsDoc = initYjsDoc(schemaDef, doc, 0, { skipProse: true });
      const vector = toArrayBuffer(Y.encodeStateVector(yjsDoc));
      yjsDoc.destroy();
      acc.localYjsMap.set(docId, { localDoc: doc });
      acc.resolveDocuments.push({
        docId,
        lastSeq: metadata.documentSeqById.get(docId) ?? null,
        vector,
      });
      return acc;
    },
    {
      localDocs,
      schemaDef,
      localYjsMap: new Map<string, LocalYjsEntry>(),
      resolveDocuments: [],
    },
  );
}

function createResolveRetrySchedule(input: {
  maxRetries: number;
  retryDelayMs: number;
  signal?: AbortSignal;
}) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    return retryWithBackoff(
      () => {
        if (input.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return operation();
      },
      {
        maxRetries: Math.max(input.maxRetries - 1, 0),
        baseMs: input.retryDelayMs,
        jitter: true,
        signal: input.signal,
      },
    );
  };
}

function mergeCrdtFieldsWithPlain(
  schemaDef: Definition,
  localDoc: Record<string, unknown>,
  yjsDoc: Y.Doc,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...localDoc };
  const crdtFields = materializeYjsDoc(schemaDef, yjsDoc);
  for (const [key, value] of Object.entries(crdtFields)) {
    merged[key] = value;
  }
  return merged;
}

function mergeResolveResult(input: {
  localDocs: Array<Record<string, unknown>>;
  localYjsMap: Map<string, LocalYjsEntry>;
  resolveResult: ResolveResponse;
  schemaDef: Definition;
  tableName: string;
  translateRemoteDocument: (
    document: Record<string, unknown>,
  ) => Record<string, unknown>;
}): MergeResolveOutput {
  if (input.resolveResult.mode === "full") {
    const mergedDocs = input.resolveResult.documents.flatMap((row) => {
      if (!row.document) {
        return [];
      }
      return [input.translateRemoteDocument(row.document)];
    });
    const deletedDocIds = input.resolveResult.documents.flatMap((row) =>
      row.deleted ? [row.docId] : [],
    );
    const metadataEntries = input.resolveResult.documents.flatMap((row) =>
      typeof row.seq === "number" ? [{ docId: row.docId, seq: row.seq }] : [],
    );
    return {
      deletedDocIds,
      diffCount: 0,
      mergedDocs,
      metadataEntries,
    };
  }

  const mergedDocsById = new Map(
    input.localDocs
      .filter((doc) => typeof doc._id === "string")
      .map(
        (doc) => [String(doc._id), input.translateRemoteDocument(doc)] as const,
      ),
  );

  const output = input.resolveResult.documents.reduce<MergeResolveOutput>(
    (acc, { docId, deleted, diff, document, seq }) => {
      if (deleted) {
        mergedDocsById.delete(docId);
        acc.deletedDocIds.push(docId);
        return acc;
      }

      const entry = input.localYjsMap.get(docId);
      if (!entry) {
        if (document) {
          mergedDocsById.set(docId, input.translateRemoteDocument(document));
          if (typeof seq === "number") {
            acc.metadataEntries.push({ docId, seq });
          }
          return acc;
        }
        log.warn(
          `sync: resolve returned diff for unknown doc "${docId}" in "${input.tableName}"`,
        );
        return acc;
      }

      if (diff) {
        const yjsDoc = initYjsDoc(input.schemaDef, entry.localDoc, 0, {
          skipProse: true,
        });
        Y.applyUpdateV2(yjsDoc, new Uint8Array(diff));
        acc.diffCount += 1;
        const merged = mergeCrdtFieldsWithPlain(
          input.schemaDef,
          entry.localDoc,
          yjsDoc,
        );
        yjsDoc.destroy();
        merged._id = entry.localDoc._id;
        merged._creationTime = entry.localDoc._creationTime;
        mergedDocsById.set(docId, input.translateRemoteDocument(merged));
        if (typeof seq === "number") {
          acc.metadataEntries.push({ docId, seq });
        }
        return acc;
      }

      mergedDocsById.set(
        docId,
        input.translateRemoteDocument(entry.localDoc),
      );
      if (typeof seq === "number") {
        acc.metadataEntries.push({ docId, seq });
      }
      return acc;
    },
    {
      deletedDocIds: [],
      diffCount: 0,
      mergedDocs: [],
      metadataEntries: [],
    },
  );
  output.mergedDocs = Array.from(mergedDocsById.values());
  return output;
}

async function ingestMergedDocs(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ) => Promise<void>;
  mergedDocs: Array<Record<string, unknown>>;
  scopeArgs?: Record<string, unknown>;
  tableName: string;
}): Promise<void> {
  if (input.mergedDocs.length === 0) {
    return;
  }
  await input.ingestDocuments(
    input.tableName,
    input.mergedDocs,
    input.scopeArgs,
  );
}

function getQueueEntryRoute(input: {
  entry: PendingEntry | undefined;
  hasMappedLocalId: (localId: string) => boolean;
  hasActiveLocalDocument: (localId: string) => boolean;
  getRemoteId: (localId: string) => string | null;
  isOnline: boolean;
  signal?: AbortSignal;
}): QueueEntryRoute {
  if (input.entry === undefined || !input.isOnline || input.signal?.aborted) {
    return { _tag: "Stop" };
  }

  let localResult: unknown;
  try {
    localResult = JSON.parse(input.entry.localResult);
  } catch {
    return { _tag: "Skip" };
  }
  const remoteId =
    typeof localResult === "string" ? input.getRemoteId(localResult) : null;
  return input.entry.ref.endsWith(":create") &&
    input.entry.hydrated === true &&
    typeof localResult === "string" &&
    input.hasMappedLocalId(localResult) &&
    !input.hasActiveLocalDocument(localResult) &&
    remoteId !== null &&
    input.hasActiveLocalDocument(remoteId)
    ? { _tag: "DropMappedCreate", localResult }
    : { _tag: "Push", localResult };
}

function createEngine(config: EngineConfig): EngineInstance {
  const {
    embedded,
    remoteClient,
    tables,
    uploadUrlRef,
    maxRetries = 3,
    retryDelayMs = 1000,
    getIdentityKey,
    processorId,
    leaseMs = 30_000,
    getReplayPayloadVersion,
    uploadFetch,
  } = config;

  const localClient = embedded.client;
  const rawIngestDocuments = embedded.ingestDocuments.bind(embedded);

  const ingestLockMap = new Map<string, Promise<void>>();
  function ingestDocuments(
    table: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    const prev = ingestLockMap.get(table) ?? Promise.resolve();
    const next = prev.then(
      () => rawIngestDocuments(table, docs, scopeArgs),
      () => rawIngestDocuments(table, docs, scopeArgs),
    );
    ingestLockMap.set(table, next);
    next
      .finally(() => {
        if (ingestLockMap.get(table) === next) {
          ingestLockMap.delete(table);
        }
      })
      .catch(() => undefined);
    return next;
  }
  const canonicalizeMappedCreate =
    embedded.canonicalizeMappedCreate?.bind(embedded) ??
    (async () => {
      throw new Error(
        "[convex-embedded] Embedded client is missing canonicalizeMappedCreate().",
      );
    });
  const getDocumentsForTable = embedded.getDocumentsForTable.bind(embedded);
  const tableSchemas = Object.fromEntries(
    Object.entries(tables)
      .filter(([, tableConfig]) => tableConfig.schema !== undefined)
      .map(([tableName, tableConfig]) => [tableName, tableConfig.schema]),
  ) as Record<string, Definition>;
  const orderedTables = orderTablesByDependencies(tables);
  const activatedRemoteTables = new Set(rootTablesByDependencies(tables));
  const processorHeartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3));

  const REPLAY_GRACE_MS = 3_000;
  const recentlyReplayedIds = new Map<string, number>();

  function sweepRecentlyReplayed(now: number): void {
    for (const [id, timestamp] of recentlyReplayedIds) {
      if (now - timestamp >= REPLAY_GRACE_MS) {
        recentlyReplayedIds.delete(id);
      }
    }
  }

  function addRecentlyReplayed(id: string): void {
    const now = Date.now();
    sweepRecentlyReplayed(now);
    recentlyReplayedIds.set(id, now);
  }

  function getRecentlyReplayedIdSet(): ReadonlySet<string> {
    const now = Date.now();
    sweepRecentlyReplayed(now);
    const active = new Set<string>();
    for (const [id, timestamp] of recentlyReplayedIds) {
      if (now - timestamp < REPLAY_GRACE_MS) {
        active.add(id);
      }
    }
    return active;
  }
  const resolveServices: EngineResolveInput = {
    remoteClient,
    ingestDocuments,
    getDocumentsForTable,
  };
  const executeLocal = embedded.executeLocal?.bind(embedded);
  const getStorageBlob = embedded.getStorageBlob?.bind(embedded);
  const getStorageMetadata = embedded.getStorageMetadata?.bind(embedded);
  const registerUploadUrlSource =
    embedded.registerUploadUrlSource?.bind(embedded);

  const executeLocalQuery = executeLocal
    ? (path: string, args: Record<string, unknown>) =>
        executeLocal({ kind: "query", path, args })
    : undefined;
  const executeLocalMutationWithoutEffects = executeLocal
    ? (path: string, args: Record<string, unknown>) =>
        executeLocal({
          kind: "mutation",
          path,
          args,
          applyLocalEffects: false,
        })
    : undefined;
  const executeLocalMutationWithEffects = executeLocal
    ? (ref: unknown, args: Record<string, unknown>) =>
        executeLocal({
          kind: "mutation",
          path: getFunctionName(ref as any),
          args,
          applyLocalEffects: true,
        })
    : undefined;

  let status: EngineStatus = { status: "idle" };
  const listeners = new Set<ChangeListener>();
  let started = false;
  let scopeActivationEpoch = 0;
  let abortController: AbortController | null = null;

  const schemaIdFields = extractSchemaIdFields(
    Object.values(tables)
      .filter((t) => t.schema !== undefined)
      .map((t) => t.schema.shape),
  );
  const idMap = new IdMap(
    localClient,
    executeLocalQuery,
    executeLocalMutationWithoutEffects,
    getIdentityKey,
    (id) => embedded.hasLocalDocumentId?.(id) ?? false,
    schemaIdFields,
  );
  const pendingQueue = new PendingQueue(
    localClient,
    executeLocalQuery,
    executeLocalMutationWithoutEffects,
    getIdentityKey,
  );
  const unregisterPendingDepth = registerGauge(
    "pending_queue.depth",
    () => pendingQueue.length,
  );
  const pendingUploadQueue = new PendingUploadQueue(
    localClient,
    executeLocalQuery,
    executeLocalMutationWithoutEffects,
    getIdentityKey,
  );
  const unregisterPendingUploadsDepth = registerGauge(
    "pending_uploads.depth",
    () => pendingUploadQueue.length,
  );
  const processorIdForReplay =
    processorId ?? `processor_${Math.random().toString(36).slice(2)}`;

  let isOnline = false;
  let offlineTransitionsSinceBoot = 0;
  let cameOnlineAfterOfflinePeriod = false;
  const dirtyCrdtRows = new Set<string>();
  const crdtFieldsByTable = new Map<string, Set<string>>();
  for (const [tableName, tableConfig] of Object.entries(tables)) {
    const shape = tableConfig.schema?.getShape?.() as
      | Record<string, unknown>
      | undefined;
    if (!shape) continue;
    const crdtFields = new Set<string>();
    for (const [fieldName, fieldDef] of Object.entries(shape)) {
      if (getCrdtType(fieldDef) !== null) {
        crdtFields.add(fieldName);
      }
    }
    if (crdtFields.size > 0) {
      crdtFieldsByTable.set(tableName, crdtFields);
    }
  }

  function markCrdtRowDirty(tableName: string, docId: string): void {
    if (!crdtFieldsByTable.has(tableName)) return;
    dirtyCrdtRows.add(`${tableName}:${docId}`);
  }

  function clearCrdtRowDirty(tableName: string, docId: string): void {
    dirtyCrdtRows.delete(`${tableName}:${docId}`);
  }

  let queueProcessingPromise: Promise<Set<string>> | null = null;
  let queueProcessingRequestedWhileActive = false;
  let syncCyclePromise: Promise<void> | null = null;
  let activeEntry: PendingEntry | null = null;

  let onOnline: (() => void) | null = null;
  let onOffline: (() => void) | null = null;
  let cleanupOnlineListener: (() => void) | null = null;
  let cleanupOfflineListener: (() => void) | null = null;
  let processorHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let bufferedFlushScheduled = false;
  let bufferedFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const activeScopes = new Map<string, ActiveScope>();

  const RESOLVE_TABLE_COALESCE_MS = 32;
  const expectedSelfCausedSignals = new Map<string, number[]>();
  const lastKnownCollectionSeqByTable = new Map<string, number>();
  type TableCoalesceEntry = {
    signalSeqs: Set<number>;
    pendingThunks: Map<string, () => void>;
    timer: ReturnType<typeof setTimeout> | null;
  };
  const tableCoalesceMap = new Map<string, TableCoalesceEntry>();

  function recordExpectedSelfCausedSignal(
    tableName: string,
    postCommitSeq: number,
  ): void {
    const existing = expectedSelfCausedSignals.get(tableName) ?? [];
    existing.push(postCommitSeq);
    existing.sort((a, b) => a - b);
    expectedSelfCausedSignals.set(tableName, existing);
  }

  function nextExpectedSelfCausedSeq(tableName: string): number {
    const lastKnown = lastKnownCollectionSeqByTable.get(tableName) ?? -1;
    const pending = expectedSelfCausedSignals.get(tableName);
    const highestPending =
      pending && pending.length > 0 ? pending[pending.length - 1]! : -1;
    return Math.max(lastKnown, highestPending) + 1;
  }

  function consumeExpectedSelfCausedSignal(
    tableName: string,
    signalSeq: number,
  ): boolean {
    const seqs = expectedSelfCausedSignals.get(tableName);
    if (!seqs || seqs.length === 0) {
      return false;
    }
    let bestIndex = -1;
    for (let i = seqs.length - 1; i >= 0; i--) {
      if (seqs[i]! <= signalSeq) {
        bestIndex = i;
        break;
      }
    }
    if (bestIndex < 0) {
      return false;
    }
    seqs.splice(bestIndex, 1);
    if (seqs.length === 0) {
      expectedSelfCausedSignals.delete(tableName);
    } else {
      expectedSelfCausedSignals.set(tableName, seqs);
    }
    if (signalSeq >= 0) {
      lastKnownCollectionSeqByTable.set(tableName, signalSeq);
    }
    log.debug(
      `sync: skipping self-caused bind for "${tableName}" (signalSeq=${signalSeq})`,
    );
    return true;
  }

  function fireCoalescedTableUpdate(tableName: string): void {
    const entry = tableCoalesceMap.get(tableName);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.pendingThunks.size === 0) {
      tableCoalesceMap.delete(tableName);
      return;
    }
    if (entry.signalSeqs.size > 0) {
      const highestSeq = Math.max(...Array.from(entry.signalSeqs));
      if (highestSeq >= 0) {
        lastKnownCollectionSeqByTable.set(tableName, highestSeq);
      }
    }
    const thunks = Array.from(entry.pendingThunks.values());
    tableCoalesceMap.delete(tableName);
    for (const thunk of thunks) {
      try {
        thunk();
      } catch (err) {
        log.warn(`sync: coalesced bind thunk for "${tableName}" failed`, err);
      }
    }
  }

  function scheduleTableCoalesce(input: {
    tableName: string;
    scopeKey: string;
    signalSeq: number;
    runHandler: () => void;
  }): void {
    const { tableName, scopeKey, signalSeq, runHandler } = input;
    let entry = tableCoalesceMap.get(tableName);
    if (!entry) {
      entry = {
        signalSeqs: new Set(),
        pendingThunks: new Map(),
        timer: null,
      };
      tableCoalesceMap.set(tableName, entry);
    }
    if (signalSeq >= 0) {
      entry.signalSeqs.add(signalSeq);
    }
    entry.pendingThunks.set(scopeKey, runHandler);
    if (entry.timer === null) {
      entry.timer = setTimeout(() => {
        fireCoalescedTableUpdate(tableName);
      }, RESOLVE_TABLE_COALESCE_MS);
    }
  }

  function clearTableCoalesceState(): void {
    for (const entry of tableCoalesceMap.values()) {
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
      }
    }
    tableCoalesceMap.clear();
    expectedSelfCausedSignals.clear();
    lastKnownCollectionSeqByTable.clear();
  }

  function getRemoteApplyOrder(): string[] {
    return orderedTables.filter((tableName) =>
      activatedRemoteTables.has(tableName),
    );
  }

  function hasActiveSubscriptions(): boolean {
    return activeScopes.size > 0;
  }
  const tableRemoteSyncStateMap = new Map<string, TableRemoteSyncState>();

  function getTableRemoteSyncState(
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ): TableRemoteSyncState {
    const normalizedScope = canonicalizeScopeArgs(scopeArgs);
    const scopeKey = makeScopeKey(tableName, normalizedScope);
    let state = tableRemoteSyncStateMap.get(scopeKey);
    if (!state) {
      state = {
        tableName,
        scopeArgs: normalizedScope,
        bufferedSnapshot: null,
        flushScheduled: false,
        epoch: 0,
        retryTimer: null,
        retryCount: 0,
      };
      tableRemoteSyncStateMap.set(scopeKey, state);
    }
    return state;
  }

  function scheduleBufferedSnapshotFlush(delayMs = 0): void {
    if (bufferedFlushScheduled) {
      return;
    }

    bufferedFlushScheduled = true;
    if (delayMs > 0) {
      if (bufferedFlushTimer !== null) {
        clearTimeout(bufferedFlushTimer);
      }
      bufferedFlushTimer = setTimeout(() => {
        bufferedFlushTimer = null;
        void flushBufferedSnapshots();
      }, delayMs);
      return;
    }

    runDetached(() => flushBufferedSnapshots(), "[sync] flush buffered:");
  }

  async function flushBufferedSnapshot(scopeKey: string): Promise<void> {
    const state = tableRemoteSyncStateMap.get(scopeKey);
    if (!state) {
      return;
    }
    if (state.bufferedSnapshot === null) {
      state.flushScheduled = false;
      return;
    }

    const snapshot = state.bufferedSnapshot;
    state.bufferedSnapshot = null;
    state.flushScheduled = false;
    const { scopeArgs, tableName } = state;

    const projected = projectRemoteSnapshot({
      localDocs: await getDocumentsForTable(tableName),
      remoteDocs: snapshot,
      pendingEntries: pendingQueue.entries(),
      recentlyReplayedIds: getRecentlyReplayedIdSet(),
      tableName,
      getAliases: (id) => idMap.getAliases(id),
    });
    const { accepted, skipped } = await filterAfterHydratingReferences({
      docs: projected,
      tableName,
    });
    try {
      if (accepted.length > 0) {
        await runSpan({
          name: "convex_embedded.remote.buffered_snapshot.ingest",
          attributes: {
            table: tableName,
            accepted_count: accepted.length,
            projected_count: projected.length,
          },
          run: () =>
            ingestDocuments(
              tableName,
              accepted,
              Object.keys(scopeArgs).length > 0 ? scopeArgs : undefined,
            ),
        });
      }

      if (skipped.length > 0) {
        await runSpan({
          name: "convex_embedded.remote.buffered_snapshot.defer",
          attributes: {
            table: tableName,
            accepted_count: accepted.length,
            skipped_count: skipped.length,
            retry_count: state.retryCount,
          },
          run: async () => undefined,
        });
        state.bufferedSnapshot = skipped;
        state.flushScheduled = false;
        if (state.retryCount >= MAX_BUFFERED_SNAPSHOT_RETRIES) {
          log.error(
            `sync: giving up buffered snapshot ingest for "${tableName}" after ${state.retryCount} retries due to unresolved references`,
          );
          return;
        }
        state.retryCount += 1;
        const delayMs = Math.min(
          BUFFERED_SNAPSHOT_RETRY_BASE_MS * 2 ** (state.retryCount - 1),
          BUFFERED_SNAPSHOT_RETRY_MAX_MS,
        );
        scheduleBufferedSnapshotFlush(delayMs);
        log.warn(
          `sync: deferred ${skipped.length} "${tableName}" snapshot doc(s) with unresolved references`,
        );
        return;
      }

      state.retryCount = 0;
    } catch (error) {
      state.bufferedSnapshot = snapshot;
      state.flushScheduled = false;

      if (state.retryCount >= MAX_BUFFERED_SNAPSHOT_RETRIES) {
        log.error(
          `sync: giving up buffered snapshot ingest for "${tableName}" after ${state.retryCount} retries`,
          error,
        );
        return;
      }

      state.retryCount += 1;
      const delayMs = Math.min(
        BUFFERED_SNAPSHOT_RETRY_BASE_MS * 2 ** (state.retryCount - 1),
        BUFFERED_SNAPSHOT_RETRY_MAX_MS,
      );
      scheduleBufferedSnapshotFlush(delayMs);
      log.warn(
        `sync: delayed buffered snapshot ingest for "${tableName}" (retry ${state.retryCount}/${MAX_BUFFERED_SNAPSHOT_RETRIES})`,
        error,
      );
      return;
    }

    if (state.bufferedSnapshot !== null && !state.flushScheduled) {
      scheduleBufferedSnapshotFlush();
    }
  }

  async function flushBufferedSnapshots(): Promise<void> {
    bufferedFlushScheduled = false;
    const bufferedTables = new Set(
      Array.from(tableRemoteSyncStateMap.values()).map(
        (state) => state.tableName,
      ),
    );
    const flushOrder = [
      ...orderedTables.filter((tableName) => bufferedTables.has(tableName)),
      ...Array.from(bufferedTables).filter(
        (tableName) => !orderedTables.includes(tableName),
      ),
    ];
    for (const tableName of flushOrder) {
      const scopeKeys = Array.from(tableRemoteSyncStateMap.entries())
        .filter(([, state]) => state.tableName === tableName)
        .map(([scopeKey]) => scopeKey);
      for (const scopeKey of scopeKeys) {
        await flushBufferedSnapshot(scopeKey);
        await yieldToEventLoop();
      }
    }
  }

  async function bufferRemoteSnapshot(
    tableName: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    const state = getTableRemoteSyncState(tableName, scopeArgs);
    state.bufferedSnapshot = docs;
    state.retryCount = 0;
    scheduleBufferedSnapshotFlush();
  }

  function clearBufferedSnapshots(): void {
    bufferedFlushScheduled = false;
    if (bufferedFlushTimer !== null) {
      clearTimeout(bufferedFlushTimer);
      bufferedFlushTimer = null;
    }
    for (const state of tableRemoteSyncStateMap.values()) {
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
      }
      state.retryCount = 0;
    }
    tableRemoteSyncStateMap.clear();
    clearTableCoalesceState();
  }

  function ensureReplayProcessing(): void {
    if (!isOnline) return;
    const hasPendingMutation = !pendingQueue.isEmpty;
    const hasPendingUpload = pendingUploadQueue.length > 0;
    if (!hasPendingMutation && !hasPendingUpload) return;

    runDetached(async () => {
      await processUploadQueue();
      const deadLettered = await processQueue();
      await rollbackDeadLetteredTables(deadLettered);

      if (pendingQueue.isEmpty) {
        for (const state of tableRemoteSyncStateMap.values()) {
          state.bufferedSnapshot = null;
        }
        if (!hasActiveSubscriptions() && started) {
          void runSyncCycle();
        }
        return;
      }

      stopRemoteSubscriptions();
    }, "[sync] ensureReplayProcessing:");
  }

  function emit(newStatus: EngineStatus) {
    status = newStatus;
    for (const listener of listeners) {
      try {
        listener(newStatus);
      } catch (err) {
        log.error("sync: listener threw", err);
      }
    }
  }

  async function collectUnmappedStorageDependencies(
    args: Record<string, unknown>,
  ): Promise<StorageDependency[]> {
    if (!getStorageBlob || !getStorageMetadata) {
      return [];
    }

    const dependencies: StorageDependency[] = [];
    for (const candidate of collectCandidateStorageIds(args)) {
      if (idMap.getRemoteId(candidate) !== null) {
        continue;
      }

      const metadata = await getStorageMetadata(candidate);
      if (metadata === null) {
        continue;
      }

      const blob = await getStorageBlob(candidate);
      if (blob === null) {
        throw new Error(
          `[convex-embedded] Missing local blob data for storage id ${candidate}.`,
        );
      }

      dependencies.push({
        localStorageId: candidate,
        metadata,
        blob,
      });
    }

    return dependencies;
  }

  async function ensureRemoteStorageMappings(
    entry: PendingEntry,
    args: Record<string, unknown>,
  ): Promise<void> {
    const dependencies = await collectUnmappedStorageDependencies(args);
    if (dependencies.length === 0) {
      return;
    }

    for (const dependency of dependencies) {
      const dependencyUploadUrlRef =
        typeof dependency.metadata.uploadSourceRef === "string"
          ? dependency.metadata.uploadSourceRef
          : uploadUrlRef;

      if (
        dependencyUploadUrlRef === undefined ||
        dependencyUploadUrlRef === null
      ) {
        throw new Error(
          "[convex-embedded] Pending mutation references local storage blobs but no remote upload URL function is configured or discoverable.",
        );
      }

      const uploadRef =
        typeof dependencyUploadUrlRef === "string"
          ? makeFunctionReference<"mutation">(dependencyUploadUrlRef)
          : dependencyUploadUrlRef;

      const leaseHeld = await pendingQueue.renewLease(
        entry,
        processorIdForReplay,
        leaseMs,
      );
      if (!leaseHeld) {
        if (entry.hydrated === true) {
          throw new ReplayLeaseLostError(entry);
        }
        log.warn(
          `sync: continuing upload replay for current-session entry after lease renewal miss (${entry._id})`,
        );
      }
      const heartbeat = startReplayLeaseHeartbeat({
        entry,
        renew: () =>
          pendingQueue.renewLease(entry, processorIdForReplay, leaseMs),
        leaseMs,
      });
      let remoteStorageId: string;
      try {
        remoteStorageId = await heartbeat.race(
          uploadBlobToRemote({
            remoteClient,
            uploadUrlRef: uploadRef,
            blob: dependency.blob,
            contentType:
              typeof dependency.metadata.contentType === "string"
                ? dependency.metadata.contentType
                : dependency.blob.type || undefined,
            uploadFetch,
          }),
        );
      } finally {
        heartbeat.stop();
      }
      await idMap.set(dependency.localStorageId, remoteStorageId, "_storage");
    }
  }

  /**
   * Drain the pending uploads queue. Runs before mutation replay so that
   * any local storage IDs queued mutations reference are already mapped to
   * remote IDs by the time those mutations process.
   */
  async function processUploadQueue(signal?: AbortSignal): Promise<void> {
    if (!getStorageBlob || !getStorageMetadata) return;
    if (uploadUrlRef === undefined || uploadUrlRef === null) {
      // No upload URL function discovered → nothing to do; the just-in-time
      // path inside processQueue() will surface a clear error if any
      // mutation actually references a storage id.
      return;
    }
    while (true) {
      if (signal?.aborted) return;
      let entry: PendingUploadEntry | undefined;
      try {
        entry = await pendingUploadQueue.claimNext(
          processorIdForReplay,
          leaseMs,
        );
      } catch (err) {
        log.warn("sync: pending-upload claim failed", err);
        return;
      }
      if (!entry) return;

      try {
        if (idMap.getRemoteId(entry.localStorageId) !== null) {
          await pendingUploadQueue.remove(entry, processorIdForReplay);
          continue;
        }
        const blob = await getStorageBlob(entry.localStorageId);
        if (blob === null) {
          log.warn(
            `sync: pending-upload missing local blob (storageId: ${entry.localStorageId}); dropping`,
          );
          await pendingUploadQueue.remove(entry, processorIdForReplay);
          continue;
        }
        const heartbeat = startReplayLeaseHeartbeat({
          entry: entry as unknown as PendingEntry,
          renew: () =>
            pendingUploadQueue.renewLease(
              entry!,
              processorIdForReplay,
              leaseMs,
            ),
          leaseMs,
        });
        let remoteStorageId: string;
        try {
          const uploadRef =
            typeof uploadUrlRef === "string"
              ? makeFunctionReference<"mutation">(uploadUrlRef)
              : uploadUrlRef;
          remoteStorageId = await heartbeat.race(
            uploadBlobToRemote({
              remoteClient,
              uploadUrlRef: uploadRef,
              blob,
              contentType: entry.contentType,
              uploadFetch,
            }),
          );
        } finally {
          heartbeat.stop();
        }
        await idMap.set(entry.localStorageId, remoteStorageId, "_storage");
        await pendingUploadQueue.remove(entry, processorIdForReplay);
      } catch (err) {
        log.warn(
          `sync: pending-upload failed (storageId: ${entry.localStorageId}); will retry next cycle`,
          err,
        );
        try {
          await pendingUploadQueue.release(entry, processorIdForReplay);
        } catch (releaseErr) {
          log.warn("sync: failed to release upload queue entry", releaseErr);
        }
        return;
      }
    }
  }

  /**
   * Process the pending queue serially.
   *
   * Each mutation is awaited before the next starts. This ensures:
   * 1. `create` completes and populates the ID map before a subsequent
   *    `update`/`remove` that references the same document.
   * 2. Ordering is preserved — mutations replay in the exact order they
   *    were issued locally.
   *
   * On failure, the entry stays in the queue for retry on next cycle.
   */
  async function processQueue(signal?: AbortSignal): Promise<Set<string>> {
    if (queueProcessingPromise) {
      queueProcessingRequestedWhileActive = true;
      return queueProcessingPromise;
    }
    if (pendingQueue.isEmpty) {
      await pendingQueue.hydrate();
    }
    if (pendingQueue.isEmpty) return new Set();

    const deadLetteredTables = new Set<string>();

    log.info(`sync: processing ${pendingQueue.length} queued mutation(s)`);

    queueProcessingPromise = (async () => {
      try {
        while (isOnline && !signal?.aborted) {
          queueProcessingRequestedWhileActive = false;

          while (!pendingQueue.isEmpty && isOnline && !signal?.aborted) {
            const entry = await pendingQueue.claimNext(
              processorIdForReplay,
              leaseMs,
              leaseMs,
            );
            if (!entry) {
              break;
            }
            activeEntry = entry;
            if (entry.state === "blocked") {
              log.warn(
                `sync: blocked pending entry for ${entry.ref}; halting replay`,
              );
              break;
            }

            const replayDocId = extractPendingLogicalId(entry);
            const route = getQueueEntryRoute({
              entry,
              hasMappedLocalId: (localId: string) => idMap.hasLocalId(localId),
              hasActiveLocalDocument: (localId: string) =>
                embedded.hasLocalDocumentId?.(localId) ?? false,
              getRemoteId: (localId: string) => idMap.getRemoteId(localId),
              isOnline,
              signal,
            });
            await runSpan({
              name: "convex_embedded.replay.route_decision",
              attributes: {
                "replay.route": route._tag,
                "replay.ref": entry.ref,
                "replay.table": entry.table,
                "replay.hydrated": entry.hydrated === true,
              },
              run: async () => undefined,
            });

            let shouldContinue = false;
            if (route._tag === "Stop") {
              shouldContinue = false;
            } else if (route._tag === "DropMappedCreate") {
              await pendingQueue.remove(entry, processorIdForReplay);
              if (replayDocId) addRecentlyReplayed(replayDocId);
              await cleanupMappedCreateAlias(route.localResult);
              log.debug(
                `sync: dropping already-mapped create mutation (remaining: ${pendingQueue.length})`,
              );
              recordCounter("replay.outcome", { result: "drop_mapped" });
              shouldContinue = true;
            } else if (route._tag === "Push") {
              try {
                const ref = makeFunctionReference<"mutation">(entry.ref);
                const originalArgs = JSON.parse(entry.args) as Record<
                  string,
                  unknown
                >;
                await ensureRemoteStorageMappings(entry, originalArgs);
                const translatedArgs = idMap.translateArgs(originalArgs);
                const leaseHeld = await pendingQueue.renewLease(
                  entry,
                  processorIdForReplay,
                  leaseMs,
                );
                if (!leaseHeld) {
                  if (entry.hydrated === true) {
                    activeEntry = null;
                    log.warn(
                      `sync: lost replay lease before remote push (table: ${entry.table})`,
                    );
                    shouldContinue = false;
                  } else {
                    log.warn(
                      `sync: continuing replay for current-session entry after lease renewal miss (table: ${entry.table})`,
                    );
                  }
                }

                if (!(entry.hydrated === true && !leaseHeld)) {
                  const heartbeat = startReplayLeaseHeartbeat({
                    entry,
                    renew: () =>
                      pendingQueue.renewLease(
                        entry,
                        processorIdForReplay,
                        leaseMs,
                      ),
                    leaseMs,
                  });
                  let remoteResult: unknown;
                  try {
                    remoteResult = await heartbeat.race(
                      (remoteClient as any).mutation(ref, translatedArgs),
                    );
                  } finally {
                    heartbeat.stop();
                  }

                  recordExpectedSelfCausedSignal(
                    entry.table,
                    nextExpectedSelfCausedSeq(entry.table),
                  );

                  if (
                    typeof route.localResult === "string" &&
                    typeof remoteResult === "string" &&
                    route.localResult !== remoteResult
                  ) {
                    await canonicalizeMappedCreate({
                      localId: route.localResult,
                      remoteId: remoteResult,
                      tableName: entry.table,
                      schemas: tableSchemas,
                    });
                    await idMap.set(
                      route.localResult,
                      remoteResult,
                      entry.table,
                    );
                    await pendingQueue.remove(entry, processorIdForReplay);
                    if (replayDocId) addRecentlyReplayed(replayDocId);
                    activeEntry = null;
                  } else {
                    await pendingQueue.remove(entry, processorIdForReplay);
                    if (replayDocId) addRecentlyReplayed(replayDocId);
                    activeEntry = null;
                  }

                  log.debug(
                    `sync: pushed mutation to remote (table: ${entry.table}, remaining: ${pendingQueue.length})`,
                  );
                  recordCounter("replay.outcome", {
                    result: "success",
                    "convex.table": entry.table,
                  });
                  shouldContinue = true;
                }
              } catch (err) {
                if (isAlreadyAppliedReplayError(entry, err as Error)) {
                  await pendingQueue.remove(entry, processorIdForReplay);
                  if (replayDocId) addRecentlyReplayed(replayDocId);
                  activeEntry = null;
                  log.debug(
                    `sync: dropping already-applied mutation (table: ${entry.table}, remaining: ${pendingQueue.length})`,
                  );
                  recordCounter("replay.outcome", {
                    result: "drop_already_applied",
                    "convex.table": entry.table,
                  });
                  shouldContinue = true;
                } else if (err instanceof ReplayLeaseLostError) {
                  activeEntry = null;
                  log.warn(
                    `sync: replay lease lost while processing ${entry.ref}`,
                  );
                  recordCounter("replay.outcome", {
                    result: "lease_lost",
                    "convex.table": entry.table,
                  });
                  shouldContinue = false;
                } else {
                  const reason = classifyReplayError(err as Error);
                  if (reason !== "unknown") {
                    await pendingQueue.block(entry, reason);
                    activeEntry = null;
                    recordCounter("replay.outcome", {
                      result: "blocked",
                      reason,
                      "convex.table": entry.table,
                    });
                  } else {
                    entry.retryCount = (entry.retryCount ?? 0) + 1;
                    if (entry.retryCount >= MAX_REPLAY_RETRIES) {
                      log.error(
                        `sync: mutation exceeded max retries (${MAX_REPLAY_RETRIES}), dead-lettering (table: ${entry.table}, ref: ${entry.ref})`,
                        err,
                      );
                      await pendingQueue.remove(entry, processorIdForReplay);
                      deadLetteredTables.add(entry.table);
                      activeEntry = null;
                      recordCounter("replay.outcome", {
                        result: "dead_letter",
                        "convex.table": entry.table,
                      });
                    } else {
                      log.warn(
                        `sync: remote push failed (attempt ${entry.retryCount}/${MAX_REPLAY_RETRIES}), releasing (table: ${entry.table})`,
                        err,
                      );
                      await pendingQueue.release(entry, processorIdForReplay);
                      activeEntry = null;
                      recordCounter("replay.outcome", {
                        result: "released",
                        "convex.table": entry.table,
                      });
                    }
                  }
                  shouldContinue = false;
                }
              }
            }

            if (!shouldContinue) break;
          }

          if (
            !queueProcessingRequestedWhileActive ||
            pendingQueue.isEmpty ||
            !isOnline ||
            signal?.aborted
          ) {
            break;
          }

          log.debug(
            `sync: continuing queue processing after concurrent enqueue (remaining: ${pendingQueue.length})`,
          );
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          log.error("sync: unhandled error in queue processing loop", err);
        }
      }
      return deadLetteredTables;
    })().finally(() => {
      queueProcessingPromise = null;
    });

    const result = await queueProcessingPromise;

    if (pendingQueue.isEmpty) {
      log.info("sync: queue fully processed");
    }
    return result ?? new Set();
  }

  async function rollbackDeadLetteredTables(
    tablesToRollback: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (tablesToRollback.size === 0) return;
    log.info(
      `sync: rolling back dead-lettered tables: ${[...tablesToRollback].join(", ")}`,
    );
    for (const tableName of tablesToRollback) {
      if (signal?.aborted) break;
      const tableConfig = tables[tableName];
      if (!tableConfig) continue;
      try {
        await resolveTable(tableName, tableConfig, signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") break;
        log.error(
          `sync: rollback resolve failed for table "${tableName}"`,
          err,
        );
      }
    }
  }

  function runSyncCycle(options?: { forceResolve?: boolean }): Promise<void> {
    if (syncCyclePromise) {
      if (options?.forceResolve) {
        return syncCyclePromise.then(() => runSyncCycle(options));
      }
      return syncCyclePromise;
    }

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    syncCyclePromise = (async () => {
      try {
        await processUploadQueue(signal);
        const deadLettered = await processQueue(signal);
        await rollbackDeadLetteredTables(deadLettered, signal);

        const route = getSyncCycleRoute({
          aborted: signal.aborted,
          forceResolve: options?.forceResolve ?? false,
          hasPending: !pendingQueue.isEmpty,
          isOnline,
          started,
          offlineTransitionsSinceBoot,
          hasDirtyCrdtRows: dirtyCrdtRows.size > 0,
        });

        if (route._tag === "Skip") {
          if (isOnline && started && !signal.aborted) {
            emit({ status: "resolved" });
          }
        } else if (route._tag === "DeferUntilQueueDrains") {
          stopRemoteSubscriptions();
          log.warn(
            "sync: deferring resolve and remote subscriptions until pending queue drains",
          );
        } else if (route._tag === "Resolve") {
          if (
            !options?.forceResolve &&
            dirtyCrdtRows.size > 0 &&
            offlineTransitionsSinceBoot > 0
          ) {
            await resolveDirtyCrdtRows(signal);
          } else {
            await resolveAll(signal);
            if (!signal.aborted) {
              dirtyCrdtRows.clear();
            }
          }
        }

        if (
          shouldStartRemoteSubscriptions({
            aborted: signal.aborted,
            forceResolve: options?.forceResolve ?? false,
            hasPending: !pendingQueue.isEmpty,
            isOnline,
            started,
          })
        ) {
          startRemoteSubscriptions();
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          log.error("sync: online cycle failed", err);
        }
      }
    })().finally(() => {
      syncCyclePromise = null;
      if (abortController?.signal === signal) {
        abortController = null;
      }
    });

    return syncCyclePromise;
  }

  async function resolveDirtyCrdtRows(signal?: AbortSignal): Promise<void> {
    return withSpan("convex-embedded.resolveDirtyCrdtRows", () =>
      resolveDirtyCrdtRowsImpl(signal),
    );
  }

  async function resolveDirtyCrdtRowsImpl(signal?: AbortSignal): Promise<void> {
    if (dirtyCrdtRows.size === 0) {
      return;
    }

    const rowsByTable = new Map<string, Set<string>>();
    for (const key of dirtyCrdtRows) {
      const sep = key.indexOf(":");
      if (sep < 0) continue;
      const tableName = key.slice(0, sep);
      const docId = key.slice(sep + 1);
      if (!crdtFieldsByTable.has(tableName)) continue;
      const set = rowsByTable.get(tableName) ?? new Set<string>();
      set.add(docId);
      rowsByTable.set(tableName, set);
    }

    if (rowsByTable.size === 0) {
      dirtyCrdtRows.clear();
      return;
    }

    const orderedDirtyTables = orderedTables.filter((tableName) =>
      rowsByTable.has(tableName),
    );

    emit({
      status: "resolving",
      progress: {
        tables: orderedDirtyTables,
        completed: 0,
        total: orderedDirtyTables.length,
      },
    });

    try {
      let completed = 0;
      for (const tableName of orderedDirtyTables) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const tableConfig = tables[tableName];
        if (!tableConfig) {
          completed += 1;
          continue;
        }
        const docIds = rowsByTable.get(tableName);
        if (!docIds || docIds.size === 0) {
          completed += 1;
          continue;
        }
        await resolveDirtyRowsForTable(tableName, tableConfig, docIds, signal);
        completed += 1;
        emit({
          status: "resolving",
          progress: {
            tables: orderedDirtyTables,
            completed,
            total: orderedDirtyTables.length,
          },
        });
        await yieldToEventLoop();
      }
      emit({ status: "resolved" });
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      log.error("sync: targeted CRDT merge failed", err);
      emit({
        status: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async function resolveDirtyRowsForTable(
    tableName: string,
    tableConfig: TableConfig,
    docIds: Set<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const localDocs = await getDocumentsForTable(tableName);
    const dirtyLocalDocs = localDocs.filter(
      (doc) => typeof doc._id === "string" && docIds.has(String(doc._id)),
    );
    if (dirtyLocalDocs.length === 0) {
      for (const docId of docIds) {
        clearCrdtRowDirty(tableName, docId);
      }
      return;
    }

    const dirtyDocIds = dirtyLocalDocs.flatMap((doc) =>
      typeof doc._id === "string" ? [String(doc._id)] : [],
    );
    const metadata = await readResolveMetadata(
      tableName,
      tableConfig,
      dirtyDocIds,
    );
    const { schemaDef, localYjsMap, resolveDocuments } = prepareResolveInput(
      tableConfig.schema,
      dirtyLocalDocs,
      metadata,
    );

    if (resolveDocuments.length === 0) {
      for (const docId of docIds) {
        clearCrdtRowDirty(tableName, docId);
      }
      return;
    }

    const retrySchedule = createResolveRetrySchedule({
      maxRetries,
      retryDelayMs,
      signal,
    });
    let attempts = 0;
    const rawResolveResult = await retrySchedule<
      ResolveResponse | Array<ResolveResultRow>
    >(async () => {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      attempts++;
      try {
        return (remoteClient as any).query(tableConfig.resolve, {
          collectionSeq: metadata.collectionSeq,
          documents: resolveDocuments,
        } satisfies ResolveArgs) as Promise<
          ResolveResponse | Array<ResolveResultRow>
        >;
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          log.warn(
            `sync: targeted merge attempt ${attempts}/${maxRetries} failed for "${tableName}"`,
            err,
          );
        }
        throw err;
      }
    });
    const resolveResult = normalizeResolveResponse(
      rawResolveResult,
      metadata.collectionSeq,
    );

    const { mergedDocs, metadataEntries, deletedDocIds } = mergeResolveResult({
      localDocs: dirtyLocalDocs,
      localYjsMap,
      resolveResult,
      schemaDef,
      tableName,
      translateRemoteDocument: (document) =>
        stripOmittedFields(schemaDef, [document])[0] ?? document,
    });

    const { accepted: resolvableDocs } = await filterAfterHydratingReferences({
      docs: mergedDocs,
      tableName,
      signal,
    });

    await ingestMergedDocs({
      ingestDocuments,
      mergedDocs: resolvableDocs,
      tableName,
    });

    const resolvableDocIds = new Set(
      resolvableDocs.flatMap((doc) =>
        typeof doc._id === "string" ? [String(doc._id)] : [],
      ),
    );
    const resolvableMetadataEntries = metadataEntries.filter((entry) =>
      resolvableDocIds.has(entry.docId),
    );

    await persistResolveMetadata({
      tableConfig,
      tableName,
      resolveResult,
      metadataEntries: resolvableMetadataEntries,
      deletedDocIds,
    });

    for (const docId of docIds) {
      clearCrdtRowDirty(tableName, docId);
    }
  }

  async function resolveAll(signal?: AbortSignal): Promise<void> {
    return withSpan("convex-embedded.resolveAll", () => resolveAllImpl(signal));
  }

  async function resolveAllImpl(signal?: AbortSignal): Promise<void> {
    const remoteApplyOrder = getRemoteApplyOrder();
    const scopedResolves = Array.from(activeScopes.values())
      .filter((entry) => Object.keys(entry.scopeArgs).length > 0)
      .sort(
        (left, right) =>
          orderedTables.indexOf(left.tableName) -
          orderedTables.indexOf(right.tableName),
      );
    const progress: ResolveProgress = {
      tables: [
        ...remoteApplyOrder,
        ...scopedResolves.map((entry) =>
          makeScopeKey(entry.tableName, entry.scopeArgs),
        ),
      ],
      completed: 0,
      total: remoteApplyOrder.length + scopedResolves.length,
    };

    emit({ status: "resolving", progress });

    try {
      for (const tableName of remoteApplyOrder) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        await resolveTable(tableName, tables[tableName]!, signal);
        progress.completed++;
        emit({ status: "resolving", progress: { ...progress } });
        await yieldToEventLoop();
      }
      for (const entry of scopedResolves) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        await resolveTable(
          entry.tableName,
          tables[entry.tableName]!,
          signal,
          entry.scopeArgs,
        );
        progress.completed++;
        emit({ status: "resolving", progress: { ...progress } });
        await yieldToEventLoop();
      }
      emit({ status: "resolved" });
      log.info("sync: all tables resolved successfully");
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      log.error("sync: resolve failed", err);
      emit({
        status: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  async function resolveTable(
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    return withSpan(
      "convex-embedded.resolveTable",
      () => resolveTablePaginated(tableName, tableConfig, signal, scopeArgs),
      {
        attributes: {
          "convex.table": tableName,
          "convex.resolve.scoped": Boolean(
            scopeArgs && Object.keys(scopeArgs).length > 0,
          ),
        },
      },
    );
  }

  async function hydrateMissingReferences(input: {
    docs: Array<Record<string, unknown>>;
    tableName: string;
    signal?: AbortSignal;
    visited: Set<string>;
  }): Promise<void> {
    const missing = getMissingReferences({
      docs: input.docs,
      schema: tables[input.tableName]?.schema,
      hasDocumentId: (id) => embedded.hasLocalDocumentId?.(id) ?? false,
      getAliases: (id) => idMap.getAliases(id),
    });
    if (missing.length === 0) {
      return;
    }

    const byTable = new Map<string, Set<string>>();
    for (const ref of missing) {
      if (!(ref.tableName in tables)) {
        continue;
      }
      const ids = byTable.get(ref.tableName) ?? new Set<string>();
      ids.add(ref.id);
      byTable.set(ref.tableName, ids);
    }

    for (const [tableName, ids] of byTable) {
      await hydrateDocumentsById({
        tableName,
        ids: Array.from(ids),
        signal: input.signal,
        visited: input.visited,
      });
    }
  }

  async function filterAfterHydratingReferences(input: {
    docs: Array<Record<string, unknown>>;
    tableName: string;
    signal?: AbortSignal;
    visited?: Set<string>;
  }): Promise<{
    accepted: Array<Record<string, unknown>>;
    skipped: Array<Record<string, unknown>>;
  }> {
    const visited = input.visited ?? new Set<string>();
    let result = filterDocumentsWithResolvableReferences({
      docs: input.docs,
      schema: tables[input.tableName]?.schema,
      hasDocumentId: (id) => embedded.hasLocalDocumentId?.(id) ?? false,
      getAliases: (id) => idMap.getAliases(id),
    });
    if (result.skipped.length === 0) {
      return result;
    }

    try {
      await hydrateMissingReferences({
        docs: result.skipped,
        tableName: input.tableName,
        signal: input.signal,
        visited,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      log.warn(
        `sync: reference hydration failed for "${input.tableName}":`,
        error,
      );
      return result;
    }

    result = filterDocumentsWithResolvableReferences({
      docs: input.docs,
      schema: tables[input.tableName]?.schema,
      hasDocumentId: (id) => embedded.hasLocalDocumentId?.(id) ?? false,
      getAliases: (id) => idMap.getAliases(id),
    });
    return result;
  }

  async function hydrateDocumentsById(input: {
    tableName: string;
    ids: string[];
    signal?: AbortSignal;
    visited: Set<string>;
  }): Promise<void> {
    const tableConfig = tables[input.tableName];
    if (!tableConfig) {
      return;
    }
    const ids = Array.from(new Set(input.ids)).filter((id) => {
      if (embedded.hasLocalDocumentId?.(id) ?? false) {
        return false;
      }
      const key = `${input.tableName}:${id}`;
      if (input.visited.has(key)) {
        return false;
      }
      input.visited.add(key);
      return true;
    });
    if (ids.length === 0) {
      return;
    }
    if (input.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const localDocs = (await getDocumentsForTable(input.tableName)).filter(
      (doc) => typeof doc._id === "string" && ids.includes(String(doc._id)),
    );
    const metadata = await readResolveMetadata(
      input.tableName,
      tableConfig,
      ids,
    );
    const { schemaDef, localYjsMap, resolveDocuments } = prepareResolveInput(
      tableConfig.schema,
      localDocs,
      metadata,
    );

    let rawResolveResult: ResolveResponse | Array<ResolveResultRow>;
    try {
      rawResolveResult = (await (remoteClient as any).query(
        tableConfig.resolve,
        {
          collectionSeq: null,
          documents: resolveDocuments,
          docIds: ids,
        } satisfies ResolveArgs,
      )) as ResolveResponse | Array<ResolveResultRow>;
    } catch (error) {
      if (!isUnsupportedDocIdsResolveError(error)) {
        throw error;
      }
      log.warn(
        `sync: remote resolve for "${input.tableName}" does not support exact doc hydration; falling back to full table resolve`,
      );
      await resolveTable(input.tableName, tableConfig, input.signal);
      return;
    }
    const resolveResult = normalizeResolveResponse(rawResolveResult, null);
    const { deletedDocIds, mergedDocs, metadataEntries } = mergeResolveResult({
      localDocs,
      localYjsMap,
      resolveResult,
      schemaDef,
      tableName: input.tableName,
      translateRemoteDocument: (document) =>
        stripOmittedFields(schemaDef, [document])[0] ?? document,
    });

    const { accepted, skipped } = await filterAfterHydratingReferences({
      docs: mergedDocs,
      tableName: input.tableName,
      signal: input.signal,
      visited: input.visited,
    });
    if (accepted.length > 0) {
      await ingestMergedDocs({
        ingestDocuments,
        mergedDocs: accepted,
        tableName: input.tableName,
      });
    }

    const acceptedDocIds = new Set(
      accepted.flatMap((doc) =>
        typeof doc._id === "string" ? [String(doc._id)] : [],
      ),
    );
    await persistResolveMetadata({
      tableConfig,
      tableName: input.tableName,
      resolveResult,
      metadataEntries: metadataEntries.filter((entry) =>
        acceptedDocIds.has(entry.docId),
      ),
      deletedDocIds,
      clearCollection: false,
    });

    if (skipped.length > 0) {
      log.warn(
        `sync: could not hydrate ${skipped.length} "${input.tableName}" referenced doc(s) due to unresolved references`,
      );
    }
  }

  async function resolveTablePaginated(
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    let attempts = 0;
    const retrySchedule = createResolveRetrySchedule({
      maxRetries,
      retryDelayMs,
      signal,
    });

    const localDocs = await getDocumentsForTable(tableName);
    const scopedLocalDocs =
      scopeArgs && Object.keys(scopeArgs).length > 0
        ? localDocs.filter((doc) =>
            Object.entries(scopeArgs).every(
              ([fieldPath, expected]) =>
                getFieldValueByPath(doc, fieldPath) === expected,
            ),
          )
        : localDocs;

    const docIds = scopedLocalDocs.flatMap((doc) =>
      typeof doc._id === "string" ? [String(doc._id)] : [],
    );

    const hasPendingSelfCausedSignal =
      (expectedSelfCausedSignals.get(tableName)?.length ?? 0) > 0;
    const cachedCollectionSeq = lastKnownCollectionSeqByTable.get(tableName);
    const metadata =
      hasPendingSelfCausedSignal && typeof cachedCollectionSeq === "number"
        ? await readResolveMetadataFastPath(
            tableName,
            tableConfig,
            docIds,
            cachedCollectionSeq,
          )
        : await readResolveMetadata(tableName, tableConfig, docIds);

    const { schemaDef, localYjsMap, resolveDocuments } = prepareResolveInput(
      tableConfig.schema,
      scopedLocalDocs,
      metadata,
    );

    const isNewScope =
      scopeArgs &&
      Object.keys(scopeArgs).length > 0 &&
      scopedLocalDocs.length === 0;
    const effectiveCollectionSeq = isNewScope ? null : metadata.collectionSeq;

    log.debug(
      `sync: resolving "${tableName}" with ${resolveDocuments.length} local doc(s)`,
    );

    const fetchResolvePage = async (fullCursor?: string | null) => {
      const rawResolveResult = await retrySchedule<
        ResolveResponse | Array<ResolveResultRow>
      >(async () => {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        attempts++;
        try {
          return (remoteClient as any).query(tableConfig.resolve, {
            collectionSeq: effectiveCollectionSeq,
            documents: resolveDocuments,
            ...(scopeArgs && Object.keys(scopeArgs).length > 0
              ? { scopeArgs }
              : {}),
            ...(fullCursor !== undefined ? { fullCursor } : {}),
          } satisfies ResolveArgs) as Promise<
            ResolveResponse | Array<ResolveResultRow>
          >;
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            log.warn(
              `sync: resolve attempt ${attempts}/${maxRetries} failed for "${tableName}"`,
              err,
            );
          }
          throw err;
        }
      });
      return normalizeResolveResponse(rawResolveResult, effectiveCollectionSeq);
    };

    const firstResolveResult = await fetchResolvePage();
    let resolveResult = firstResolveResult;
    if (
      firstResolveResult.mode === "full" &&
      firstResolveResult.isDone === false
    ) {
      const fullDocuments = [...firstResolveResult.documents];
      let continueCursor = firstResolveResult.continueCursor ?? null;

      while (continueCursor !== null) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const page = await fetchResolvePage(continueCursor);
        if (page.mode !== "full") {
          throw new Error(
            `[convex-embedded] resolve pagination changed mode unexpectedly for "${tableName}".`,
          );
        }
        fullDocuments.push(...page.documents);
        continueCursor = page.continueCursor ?? null;
        resolveResult = {
          ...page,
          documents: fullDocuments,
          continueCursor,
        };
      }
    }

    const { deletedDocIds, mergedDocs, diffCount, metadataEntries } =
      mergeResolveResult({
        localDocs: scopedLocalDocs,
        localYjsMap,
        resolveResult,
        schemaDef,
        tableName,
        translateRemoteDocument: (document) =>
          stripOmittedFields(schemaDef, [document])[0] ?? document,
      });
    const { accepted: resolvableDocs, skipped: unresolvedDocs } =
      await filterAfterHydratingReferences({
        docs: mergedDocs,
        tableName,
        signal,
      });
    if (unresolvedDocs.length > 0) {
      await runSpan({
        name: "convex_embedded.resolve.unresolved_documents",
        attributes: {
          table: tableName,
          unresolved_count: unresolvedDocs.length,
          merged_count: mergedDocs.length,
        },
        run: async () => undefined,
      });
      log.warn(
        `sync: skipped ${unresolvedDocs.length} "${tableName}" resolve doc(s) with unresolved references`,
      );
    }
    const resolvableDocIds = new Set(
      resolvableDocs.flatMap((doc) =>
        typeof doc._id === "string" ? [String(doc._id)] : [],
      ),
    );
    const resolvableMetadataEntries = metadataEntries.filter((entry) =>
      resolvableDocIds.has(entry.docId),
    );

    await runSpan({
      name: "convex_embedded.resolve.ingest",
      attributes: {
        table: tableName,
        resolved_doc_count: resolveResult.documents.length,
        diff_count: diffCount,
        ingest_count: resolvableDocs.length,
      },
      run: () =>
        ingestMergedDocs({
          ingestDocuments,
          mergedDocs: resolvableDocs,
          scopeArgs,
          tableName,
        }),
    });

    await persistResolveMetadata({
      tableConfig,
      tableName,
      resolveResult,
      metadataEntries: resolvableMetadataEntries,
      deletedDocIds,
    });

    log.debug(
      `sync: resolved table "${tableName}" — ` +
        `${resolveResult.documents.length} doc(s), ${diffCount} diff(s) applied`,
    );
    return;
  }

  /**
   * Subscribe to each table's remote query via `remoteClient.onUpdate()`.
   *
   * When the remote Convex backend pushes new query results (because
   * any client mutated the data), the callback diffs the remote
   * documents against local state and ingests the changes into the
   * embedded runtime.
   *
   * This is the primary mechanism for cross-client real-time sync
   * while online. Resolve (Yjs CRDT diff) handles the offline
   * catch-up case.
   */
  function startRemoteSubscriptions(): void {
    stopRemoteSubscriptions();

    const remoteApplyOrder = getRemoteApplyOrder();
    for (const tableName of remoteApplyOrder) {
      const tableConfig = tables[tableName];
      if (!tableConfig) {
        continue;
      }
      const scopeArgs: Record<string, unknown> = {};
      const key = makeScopeKey(tableName, scopeArgs);
      if (!activeScopes.has(key)) {
        activeScopes.set(key, { tableName, scopeArgs });
      }
    }

    const orderedScopes = Array.from(activeScopes.entries()).sort(
      ([leftKey, left], [rightKey, right]) => {
        const leftOrder = orderedTables.indexOf(left.tableName);
        const rightOrder = orderedTables.indexOf(right.tableName);
        if (leftOrder !== rightOrder) {
          return leftOrder - rightOrder;
        }
        return leftKey.localeCompare(rightKey);
      },
    );

    for (const [, entry] of orderedScopes) {
      if (entry.unsub) {
        continue;
      }
      const tableConfig = tables[entry.tableName];
      if (!tableConfig) {
        continue;
      }
      registerRemoteSubscription({
        getPendingEntries: () => pendingQueue.entries(),
        getAliases: (id) => idMap.getAliases(id),
        bufferRemoteSnapshot,
        translateRemoteSnapshotToLocal: (docs) => docs,
        onUnsubscribe: (unsub) => {
          entry.unsub = unsub;
        },
        resolveServices,
        tableConfig,
        tableName: entry.tableName,
        scopeArgs: entry.scopeArgs,
        consumeExpectedSelfCausedSignal,
        scheduleTableCoalesce,
        onPartialResponse: () => {
          runDetached(
            () =>
              resolveTable(
                entry.tableName,
                tableConfig,
                undefined,
                entry.scopeArgs,
              ),
            `[sync] paginated resolve for "${entry.tableName}":`,
          );
        },
      });
      void yieldToEventLoop();
    }

    log.info(`sync: subscribed to ${orderedScopes.length} remote table(s)`);
  }

  /**
   * Unsubscribe from all active remote reactive subscriptions.
   */
  function stopRemoteSubscriptions(): void {
    if (activeScopes.size === 0) return;

    scopeActivationEpoch++;

    for (const [key, entry] of activeScopes) {
      try {
        entry.unsub?.();
      } catch (err) {
        log.warn("sync: error during remote unsubscribe", err);
      }
      entry.unsub = undefined;
      entry.pendingActivation = undefined;
      const isScoped = Object.keys(entry.scopeArgs).length > 0;
      if (isScoped) {
        activeScopes.delete(key);
      }
    }

    log.info("sync: unsubscribed from remote tables");
  }

  function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function activateScope(
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    if (!(tableName in tables)) {
      return;
    }

    const normalizedScope = canonicalizeScopeArgs(scopeArgs);
    const key = makeScopeKey(tableName, normalizedScope);
    const existing = activeScopes.get(key);
    if (existing?.unsub) {
      return;
    }
    if (existing?.pendingActivation) {
      await existing.pendingActivation;
      return;
    }
    const entry: ActiveScope = existing ?? {
      tableName,
      scopeArgs: normalizedScope,
    };
    if (!existing) activeScopes.set(key, entry);
    if (!isOnline || !started || !pendingQueue.isEmpty) {
      return;
    }

    const tableConfig = tables[tableName];
    if (!tableConfig) {
      return;
    }

    const epochAtStart = scopeActivationEpoch;

    const activation = (async () => {
      await resolveTable(
        tableName,
        tableConfig,
        abortController?.signal ?? undefined,
        normalizedScope,
      );
      await yieldToEventLoop();

      if (scopeActivationEpoch !== epochAtStart || !started) {
        return;
      }

      registerRemoteSubscription({
        getPendingEntries: () => pendingQueue.entries(),
        getAliases: (id) => idMap.getAliases(id),
        bufferRemoteSnapshot,
        translateRemoteSnapshotToLocal: (docs) => docs,
        onUnsubscribe: (unsub) => {
          entry.unsub = unsub;
        },
        resolveServices,
        tableConfig,
        tableName,
        scopeArgs: normalizedScope,
        consumeExpectedSelfCausedSignal,
        scheduleTableCoalesce,
        onPartialResponse: () => {
          runDetached(
            () =>
              resolveTable(
                tableName,
                tableConfig,
                undefined,
                normalizedScope,
              ),
            `[sync] paginated resolve for scoped "${tableName}":`,
          );
        },
      });
    })();

    entry.pendingActivation = activation;
    try {
      await activation;
    } finally {
      if (entry.pendingActivation === activation) {
        entry.pendingActivation = undefined;
      }
    }
  }

  function handleOnline() {
    log.info("sync: online event — flushing queue, resolving, subscribing");
    if (cameOnlineAfterOfflinePeriod) {
      offlineTransitionsSinceBoot += 1;
      cameOnlineAfterOfflinePeriod = false;
    }
    isOnline = true;
    recordCounter("connectivity.transition", { state: "online" });

    runDetached(() => runSyncCycle(), "[sync] handleOnline:");
  }

  function handleOffline() {
    log.info("sync: offline event");
    if (isOnline) {
      cameOnlineAfterOfflinePeriod = true;
    }
    isOnline = false;
    recordCounter("connectivity.transition", { state: "offline" });
    abortController?.abort();
    abortController = null;
    stopRemoteSubscriptions();
    clearBufferedSnapshots();
    emit({ status: "offline" });
  }

  async function hydrateIdentityState(): Promise<void> {
    try {
      await Promise.all([
        idMap.hydrate(),
        pendingQueue.hydrate(),
        pendingUploadQueue.hydrate(),
      ]);
    } catch (err) {
      log.warn("sync: hydration failed", err);
    }
  }

  function getCurrentIdentityKey(): string | null {
    return getIdentityKey?.() ?? null;
  }

  async function runLocalSystemMutation(
    path: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (executeLocal) {
      await executeLocal({
        kind: "mutation",
        path,
        args,
        applyLocalEffects: true,
      });
      return;
    }
    await (localClient as any).mutation(path, args);
  }

  async function runLocalSystemQuery<T>(
    path: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (executeLocal) {
      return (await executeLocal({
        kind: "query",
        path,
        args,
      })) as T;
    }
    return (await (localClient as any).query(path, args)) as T;
  }

  async function readResolveMetadata(
    tableName: string,
    tableConfig: TableConfig,
    docIds: string[],
  ): Promise<ResolveMetadata> {
    const schemaVersion = tableConfig.schema.version;
    const identityKey = getCurrentIdentityKey();
    const [collectionSeq, documentEntries] = await Promise.all([
      runLocalSystemQuery<number | null>(SystemPaths.collectionMetadataGet, {
        collection: tableName,
        identityKey,
        schemaVersion,
      }),
      runLocalSystemQuery<Array<{ docId: string; seq: number }>>(
        SystemPaths.documentMetadataGetBatch,
        {
          collection: tableName,
          docIds,
          identityKey,
          schemaVersion,
        },
      ),
    ]);

    return {
      collectionSeq: collectionSeq ?? null,
      documentSeqById: new Map(
        (documentEntries ?? []).map((entry) => [entry.docId, entry.seq]),
      ),
    };
  }

  async function readResolveMetadataFastPath(
    tableName: string,
    tableConfig: TableConfig,
    docIds: string[],
    knownCollectionSeq: number,
  ): Promise<ResolveMetadata> {
    const schemaVersion = tableConfig.schema.version;
    const identityKey = getCurrentIdentityKey();
    const documentEntries = await runLocalSystemQuery<
      Array<{ docId: string; seq: number }>
    >(SystemPaths.documentMetadataGetBatch, {
      collection: tableName,
      docIds,
      identityKey,
      schemaVersion,
    });

    return {
      collectionSeq: knownCollectionSeq,
      documentSeqById: new Map(
        (documentEntries ?? []).map((entry) => [entry.docId, entry.seq]),
      ),
    };
  }

  async function persistResolveMetadata(input: {
    tableConfig: TableConfig;
    tableName: string;
    resolveResult: ResolveResponse;
    metadataEntries: Array<{ docId: string; seq: number }>;
    deletedDocIds: string[];
    clearCollection?: boolean;
  }): Promise<void> {
    const schemaVersion = input.tableConfig.schema.version;
    const identityKey = getCurrentIdentityKey();

    const currentMeta = await readResolveMetadata(
      input.tableName,
      input.tableConfig,
      [],
    );
    const newCollectionSeq = input.resolveResult.collectionSeq;
    const operations: Array<Promise<void>> = [];
    if (
      currentMeta.collectionSeq === null ||
      newCollectionSeq > currentMeta.collectionSeq
    ) {
      operations.push(
        runLocalSystemMutation(SystemPaths.collectionMetadataSet, {
          collection: input.tableName,
          seq: newCollectionSeq,
          identityKey,
          schemaVersion,
        }),
      );
    }

    if (
      input.resolveResult.mode === "full" &&
      input.clearCollection !== false
    ) {
      operations.push(
        runLocalSystemMutation(SystemPaths.documentMetadataClearCollection, {
          collection: input.tableName,
          identityKey,
          schemaVersion,
        }),
      );
    }

    if (input.metadataEntries.length > 0) {
      operations.push(
        runLocalSystemMutation(SystemPaths.documentMetadataSetBatch, {
          collection: input.tableName,
          entries: input.metadataEntries,
          identityKey,
          schemaVersion,
        }),
      );
    }

    if (input.deletedDocIds.length > 0) {
      operations.push(
        runLocalSystemMutation(SystemPaths.documentMetadataDeleteBatch, {
          collection: input.tableName,
          docIds: input.deletedDocIds,
          identityKey,
          schemaVersion,
        }),
      );
    }

    await Promise.all(operations);
  }

  async function cleanupMappedCreateAlias(localId: string): Promise<void> {
    if (embedded.hasLocalDocumentId?.(localId) ?? false) {
      return;
    }
    if (!idMap.hasLocalId(localId)) {
      return;
    }
    await idMap.delete(localId);
  }

  async function heartbeatProcessor(): Promise<void> {
    await runLocalSystemMutation(SystemPaths.processorHeartbeat, {
      processorId: processorIdForReplay,
      identityKey: getCurrentIdentityKey(),
    });
  }

  async function heartbeatProcessorSafe(): Promise<void> {
    try {
      await heartbeatProcessor();
    } catch (err) {
      log.debug("sync: processor heartbeat failed", err);
    }
  }

  function startProcessorHeartbeat(): void {
    runDetached(heartbeatProcessorSafe, "[sync] processor heartbeat:");
    if (processorHeartbeatTimer !== null) {
      clearInterval(processorHeartbeatTimer);
    }
    processorHeartbeatTimer = setInterval(() => {
      runDetached(heartbeatProcessorSafe, "[sync] processor heartbeat:");
    }, processorHeartbeatMs);
  }

  function stopProcessorHeartbeat(): void {
    if (processorHeartbeatTimer !== null) {
      clearInterval(processorHeartbeatTimer);
      processorHeartbeatTimer = null;
    }
    runDetached(
      () =>
        runLocalSystemMutation(SystemPaths.processorRemove, {
          processorId: processorIdForReplay,
          identityKey: getCurrentIdentityKey(),
        }),
      "[sync] processor cleanup:",
    );
  }

  return {
    start() {
      if (started) return;
      started = true;

      log.info("sync: started");
      startProcessorHeartbeat();

      const hydrationPromise = hydrateIdentityState();

      const runOnlineAfterHydration = createHydrationAwareOnlineHandler({
        handleOnline,
        hydrationPromise,
        isStarted: () => started,
      });

      const connectivity = getConnectivityAdapter(config.connectivity);

      const startRoute = getStartLifecycleRoute({
        hasNavigator: true,
        navigatorOnline: connectivity?.isOnline(),
      });

      matchTag(startRoute, "_tag", {
        Offline: () => {
          isOnline = false;
          emit({ status: "offline" });
        },
        WaitForHydrationThenOnline: () => {
          runOnlineAfterHydration();
        },
      });

      if (connectivity.onOnline && connectivity.onOffline) {
        onOnline = runOnlineAfterHydration;
        onOffline = handleOffline;
        cleanupOnlineListener = connectivity.onOnline(onOnline);
        cleanupOfflineListener = connectivity.onOffline(onOffline);
      }
    },

    stop() {
      if (!started) return;
      started = false;

      log.info("sync: stopped");
      stopProcessorHeartbeat();
      unregisterPendingDepth();
      unregisterPendingUploadsDepth();

      abortController?.abort();
      abortController = null;
      if (activeEntry) {
        const entry = activeEntry;
        activeEntry = null;
        runDetached(
          () => pendingQueue.release(entry, processorIdForReplay),
          "[sync] release pending claim:",
        );
      }

      stopRemoteSubscriptions();
      clearBufferedSnapshots();

      cleanupOnlineListener?.();
      cleanupOfflineListener?.();
      cleanupOnlineListener = null;
      cleanupOfflineListener = null;
      onOnline = null;
      onOffline = null;

      emit({ status: "idle" });
      listeners.clear();
    },

    on(event: "change", listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getStatus(): EngineStatus {
      return status;
    },

    async mutation(
      ref: unknown,
      args: Record<string, unknown>,
      options?: { enqueueForReplay?: boolean },
    ): Promise<unknown> {
      const enqueueForReplay = options?.enqueueForReplay ?? true;
      const executeMutationLocally = executeLocalMutationWithEffects
        ? executeLocalMutationWithEffects
        : (r: unknown, a: Record<string, unknown>) =>
            (localClient as any).mutation(r, a) as Promise<unknown>;

      const refName = getFunctionName(ref as any);
      const localArgs = idMap.translateRemoteIdsToLocal(args);

      const __mutStart = globalThis.performance?.now?.() ?? Date.now();
      let localResult: unknown = undefined;
      let localFailed = false;
      try {
        localResult = await executeMutationLocally(ref, localArgs);
      } catch (err) {
        if (!isOnline) {
          throw err;
        }
        localFailed = true;
        log.debug(
          `sync: local mutation "${refName}" failed; falling back to remote`,
          err,
        );
      }

      const __localDone = globalThis.performance?.now?.() ?? Date.now();
      log.debug(
        `engine.mutation local-done t+${(__localDone - __mutStart).toFixed(1)}ms ref=${refName}`,
      );

      if (localFailed) {
        const remoteResult = await (remoteClient as any).mutation(ref, args);
        return remoteResult;
      }

      if (isLocalUploadUrl(localResult)) {
        registerUploadUrlSource?.(localResult, refName);
        return localResult;
      }

      if (enqueueForReplay) {
        const table = inferTableFromRef(ref, tables);
        if (!table) {
          throw new Error(
            `[convex-embedded] could not infer table for mutation ref "${refName}".`,
          );
        }
        // Detach pending-queue persistence so the user mutation returns
        // immediately after local memory commit. Subsequent mutations may
        // race their pending-pushes through the runtime's transaction lock
        // (which already serialises commits), preserving ordering.
        const replayPayloadVersion = getReplayPayloadVersion?.(refName) ?? 1;
        const __pushStart = globalThis.performance?.now?.() ?? Date.now();
        await pendingQueue.push(
          ref,
          args,
          localResult,
          table,
          replayPayloadVersion,
        );
        const __pushDone = globalThis.performance?.now?.() ?? Date.now();
        log.debug(
          `engine.mutation queue.push push=${(__pushDone - __pushStart).toFixed(1)}ms ref=${refName}`,
        );
        if (!isOnline && crdtFieldsByTable.has(table)) {
          const docId =
            typeof localResult === "string"
              ? localResult
              : ((localArgs?.id as string | undefined) ??
                (localArgs?._id as string | undefined));
          if (docId) {
            markCrdtRowDirty(table, docId);
          }
        }
        if (isOnline) {
          ensureReplayProcessing();
        } else {
          log.debug("sync: offline — mutation queued for later push");
        }
      }

      const __chainDone = globalThis.performance?.now?.() ?? Date.now();
      log.debug(
        `engine.mutation chain-done t+${(__chainDone - __mutStart).toFixed(1)}ms ref=${refName}`,
      );
      return localResult;
    },

    resolveNow(): Promise<void> {
      if (isOnline) {
        stopRemoteSubscriptions();
      }
      return runSyncCycle({ forceResolve: true });
    },

    ensureTableReady(tableName: string): Promise<void> {
      return activateScope(tableName);
    },

    ensureScopeReady(
      tableName: string,
      scopeArgs?: Record<string, unknown>,
    ): Promise<void> {
      return activateScope(tableName, scopeArgs);
    },

    async reloadIdentity(): Promise<void> {
      await hydrateIdentityState();
      clearBufferedSnapshots();
      await pendingQueue.unblockAll();

      if (!started) {
        return;
      }

      if (isOnline) {
        stopRemoteSubscriptions();
        await runSyncCycle({ forceResolve: true });
        return;
      }

      emit({ status: "offline" });
    },

    pendingCount(): number {
      return pendingQueue.length;
    },

    get idMap() {
      return idMap;
    },

    get pendingQueue() {
      return pendingQueue;
    },

    async [Symbol.asyncDispose](): Promise<void> {
      this.stop();
    },
  };
}

/** @internal */
export const engine = {
  create: createEngine,
};
