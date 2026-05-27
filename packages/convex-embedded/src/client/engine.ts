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

import * as pull from "@/client/engine/pull";
import type { MergeState, PullDeps, PullState } from "@/client/engine/pull";
import { ReplayLoopState } from "@/client/engine/replay";
import * as scheduler from "@/client/engine/scheduler";
import type { SchedulerDeps, SchedulerState } from "@/client/engine/scheduler";
import * as subscriptions from "@/client/engine/subscriptions";
import type {
  ScopeRecord,
  SubscriptionsDeps,
  SubscriptionsState,
} from "@/client/engine/subscriptions";
import { IdMap, extractSchemaIdFields } from "@/client/ids";
import { MAX_REPLAY_RETRIES, PendingQueue } from "@/client/pending/queue";
import type { PendingEntry } from "@/client/pending/queue";
import {
  PendingUploadQueue,
  type PendingUploadEntry,
} from "@/client/pending/uploads";
import type { EngineResolveInput } from "@/client/services/engine";
import { SystemPaths } from "@/kernel/system";
import type {
  IngestDocumentsOptions,
  LocalExecutionRequest,
} from "@/runtime/embedded";
import {
  createAmbientConnectivityAdapter,
  type ConnectivityAdapter,
} from "@/runtime/platform";
import { unwrapSchemaField } from "@/shared/canonicalize";
import { parseErrorMetadata } from "@/shared/errors";
import { createLogger } from "@/shared/logger";
import { matchTag } from "@/shared/match";
import { getFunctionName, makeFunctionReference } from "@/shared/refs";
import type { Definition } from "@/shared/schema";
import type { EngineStatus } from "@/shared/types";
import { recordCounter, registerGauge } from "@/tracing/metrics";
import { withSpan } from "@/tracing/spans";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

export type ChangeListener = (status: EngineStatus) => void;

class EngineStatusEmitter {
  private currentStatus: EngineStatus = { status: "idle" };
  private readonly listeners = new Set<ChangeListener>();

  get(): EngineStatus {
    return this.currentStatus;
  }

  emit(next: EngineStatus): void {
    if (
      next.status === "resolved" &&
      this.currentStatus.status !== "resolved"
    ) {
      recordCounter("sync.cycle");
    }
    this.currentStatus = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        log.error("sync: listener threw", err);
      }
    }
  }

  on(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}

interface RemoteCallable {
  onUpdate(...args: unknown[]): () => void;
  mutation(ref: unknown, args: unknown): Promise<unknown>;
  query(ref: unknown, args: unknown): Promise<unknown>;
}

interface LocalPathCallable {
  mutation(ref: unknown, args: unknown): Promise<unknown>;
  query(ref: unknown, args: unknown): Promise<unknown>;
}

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

function buildScopeKey(
  tableName: string,
  scopeArgs?: Record<string, unknown>,
): string {
  const normalized = canonicalizeScopeArgs(scopeArgs);
  if (Object.keys(normalized).length === 0) return tableName;
  return `${tableName}::${JSON.stringify(normalized)}`;
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
  pullServices: EngineResolveInput;
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
  shouldSkipRedundantPartialPull?: (
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    signalSeq: number,
  ) => boolean;
}) {
  const remoteClient = input.pullServices.remoteClient;
  const baseHandler = createRemoteUpdateHandler({
    ingestDocuments: (table, documents, scopeArgs) =>
      input.pullServices.ingestDocuments(table, documents, scopeArgs),
    getDocumentsForTable: (table) =>
      input.pullServices.getDocumentsForTable(table),
    getPendingEntries: input.getPendingEntries,
    getAliases: input.getAliases,
    bufferRemoteSnapshot: input.bufferRemoteSnapshot,
    translateRemoteSnapshotToLocal: input.translateRemoteSnapshotToLocal,
    schema: input.tableConfig.schema,
    scopeArgs: input.scopeArgs,
    tableName: input.tableName,
  });

  const unwrapPullResponse = (response: unknown) => {
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
      if (
        input.shouldSkipRedundantPartialPull?.(
          input.tableName,
          input.scopeArgs,
          signalSeq,
        ) === true
      ) {
        return;
      }
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
      const scopeKey = buildScopeKey(input.tableName, input.scopeArgs);
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

  const unsub = (remoteClient as unknown as RemoteCallable).onUpdate(
    input.tableConfig.resolve,
    {
      collectionSeq: null,
      documents: [],
      ...(input.scopeArgs && Object.keys(input.scopeArgs).length > 0
        ? { scopeArgs: input.scopeArgs }
        : {}),
    },
    unwrapPullResponse,
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
    options?: IngestDocumentsOptions,
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

  /**
   * Return only the documents matching `scopeArgs` from the local embedded
   * database, using a matching index (O(scope) instead of O(table)). Returns
   * `null` when no index covers the scope, so the caller can fall back to a
   * whole-table read + filter.
   */
  getDocumentsForScope?(
    table: string,
    scopeArgs: Record<string, unknown>,
  ): Promise<Array<Record<string, unknown>> | null>;

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
   * Delay before deactivating a scope whose last reader unsubscribed (default:
   * 3000). Prevents thrash when switching back and forth quickly.
   */
  scopeTeardownDebounceMs?: number;

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

type QueueEntryRoute =
  | { _tag: "Stop" }
  | { _tag: "DropMappedCreate"; localResult: string }
  | { _tag: "Push"; localResult: unknown };

type StorageDependency = {
  localStorageId: string;
  metadata: Record<string, unknown>;
  blob: Blob;
};

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
  mutation(
    ref: unknown,
    args: Record<string, unknown>,
    options?: { enqueueForReplay?: boolean },
  ): Promise<unknown>;

  /** Manually trigger a resolve cycle (e.g., after coming back online). */
  pullNow(): Promise<void>;

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
    readKey?: string,
  ): Promise<void>;

  releaseScopeRead(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    readKey: string,
  ): void;

  /**
   * Subscribe to the first resolve of `(tableName, scopeArgs)`. The callback
   * fires once when the scope first resolves; if it has already resolved, it
   * fires immediately. Returns an unsubscribe function.
   */
  onScopeResolved(
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    cb: () => void,
  ): () => void;

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
  const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);

  const moduleName = name.split(":")[0] ?? "";
  if (moduleName in tables) {
    return moduleName;
  }

  return null;
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

function gatherReferencedTables(field: unknown, referenced: Set<string>): void {
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
    gatherReferencedTables(validator.element, referenced);
    return;
  } else if (validator.kind === "record") {
    gatherReferencedTables(validator.value, referenced);
    return;
  } else if (validator.kind === "object") {
    const fields = validator.fields as Record<string, unknown> | undefined;
    if (!fields) {
      return;
    }
    for (const nested of Object.values(fields)) {
      gatherReferencedTables(nested, referenced);
    }
    return;
  } else if (validator.kind === "union") {
    const members = validator.members;
    if (!Array.isArray(members)) {
      return;
    }
    for (const member of members) {
      gatherReferencedTables(member, referenced);
    }
    return;
  } else if (validator.kind === "optional") {
    gatherReferencedTables(validator.field, referenced);
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
          gatherReferencedTables(field, referenced);
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
        gatherReferencedTables(field, referenced);
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
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    if (value !== null && value !== undefined) {
      attributes[key] = value;
    }
  }
  return withSpan(input.name, () => input.run(), { attributes });
}

function getConnectivityAdapter(
  connectivity?: ConnectivityAdapter,
): ConnectivityAdapter {
  return connectivity ?? createAmbientConnectivityAdapter();
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

function gatherCandidateStorageIds(
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
    value.forEach((entry) => gatherCandidateStorageIds(entry, seen));
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
    gatherCandidateStorageIds(entry, seen),
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
  const uploadUrl = (await (
    input.remoteClient as unknown as RemoteCallable
  ).mutation(input.uploadUrlRef, {})) as string;

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
    return { _tag: "Stop" };
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

class EngineImpl implements EngineInstance {
  // Subsystem instances — hoisted from constructor closure consts so
  // class methods outside the constructor can reach them without going
  // through `this.impl`. Declared (but not all read yet — TS unused
  // checks are silenced because every assignment in the constructor
  // counts as a read for `readonly` fields).
  /** @internal */ readonly _statusEmitter!: EngineStatusEmitter;
  /** @internal */ readonly _idMap!: IdMap;
  /** @internal */ readonly _pendingQueue!: PendingQueue;
  /** @internal */ readonly _pendingUploadQueue!: PendingUploadQueue;
  /** @internal */ readonly _schedulerState!: SchedulerState;
  /** @internal */ readonly _mergeState!: MergeState;
  /** @internal */ readonly _pullState!: PullState;
  /** @internal */ readonly _subsState!: SubscriptionsState;
  /** @internal */ readonly _replayLoop!: ReplayLoopState;

  start!: () => void;
  stop!: () => void;
  mutation!: (
    ref: unknown,
    args: Record<string, unknown>,
    options?: { enqueueForReplay?: boolean },
  ) => Promise<unknown>;
  pullNow!: () => Promise<void>;
  ensureTableReady!: (tableName: string) => Promise<void>;
  ensureScopeReady!: (
    tableName: string,
    scopeArgs?: Record<string, unknown>,
    readKey?: string,
  ) => Promise<void>;
  releaseScopeRead!: (
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    readKey: string,
  ) => void;
  onScopeResolved!: (
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    cb: () => void,
  ) => () => void;
  reloadIdentity!: () => Promise<void>;
  constructor(config: EngineConfig) {
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
      options?: IngestDocumentsOptions,
    ): Promise<void> {
      const prev = ingestLockMap.get(table) ?? Promise.resolve();
      const next = prev.then(
        () => rawIngestDocuments(table, docs, scopeArgs, options),
        () => rawIngestDocuments(table, docs, scopeArgs, options),
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
    const getDocumentsForScope = embedded.getDocumentsForScope?.bind(embedded);
    const tableSchemas = Object.fromEntries(
      Object.entries(tables)
        .filter(([, tableConfig]) => tableConfig.schema !== undefined)
        .map(([tableName, tableConfig]) => [tableName, tableConfig.schema]),
    ) as Record<string, Definition>;
    const orderedTables = orderTablesByDependencies(tables);
    const activatedRemoteTables = new Set(rootTablesByDependencies(tables));
    const processorHeartbeatMs = Math.max(1_000, Math.floor(leaseMs / 3));

    const replayLoop = new ReplayLoopState();
    const addRecentlyReplayed = (id: string) =>
      replayLoop.addRecentlyReplayed(id);
    const getRecentlyReplayedIdSet = () => replayLoop.recentlyReplayedIdSet();
    const pullServices: EngineResolveInput = {
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
            path: getFunctionName(ref as Parameters<typeof getFunctionName>[0]),
            args,
            applyLocalEffects: true,
          })
      : undefined;

    const statusEmitter = new EngineStatusEmitter();
    this._statusEmitter = statusEmitter;
    let started = false;
    const schedulerState = scheduler.createSchedulerState();
    const subsState = subscriptions.createSubscriptionsState();

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

    const mergeState = pull.createMergeState(tables);

    let onOnline: (() => void) | null = null;
    let onOffline: (() => void) | null = null;
    let cleanupOnlineListener: (() => void) | null = null;
    let cleanupOfflineListener: (() => void) | null = null;
    const SCOPE_TEARDOWN_DEBOUNCE_MS = config.scopeTeardownDebounceMs ?? 3000;

    const pullState = pull.createPullState();

    const subsDeps: SubscriptionsDeps = {
      orderedTables,
      canonicalizeScopeArgs,
      buildScopeKey,
      projectRemoteSnapshot,
      getDocumentsForTable,
      filterAfterHydratingReferences,
      ingestDocuments,
      runSpan,
      yieldToEventLoop,
      getRecentlyReplayedIdSet: () => getRecentlyReplayedIdSet(),
      getPendingEntries: () => pendingQueue.entries(),
      getAliases: (id) => idMap.getAliases(id),
      clearPullSequencing: () => pull.clearAll(pullState),
    };

    function getRemoteApplyOrder(): string[] {
      return orderedTables.filter((tableName) =>
        activatedRemoteTables.has(tableName),
      );
    }

    const bufferRemoteSnapshot = async (
      tableName: string,
      docs: Array<Record<string, unknown>>,
      scopeArgs?: Record<string, unknown>,
    ): Promise<void> => {
      subscriptions.bufferRemoteSnapshot(
        subsState,
        subsDeps,
        tableName,
        docs,
        scopeArgs,
      );
    };
    const clearBufferedSnapshots = () =>
      subscriptions.clearAll(subsState, subsDeps);

    function ensureReplayProcessing(): void {
      if (!scheduler.isOnline(schedulerState)) return;
      const hasPendingMutation = !pendingQueue.isEmpty;
      const hasPendingUpload = pendingUploadQueue.length > 0;
      if (!hasPendingMutation && !hasPendingUpload) return;

      runDetached(async () => {
        await processUploadQueue();
        const deadLettered = await processQueue();
        await rollbackDeadLetteredTables(deadLettered);

        if (pendingQueue.isEmpty) {
          subscriptions.softResetBuffers(subsState);
          if (!subscriptions.hasActive(subsState) && started) {
            void scheduler.run(schedulerState, schedulerDeps);
          }
          return;
        }

        stopRemoteSubscriptions();
      }, "[sync] ensureReplayProcessing:");
    }

    function emit(newStatus: EngineStatus): void {
      statusEmitter.emit(newStatus);
    }

    async function gatherUnmappedStorageDependencies(
      args: Record<string, unknown>,
    ): Promise<StorageDependency[]> {
      if (!getStorageBlob || !getStorageMetadata) {
        return [];
      }

      const dependencies: StorageDependency[] = [];
      for (const candidate of gatherCandidateStorageIds(args)) {
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
      const dependencies = await gatherUnmappedStorageDependencies(args);
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
      if (replayLoop.inFlight()) {
        replayLoop.setRequestedWhileActive(true);
        return replayLoop.inFlight()!;
      }
      if (pendingQueue.isEmpty) {
        await pendingQueue.hydrate();
      }
      if (pendingQueue.isEmpty) return new Set();

      const deadLetteredTables = new Set<string>();

      log.info(`sync: processing ${pendingQueue.length} queued mutation(s)`);

      const cyclePromise = (async () => {
        try {
          outer: while (
            scheduler.isOnline(schedulerState) &&
            !signal?.aborted
          ) {
            replayLoop.setRequestedWhileActive(false);
            while (
              !pendingQueue.isEmpty &&
              scheduler.isOnline(schedulerState) &&
              !signal?.aborted
            ) {
              const entry = await pendingQueue.claimNext(
                processorIdForReplay,
                leaseMs,
                leaseMs,
              );
              if (!entry) break;
              replayLoop.setActiveEntry(entry);
              if (entry.state === "blocked") {
                log.warn(
                  `sync: blocked pending entry for ${entry.ref}; halting replay`,
                );
                break outer;
              }

              const replayDocId = extractPendingLogicalId(entry);
              const route = getQueueEntryRoute({
                entry,
                hasMappedLocalId: (localId: string) =>
                  idMap.hasLocalId(localId),
                hasActiveLocalDocument: (localId: string) =>
                  embedded.hasLocalDocumentId?.(localId) ?? false,
                getRemoteId: (localId: string) => idMap.getRemoteId(localId),
                isOnline: scheduler.isOnline(schedulerState),
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

              if (route._tag === "Stop") break;
              if (route._tag === "DropMappedCreate") {
                await pendingQueue.remove(entry, processorIdForReplay);
                if (replayDocId) addRecentlyReplayed(replayDocId);
                await cleanupMappedCreateAlias(route.localResult);
                log.debug(
                  `sync: dropping already-mapped create mutation (remaining: ${pendingQueue.length})`,
                );
                recordCounter("replay.outcome", { result: "drop_mapped" });
                continue;
              }
              if (route._tag !== "Push") break;

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
                    replayLoop.setActiveEntry(null);
                    log.warn(
                      `sync: lost replay lease before remote push (table: ${entry.table})`,
                    );
                    break;
                  }
                  log.warn(
                    `sync: continuing replay for current-session entry after lease renewal miss (table: ${entry.table})`,
                  );
                }

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
                    (remoteClient as unknown as RemoteCallable).mutation(
                      ref,
                      translatedArgs,
                    ),
                  );
                } finally {
                  heartbeat.stop();
                }

                pull.recordExpectedSelfCausedSignal(
                  pullState,
                  entry.table,
                  pull.nextExpectedSelfCausedSeq(pullState, entry.table),
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
                  await idMap.set(route.localResult, remoteResult, entry.table);
                }
                await pendingQueue.remove(entry, processorIdForReplay);
                if (replayDocId) addRecentlyReplayed(replayDocId);
                replayLoop.setActiveEntry(null);
                log.debug(
                  `sync: pushed mutation to remote (table: ${entry.table}, remaining: ${pendingQueue.length})`,
                );
                recordCounter("replay.outcome", {
                  result: "success",
                  "convex.table": entry.table,
                });
              } catch (err) {
                if (isAlreadyAppliedReplayError(entry, err as Error)) {
                  await pendingQueue.remove(entry, processorIdForReplay);
                  if (replayDocId) addRecentlyReplayed(replayDocId);
                  replayLoop.setActiveEntry(null);
                  log.debug(
                    `sync: dropping already-applied mutation (table: ${entry.table}, remaining: ${pendingQueue.length})`,
                  );
                  recordCounter("replay.outcome", {
                    result: "drop_already_applied",
                    "convex.table": entry.table,
                  });
                  continue;
                }
                if (err instanceof ReplayLeaseLostError) {
                  replayLoop.setActiveEntry(null);
                  log.warn(
                    `sync: replay lease lost while processing ${entry.ref}`,
                  );
                  recordCounter("replay.outcome", {
                    result: "lease_lost",
                    "convex.table": entry.table,
                  });
                  break;
                }
                const reason = classifyReplayError(err as Error);
                if (reason !== "unknown") {
                  await pendingQueue.block(entry, reason);
                  replayLoop.setActiveEntry(null);
                  recordCounter("replay.outcome", {
                    result: "blocked",
                    reason,
                    "convex.table": entry.table,
                  });
                  break;
                }
                entry.retryCount = (entry.retryCount ?? 0) + 1;
                if (entry.retryCount >= MAX_REPLAY_RETRIES) {
                  log.error(
                    `sync: mutation exceeded max retries (${MAX_REPLAY_RETRIES}), dead-lettering (table: ${entry.table}, ref: ${entry.ref})`,
                    err,
                  );
                  await pendingQueue.remove(entry, processorIdForReplay);
                  deadLetteredTables.add(entry.table);
                  replayLoop.setActiveEntry(null);
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
                  replayLoop.setActiveEntry(null);
                  recordCounter("replay.outcome", {
                    result: "released",
                    "convex.table": entry.table,
                  });
                }
                break;
              }
            }
            if (
              !replayLoop.requestedWhileActive() ||
              pendingQueue.isEmpty ||
              !scheduler.isOnline(schedulerState) ||
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
        replayLoop.setInFlight(null);
      });
      replayLoop.setInFlight(cyclePromise);

      const result = await cyclePromise;

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
          await getTableSpec(tableName, tableConfig, signal);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") break;
          log.error(
            `sync: rollback resolve failed for table "${tableName}"`,
            err,
          );
        }
      }
    }

    async function mergeDirtyCrdtRows(signal?: AbortSignal): Promise<void> {
      return pull.runMerge(pullState, mergeState, pullDeps, signal);
    }

    async function pullAll(signal?: AbortSignal): Promise<void> {
      return pull.pullAll(pullState, pullDeps, signal);
    }

    async function getTableSpec(
      tableName: string,
      tableConfig: TableConfig,
      signal?: AbortSignal,
      scopeArgs?: Record<string, unknown>,
    ): Promise<void> {
      return pull.getTableSpec(
        pullState,
        pullDeps,
        tableName,
        tableConfig,
        signal,
        scopeArgs,
      );
    }

    async function filterAfterHydratingReferences(input: {
      docs: Array<Record<string, unknown>>;
      tableName: string;
      signal?: AbortSignal;
    }): Promise<{
      accepted: Array<Record<string, unknown>>;
      skipped: Array<Record<string, unknown>>;
    }> {
      return pull.filterAfterHydratingReferences(pullDeps, input);
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

      // (Re)subscribe the scopes that are already active — e.g. after a reconnect.
      const orderedScopes = Array.from(subsState.scopes.entries()).sort(
        ([leftKey, left], [rightKey, right]) => {
          const leftOrder = orderedTables.indexOf(left.tableName);
          const rightOrder = orderedTables.indexOf(right.tableName);
          if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
          }
          return leftKey.localeCompare(rightKey);
        },
      );

      for (const [key, entry] of orderedScopes) {
        if (entry.unsubscribe) {
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
            entry.unsubscribe = unsub;
          },
          pullServices,
          tableConfig,
          tableName: entry.tableName,
          scopeArgs: entry.scopeArgs,
          consumeExpectedSelfCausedSignal: (table, signalSeq) =>
            pull.consumeExpectedSelfCausedSignal(pullState, table, signalSeq),
          scheduleTableCoalesce: (input) =>
            pull.scheduleTableCoalesce(pullState, input),
          shouldSkipRedundantPartialPull: (table, scopeArgs, signalSeq) =>
            pull.shouldSkipRedundantPartialPull(
              pullState,
              { buildScopeKey },
              table,
              scopeArgs,
              signalSeq,
            ),
          onPartialResponse: () => {
            runDetached(
              () =>
                getTableSpec(
                  entry.tableName,
                  tableConfig,
                  undefined,
                  entry.scopeArgs,
                ),
              `[sync] paginated resolve for "${entry.tableName}":`,
            );
          },
        });
        if (!pull.hasPulledScopeSeq(pullState, key)) {
          runDetached(
            () =>
              getTableSpec(
                entry.tableName,
                tableConfig,
                undefined,
                entry.scopeArgs,
              ),
            `[sync] cold resolve for "${entry.tableName}":`,
          );
        }
        void yieldToEventLoop();
      }

      log.info(`sync: subscribed to ${orderedScopes.length} remote table(s)`);
    }

    /**
     * Unsubscribe from all active remote reactive subscriptions.
     */
    function stopRemoteSubscriptions(): void {
      subscriptions.clearAllTeardownTimers(subsState);

      if (!subscriptions.hasActive(subsState)) return;

      subscriptions.bumpEpoch(subsState);

      for (const [key, entry] of subsState.scopes) {
        try {
          entry.unsubscribe?.();
        } catch (err) {
          log.warn("sync: error during remote unsubscribe", err);
        }
        entry.unsubscribe = undefined;
        entry.pendingActivation = undefined;
        const isScoped = Object.keys(entry.scopeArgs).length > 0;
        const hasReaders = (entry.readers?.size ?? 0) > 0;
        if (isScoped && !hasReaders) {
          subscriptions.deleteScope(subsState, key);
          subscriptions.clearPulled(subsState, key);
        }
      }

      log.info("sync: unsubscribed from remote tables");
    }

    function yieldToEventLoop(): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    function registerScopeReader(
      tableName: string,
      scopeArgs: Record<string, unknown> | undefined,
      readKey: string,
    ): void {
      const normalizedScope = canonicalizeScopeArgs(scopeArgs);
      if (Object.keys(normalizedScope).length === 0) {
        return;
      }
      const key = buildScopeKey(tableName, normalizedScope);
      subscriptions.clearTeardownTimer(subsState, key);
      subscriptions.set(subsState, key, {
        tableName,
        scopeArgs: normalizedScope,
      });
      subscriptions.addReader(subsState, key, readKey);
    }

    function teardownScope(key: string): void {
      subscriptions.clearTeardownTimer(subsState, key);
      const entry = subscriptions.get(subsState, key);
      if (!entry) {
        return;
      }
      if ((entry.readers?.size ?? 0) > 0) {
        return;
      }
      try {
        entry.unsubscribe?.();
      } catch (err) {
        log.warn("sync: error during scope teardown unsubscribe", err);
      }
      entry.unsubscribe = undefined;
      entry.pendingActivation = undefined;
      subscriptions.deleteScope(subsState, key);
      subscriptions.clearPulled(subsState, key);
      log.debug(`sync: deactivated idle scope ${key}`);
    }

    function releaseScopeRead(
      tableName: string,
      scopeArgs: Record<string, unknown> | undefined,
      readKey: string,
    ): void {
      const normalizedScope = canonicalizeScopeArgs(scopeArgs);
      if (Object.keys(normalizedScope).length === 0) {
        return;
      }
      const key = buildScopeKey(tableName, normalizedScope);
      const remaining = subscriptions.removeReader(subsState, key, readKey);
      if (remaining === null || remaining > 0) {
        return;
      }
      subscriptions.setTeardownTimer(
        subsState,
        key,
        setTimeout(() => teardownScope(key), SCOPE_TEARDOWN_DEBOUNCE_MS),
      );
    }

    async function activateScope(
      tableName: string,
      scopeArgs?: Record<string, unknown>,
    ): Promise<void> {
      if (!(tableName in tables)) {
        return;
      }

      const normalizedScope = canonicalizeScopeArgs(scopeArgs);
      const key = buildScopeKey(tableName, normalizedScope);
      const existing = subscriptions.get(subsState, key);
      if (existing?.unsubscribe) {
        return;
      }
      if (existing?.pendingActivation) {
        await existing.pendingActivation;
        return;
      }
      const entry: ScopeRecord = subscriptions.set(subsState, key, {
        tableName,
        scopeArgs: normalizedScope,
      });
      if (
        !scheduler.isOnline(schedulerState) ||
        !started ||
        !pendingQueue.isEmpty
      ) {
        return;
      }

      const tableConfig = tables[tableName];
      if (!tableConfig) {
        return;
      }

      const epochAtStart = subscriptions.getEpoch(subsState);

      const activation = (async () => {
        if (!pull.hasPulledScopeSeq(pullState, key)) {
          await getTableSpec(
            tableName,
            tableConfig,
            scheduler.currentSignal(schedulerState),
            normalizedScope,
          );
        }
        subscriptions.markPulled(subsState, key);
        await yieldToEventLoop();

        if (subscriptions.getEpoch(subsState) !== epochAtStart || !started) {
          return;
        }

        registerRemoteSubscription({
          getPendingEntries: () => pendingQueue.entries(),
          getAliases: (id) => idMap.getAliases(id),
          bufferRemoteSnapshot,
          translateRemoteSnapshotToLocal: (docs) => docs,
          onUnsubscribe: (unsub) => {
            entry.unsubscribe = unsub;
          },
          pullServices,
          tableConfig,
          tableName,
          scopeArgs: normalizedScope,
          consumeExpectedSelfCausedSignal: (table, signalSeq) =>
            pull.consumeExpectedSelfCausedSignal(pullState, table, signalSeq),
          scheduleTableCoalesce: (input) =>
            pull.scheduleTableCoalesce(pullState, input),
          shouldSkipRedundantPartialPull: (table, scopeArgs, signalSeq) =>
            pull.shouldSkipRedundantPartialPull(
              pullState,
              { buildScopeKey },
              table,
              scopeArgs,
              signalSeq,
            ),
          onPartialResponse: () => {
            runDetached(
              () =>
                getTableSpec(
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
      await (localClient as unknown as LocalPathCallable).mutation(path, args);
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
      return (await (localClient as unknown as LocalPathCallable).query(
        path,
        args,
      )) as T;
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

    const pullDeps: PullDeps = {
      tables,
      tableSchemas,
      orderedTables,
      getRemoteApplyOrder,
      activeScopes: subsState.scopes,
      buildScopeKey,
      canonicalizeScopeArgs,
      ingestDocuments,
      getDocumentsForTable,
      getDocumentsForScope,
      idMap,
      embedded,
      remoteClient,
      pendingQueue,
      maxRetries,
      retryDelayMs,
      emit,
      yieldToEventLoop,
      runLocalSystemQuery,
      runLocalSystemMutation,
      getCurrentIdentityKey,
    };

    const schedulerDeps: SchedulerDeps = {
      processUploadQueue,
      processQueue,
      rollbackDeadLetteredTables,
      mergeDirtyCrdtRows,
      pullAll,
      stopRemoteSubscriptions,
      startRemoteSubscriptions,
      clearBufferedSnapshots,
      emit,
      pendingQueue,
      mergeState,
      isStarted: () => started,
      heartbeatMs: processorHeartbeatMs,
      heartbeat: heartbeatProcessor,
    };

    function handleOnline(): void {
      scheduler.handleOnline(schedulerState, schedulerDeps);
    }

    function handleOffline(): void {
      scheduler.handleOffline(schedulerState, schedulerDeps);
    }

    function startProcessorHeartbeat(): void {
      scheduler.startHeartbeat(schedulerState, schedulerDeps);
    }

    function stopProcessorHeartbeat(): void {
      scheduler.stopHeartbeat(schedulerState);
      runDetached(
        () =>
          runLocalSystemMutation(SystemPaths.processorRemove, {
            processorId: processorIdForReplay,
            identityKey: getCurrentIdentityKey(),
          }),
        "[sync] processor cleanup:",
      );
    }

    this._idMap = idMap;
    this._pendingQueue = pendingQueue;
    this._pendingUploadQueue = pendingUploadQueue;
    this._schedulerState = schedulerState;
    this._mergeState = mergeState;
    this._pullState = pullState;
    this._subsState = subsState;
    this._replayLoop = replayLoop;

    this.start = () => {
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

      const startRoute = scheduler.getStartLifecycleRoute({
        hasNavigator: true,
        navigatorOnline: connectivity?.isOnline(),
      });

      matchTag(startRoute, "_tag", {
        Offline: () => {
          scheduler.markOffline(schedulerState);
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
    };

    this.stop = () => {
      if (!started) return;
      started = false;

      log.info("sync: stopped");
      stopProcessorHeartbeat();
      unregisterPendingDepth();
      unregisterPendingUploadsDepth();

      scheduler.abortCurrent(schedulerState);
      const claimedEntry = replayLoop.activeEntry();
      if (claimedEntry) {
        replayLoop.setActiveEntry(null);
        runDetached(
          () => pendingQueue.release(claimedEntry, processorIdForReplay),
          "[sync] release pending claim:",
        );
      }

      stopRemoteSubscriptions();
      clearBufferedSnapshots();
      subscriptions.resetPulled(subsState);

      cleanupOnlineListener?.();
      cleanupOfflineListener?.();
      cleanupOnlineListener = null;
      cleanupOfflineListener = null;
      onOnline = null;
      onOffline = null;

      emit({ status: "idle" });
      statusEmitter.clearListeners();
    };

    this.mutation = async (
      ref: unknown,
      args: Record<string, unknown>,
      options?: { enqueueForReplay?: boolean },
    ): Promise<unknown> => {
      const enqueueForReplay = options?.enqueueForReplay ?? true;
      const executeMutationLocally = executeLocalMutationWithEffects
        ? executeLocalMutationWithEffects
        : (r: unknown, a: Record<string, unknown>) =>
            (localClient as unknown as LocalPathCallable).mutation(
              r,
              a,
            ) as Promise<unknown>;

      const refName = getFunctionName(
        ref as Parameters<typeof getFunctionName>[0],
      );
      const localArgs = idMap.translateRemoteIdsToLocal(args);

      const __mutStart = globalThis.performance?.now?.() ?? Date.now();
      let localResult: unknown = undefined;
      let localFailed = false;
      try {
        localResult = await executeMutationLocally(ref, localArgs);
      } catch (err) {
        if (!scheduler.isOnline(schedulerState)) {
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
        const remoteResult = await (
          remoteClient as unknown as RemoteCallable
        ).mutation(ref, args);
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
        if (
          !scheduler.isOnline(schedulerState) &&
          pull.shouldTrackCrdt(mergeState, table)
        ) {
          const docId =
            typeof localResult === "string"
              ? localResult
              : ((localArgs?.id as string | undefined) ??
                (localArgs?._id as string | undefined));
          if (docId) {
            pull.markDirty(mergeState, table, docId);
          }
        }
        if (scheduler.isOnline(schedulerState)) {
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
    };

    this.pullNow = (): Promise<void> => {
      if (scheduler.isOnline(schedulerState)) {
        stopRemoteSubscriptions();
      }
      return scheduler.run(schedulerState, schedulerDeps, { forcePull: true });
    };

    this.ensureTableReady = (tableName: string): Promise<void> => {
      return activateScope(tableName);
    };

    this.ensureScopeReady = (
      tableName: string,
      scopeArgs?: Record<string, unknown>,
      readKey?: string,
    ): Promise<void> => {
      if (readKey !== undefined) {
        registerScopeReader(tableName, scopeArgs, readKey);
      }
      return activateScope(tableName, scopeArgs);
    };

    this.releaseScopeRead = (
      tableName: string,
      scopeArgs: Record<string, unknown> | undefined,
      readKey: string,
    ): void => {
      releaseScopeRead(tableName, scopeArgs, readKey);
    };

    this.onScopeResolved = (
      tableName: string,
      scopeArgs: Record<string, unknown> | undefined,
      cb: () => void,
    ): (() => void) => {
      return subscriptions.onPulled(
        subsState,
        subsDeps,
        tableName,
        scopeArgs,
        cb,
      );
    };

    this.reloadIdentity = async (): Promise<void> => {
      await hydrateIdentityState();
      clearBufferedSnapshots();
      subscriptions.resetPulled(subsState);
      await pendingQueue.unblockAll();

      if (!started) {
        return;
      }

      if (scheduler.isOnline(schedulerState)) {
        stopRemoteSubscriptions();
        await scheduler.run(schedulerState, schedulerDeps, { forcePull: true });
        return;
      }

      emit({ status: "offline" });
    };
  } // end constructor

  on(_event: "change", listener: ChangeListener): () => void {
    return this._statusEmitter.on(listener);
  }

  getStatus(): EngineStatus {
    return this._statusEmitter.get();
  }

  pendingCount(): number {
    return this._pendingQueue.length;
  }

  get idMap(): IdMap {
    return this._idMap;
  }

  get pendingQueue(): PendingQueue {
    return this._pendingQueue;
  }

  [Symbol.asyncDispose](): Promise<void> {
    this.stop();
    return Promise.resolve();
  }
}

/**
 * Engine — owned-state class assembling the engine's subsystems
 * (statusEmitter, pullBatch, crdt, connectivity, snapshot, scope,
 * cycleScheduler, replayLoop) and exposing the public {@link EngineInstance}
 * interface.
 *
 * Currently still uses a closure-style constructor body (the former
 * `createEngine` factory body, inlined). Inner methods will incrementally
 * migrate onto the class as real methods so the constructor becomes a
 * thin wirer that hands work to subsystem methods.
 *
 * @internal
 */
export { EngineImpl as Engine };

/** @internal */
export const engine = {
  create: (config: EngineConfig): EngineInstance => new EngineImpl(config),
};
