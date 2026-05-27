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

import { createPull, type Pull, type PullRefs } from "@/client/engine/pull";
import * as replay from "@/client/engine/replay";
import { createReplay } from "@/client/engine/replay";
import type { Replay, ReplayRefs } from "@/client/engine/replay";
import {
  createScheduler,
  getStartLifecycleRoute,
  type Scheduler,
  type SchedulerRefs,
} from "@/client/engine/scheduler";
import {
  createSubscriptions,
  type ScopeRecord,
  type SubscriptionsSubsystem,
} from "@/client/engine/subscriptions";
import { IdMap, extractSchemaIdFields } from "@/client/ids";
import { PendingQueue } from "@/client/pending/queue";
import type { PendingEntry } from "@/client/pending/queue";
import { PendingUploadQueue } from "@/client/pending/uploads";
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
import { createLogger } from "@/shared/logger";
import { matchTag } from "@/shared/match";
import { getFunctionName } from "@/shared/refs";
import type { Definition } from "@/shared/schema";
import type { EngineStatus } from "@/shared/types";
import { recordCounter, registerGauge } from "@/tracing/metrics";
import { withSpan } from "@/tracing/spans";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

export type ChangeListener = (status: EngineStatus) => void;

interface EngineStatusEmitter {
  get(): EngineStatus;
  emit(next: EngineStatus): void;
  on(listener: ChangeListener): () => void;
  clearListeners(): void;
}

function createEngineStatusEmitter(): EngineStatusEmitter {
  let currentStatus: EngineStatus = { status: "idle" };
  const listeners = new Set<ChangeListener>();

  return {
    get: () => currentStatus,
    emit(next: EngineStatus): void {
      if (next.status === "resolved" && currentStatus.status !== "resolved") {
        recordCounter("sync.cycle");
      }
      currentStatus = next;
      for (const listener of listeners) {
        try {
          listener(next);
        } catch (err) {
          log.error("sync: listener threw", err);
        }
      }
    },
    on(listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearListeners(): void {
      listeners.clear();
    },
  };
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

export function createEngine(config: EngineConfig): EngineInstance {
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

  let replayInst!: Replay;
  const getRecentlyReplayedIdSet = () => replayInst.recentlyReplayedIdSet();
  const pullServices: EngineResolveInput = {
    remoteClient,
    ingestDocuments,
    getDocumentsForTable,
  };
  const executeLocal = embedded.executeLocal?.bind(embedded);
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

  const statusEmitter = createEngineStatusEmitter();
  let started = false;
  // schedulerInst is assigned later in the constructor body (after its
  // refs are defined). Earlier closures capture the binding and read it
  // at call time, after assignment.
  let schedulerInst!: Scheduler;
  let pullInst!: Pull;

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

  let onOnline: (() => void) | null = null;
  let onOffline: (() => void) | null = null;
  let cleanupOnlineListener: (() => void) | null = null;
  let cleanupOfflineListener: (() => void) | null = null;
  const SCOPE_TEARDOWN_DEBOUNCE_MS = config.scopeTeardownDebounceMs ?? 3000;

  const subs: SubscriptionsSubsystem = createSubscriptions({
    orderedTables,
    canonicalizeScopeArgs,
    buildScopeKey,
    projectRemoteSnapshot: replay.projectRemoteSnapshot,
    getDocumentsForTable,
    filterAfterHydratingReferences: (input) =>
      pullInst.filterAfterHydratingReferences(input),
    ingestDocuments,
    runSpan,
    yieldToEventLoop,
    getRecentlyReplayedIdSet: () => getRecentlyReplayedIdSet(),
    getPendingEntries: () => pendingQueue.entries(),
    getAliases: (id) => idMap.getAliases(id),
    clearPullSequencing: () => pullInst.clearAll(),
  });

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
    subs.bufferRemoteSnapshot(tableName, docs, scopeArgs);
  };
  const clearBufferedSnapshots = () => subs.clearAll();

  function emit(newStatus: EngineStatus): void {
    statusEmitter.emit(newStatus);
  }

  /**
   * Drain the pending uploads queue. Runs before mutation replay so that
   * any local storage IDs queued mutations reference are already mapped to
   * remote IDs by the time those mutations process.
   */

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

  async function getTableSpec(
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
    scopeArgs?: Record<string, unknown>,
  ): Promise<void> {
    return pullInst.getTableSpec(tableName, tableConfig, signal, scopeArgs);
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
    const orderedScopes = Array.from(subs.scopes().entries()).sort(
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
          pullInst.consumeExpectedSelfCausedSignal(table, signalSeq),
        scheduleTableCoalesce: (input) =>
          pullInst.scheduleTableCoalesce(input),
        shouldSkipRedundantPartialPull: (table, scopeArgs, signalSeq) =>
          pullInst.shouldSkipRedundantPartialPull(
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
      if (!pullInst.hasPulledScopeSeq(key)) {
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
    subs.clearAllTeardownTimers();

    if (!subs.hasActive()) return;

    subs.bumpEpoch();

    for (const [key, entry] of subs.scopes()) {
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
        subs.deleteScope(key);
        subs.clearPulled(key);
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
    subs.clearTeardownTimer(key);
    subs.set(key, {
      tableName,
      scopeArgs: normalizedScope,
    });
    subs.addReader(key, readKey);
  }

  function teardownScope(key: string): void {
    subs.clearTeardownTimer(key);
    const entry = subs.get(key);
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
    subs.deleteScope(key);
    subs.clearPulled(key);
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
    const remaining = subs.removeReader(key, readKey);
    if (remaining === null || remaining > 0) {
      return;
    }
    subs.setTeardownTimer(
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
    const existing = subs.get(key);
    if (existing?.unsubscribe) {
      return;
    }
    if (existing?.pendingActivation) {
      await existing.pendingActivation;
      return;
    }
    const entry: ScopeRecord = subs.set(key, {
      tableName,
      scopeArgs: normalizedScope,
    });
    if (
      !schedulerInst.isOnline() ||
      !started ||
      !pendingQueue.isEmpty
    ) {
      return;
    }

    const tableConfig = tables[tableName];
    if (!tableConfig) {
      return;
    }

    const epochAtStart = subs.getEpoch();

    const activation = (async () => {
      if (!pullInst.hasPulledScopeSeq(key)) {
        await getTableSpec(
          tableName,
          tableConfig,
          schedulerInst.currentSignal(),
          normalizedScope,
        );
      }
      subs.markPulled(key);
      await yieldToEventLoop();

      if (subs.getEpoch() !== epochAtStart || !started) {
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
          pullInst.consumeExpectedSelfCausedSignal(table, signalSeq),
        scheduleTableCoalesce: (input) =>
          pullInst.scheduleTableCoalesce(input),
        shouldSkipRedundantPartialPull: (table, scopeArgs, signalSeq) =>
          pullInst.shouldSkipRedundantPartialPull(
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

  async function heartbeatProcessor(): Promise<void> {
    await runLocalSystemMutation(SystemPaths.processorHeartbeat, {
      processorId: processorIdForReplay,
      identityKey: getCurrentIdentityKey(),
    });
  }

  const pullRefs: PullRefs = {
    tables,
    orderedTables,
    getRemoteApplyOrder,
    activeScopes: () => subs.scopes(),
    buildScopeKey,
    ingestDocuments,
    getDocumentsForTable,
    getDocumentsForScope,
    idMap,
    embedded,
    remoteClient,
    maxRetries,
    retryDelayMs,
    emit,
    yieldToEventLoop,
    runLocalSystemQuery,
    runLocalSystemMutation,
    getCurrentIdentityKey,
  };
  pullInst = createPull(pullRefs);

  const replayRefs: ReplayRefs = {
    pendingQueue,
    pendingUploadQueue,
    embedded,
    idMap,
    remoteClient,
    tables,
    tableSchemas,
    processorId: processorIdForReplay,
    leaseMs,
    uploadUrlRef,
    uploadFetch,
    recordExpectedSelfCausedSignal: (table, postCommitSeq) =>
      pullInst.recordExpectedSelfCausedSignal(table, postCommitSeq),
    nextExpectedSelfCausedSeq: (table) =>
      pullInst.nextExpectedSelfCausedSeq(table),
    softResetSubsBuffers: () => subs.softResetBuffers(),
    hasActiveSubs: () => subs.hasActive(),
    isOnline: () => schedulerInst.isOnline(),
    isStarted: () => started,
    runScheduler: () => schedulerInst.run(),
    stopRemoteSubscriptions,
    pullTable: (tableName, tableConfig, signal) =>
      getTableSpec(tableName, tableConfig, signal),
  };
  replayInst = createReplay(replayRefs);

  const schedulerRefs: SchedulerRefs = {
    processUploadQueue: (signal) => replayInst.processUploadQueue(signal),
    processQueue: (signal) => replayInst.processQueue(signal),
    rollbackDeadLetteredTables: (deadLettered, signal) =>
      replayInst.rollbackDeadLetteredTables(deadLettered, signal),
    mergeDirtyCrdtRows: (signal) => pullInst.runMerge(signal),
    pullAll: (signal) => pullInst.pullAll(signal),
    stopRemoteSubscriptions,
    startRemoteSubscriptions,
    clearBufferedSnapshots,
    emit,
    pendingQueue,
    hasDirtyCrdtRows: () => pullInst.hasDirty(),
    clearDirtyCrdtRows: () => pullInst.clearAllDirty(),
    isStarted: () => started,
    heartbeatMs: processorHeartbeatMs,
    heartbeat: heartbeatProcessor,
  };

  schedulerInst = createScheduler(schedulerRefs);

  const handleOnline = (): void => schedulerInst.handleOnline();
  const handleOffline = (): void => schedulerInst.handleOffline();
  const startProcessorHeartbeat = (): void => schedulerInst.startHeartbeat();

  function stopProcessorHeartbeat(): void {
    schedulerInst.stopHeartbeat();
    runDetached(
      () =>
        runLocalSystemMutation(SystemPaths.processorRemove, {
          processorId: processorIdForReplay,
          identityKey: getCurrentIdentityKey(),
        }),
      "[sync] processor cleanup:",
    );
  }

  const start = (): void => {
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
        schedulerInst.markOffline();
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

  const stop = (): void => {
    if (!started) return;
    started = false;

    log.info("sync: stopped");
    stopProcessorHeartbeat();
    unregisterPendingDepth();
    unregisterPendingUploadsDepth();

    schedulerInst.abortCurrent();
    const claimedEntry = replayInst.activeEntry();
    if (claimedEntry) {
      replayInst.setActiveEntry(null);
      runDetached(
        () => pendingQueue.release(claimedEntry, processorIdForReplay),
        "[sync] release pending claim:",
      );
    }

    stopRemoteSubscriptions();
    clearBufferedSnapshots();
    subs.resetPulled();

    cleanupOnlineListener?.();
    cleanupOfflineListener?.();
    cleanupOnlineListener = null;
    cleanupOfflineListener = null;
    onOnline = null;
    onOffline = null;

    emit({ status: "idle" });
    statusEmitter.clearListeners();
  };

  const mutation = async (
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
      if (!schedulerInst.isOnline()) {
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
        !schedulerInst.isOnline() &&
        pullInst.shouldTrackCrdt(table)
      ) {
        const docId =
          typeof localResult === "string"
            ? localResult
            : ((localArgs?.id as string | undefined) ??
              (localArgs?._id as string | undefined));
        if (docId) {
          pullInst.markDirty(table, docId);
        }
      }
      if (schedulerInst.isOnline()) {
        replayInst.ensureProcessing();
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

  const pullNow = (): Promise<void> => {
    if (schedulerInst.isOnline()) {
      stopRemoteSubscriptions();
    }
    return schedulerInst.run({ forcePull: true });
  };

  const ensureTableReady = (tableName: string): Promise<void> => {
    return activateScope(tableName);
  };

  const ensureScopeReady = (
    tableName: string,
    scopeArgs?: Record<string, unknown>,
    readKey?: string,
  ): Promise<void> => {
    if (readKey !== undefined) {
      registerScopeReader(tableName, scopeArgs, readKey);
    }
    return activateScope(tableName, scopeArgs);
  };

  const releaseScopeReadFn = (
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    readKey: string,
  ): void => {
    releaseScopeRead(tableName, scopeArgs, readKey);
  };

  const onScopeResolved = (
    tableName: string,
    scopeArgs: Record<string, unknown> | undefined,
    cb: () => void,
  ): (() => void) => {
    return subs.onPulled(tableName, scopeArgs, cb);
  };

  const reloadIdentity = async (): Promise<void> => {
    await hydrateIdentityState();
    clearBufferedSnapshots();
    subs.resetPulled();
    await pendingQueue.unblockAll();

    if (!started) {
      return;
    }

    if (schedulerInst.isOnline()) {
      stopRemoteSubscriptions();
      await schedulerInst.run({ forcePull: true });
      return;
    }

    emit({ status: "offline" });
  };

  return {
    start,
    stop,
    mutation,
    pullNow,
    ensureTableReady,
    ensureScopeReady,
    releaseScopeRead: releaseScopeReadFn,
    onScopeResolved,
    reloadIdentity,
    on: (_event, listener) => statusEmitter.on(listener),
    getStatus: () => statusEmitter.get(),
    pendingCount: () => pendingQueue.length,
    get idMap() {
      return idMap;
    },
    get pendingQueue() {
      return pendingQueue;
    },
    async [Symbol.asyncDispose]() {
      stop();
    },
  };
}

/** @internal */
export const engine = {
  create: createEngine,
};
