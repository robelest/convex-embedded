/**
 * @internal
 *
 * Engine — internal resolve orchestrator between local embedded
 * runtime and remote Convex backend.
 *
 * This module is NOT part of the public API. Use `createConvexClient()`
 * from `@robelest/convex-embedded/browser` instead.
 */

import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";
import * as Y from "yjs";

import { IdMap } from "@/client/ids";
import { PendingQueue } from "@/client/pending";
import type { PendingEntry } from "@/client/pending";
import { materializeYjsDoc } from "@/client/schema";
import type { LocalExecutionRequest } from "@/runtime/embedded";
import type { ConnectivityAdapter } from "@/runtime/platform";
import { getFunctionName, makeFunctionReference } from "@/shared/function-refs";
import { createLogger } from "@/shared/logger";
import { initYjsDoc } from "@/shared/schema";
import type { Definition } from "@/shared/schema";
import type { EngineStatus, ResolveProgress } from "@/shared/types";

const log = createLogger("resolve");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function rewriteKnownIdsResult(
  value: unknown,
  field: unknown,
  localId: string,
  remoteId: string,
): { value: unknown; changed: boolean } {
  const validator = unwrapSchemaField(field) as
    | {
        kind?: string;
        element?: unknown;
        fields?: Record<string, unknown>;
        members?: unknown[];
        value?: unknown;
      }
    | undefined;

  if (!validator || value === null || typeof value === "undefined") {
    return { value, changed: false };
  }

  switch (validator.kind) {
    case "id":
      return value === localId
        ? { value: remoteId, changed: true }
        : { value, changed: false };
    case "array": {
      if (!Array.isArray(value)) {
        return { value, changed: false };
      }
      let changed = false;
      const next = value.map((entry) => {
        const rewritten = rewriteKnownIdsResult(
          entry,
          validator.element,
          localId,
          remoteId,
        );
        changed = changed || rewritten.changed;
        return rewritten.value;
      });
      return { value: changed ? next : value, changed };
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { value, changed: false };
      }
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => {
          const rewritten = rewriteKnownIdsResult(
            entryValue,
            validator.fields?.[key],
            localId,
            remoteId,
          );
          changed = changed || rewritten.changed;
          return [key, rewritten.value];
        }),
      );
      return { value: changed ? next : value, changed };
    }
    case "union": {
      for (const member of validator.members ?? []) {
        const rewritten = rewriteKnownIdsResult(
          value,
          member,
          localId,
          remoteId,
        );
        if (rewritten.changed) {
          return rewritten;
        }
      }
      return { value, changed: false };
    }
    case "record": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { value, changed: false };
      }
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(value).map(([key, entryValue]) => {
          const rewritten = rewriteKnownIdsResult(
            entryValue,
            validator.value,
            localId,
            remoteId,
          );
          changed = changed || rewritten.changed;
          return [key, rewritten.value];
        }),
      );
      return { value: changed ? next : value, changed };
    }
    default:
      return { value, changed: false };
  }
}

function rewriteKnownIds(
  value: unknown,
  field: unknown,
  localId: string,
  remoteId: string,
): unknown {
  return rewriteKnownIdsResult(value, field, localId, remoteId).value;
}

function rewriteDocumentToCanonical(input: {
  doc: Record<string, unknown>;
  schema: Definition;
  localId: string;
  remoteId: string;
  rewriteOwnId: boolean;
}): Record<string, unknown> {
  const next: Record<string, unknown> = { ...input.doc };
  for (const [fieldName, field] of Object.entries(input.schema.getShape())) {
    next[fieldName] = rewriteKnownIds(
      next[fieldName],
      field,
      input.localId,
      input.remoteId,
    );
  }
  if (input.rewriteOwnId && next._id === input.localId) {
    next._id = input.remoteId;
  }
  return next;
}

function createRemoteUpdateHandler(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  getDocumentsForTable: (
    table: string,
  ) => Promise<Array<Record<string, unknown>>>;
  getPendingEntries: () => readonly PendingEntry[];
  getAliases: (id: string) => Set<string>;
  bufferRemoteSnapshot: (
    table: string,
    docs: Array<Record<string, unknown>>,
  ) => Promise<void>;
  translateRemoteSnapshotToLocal: (
    docs: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>;
  schema: Definition;
  tableName: string;
}) {
  return (remoteDocs: Array<Record<string, unknown>>) => {
    const cleaned = input.translateRemoteSnapshotToLocal(
      stripOmittedFields(input.schema, remoteDocs),
    );
    Fx.detach(
      () =>
        Fx.run(
          Fx.from({
            ok: async () => {
              const hasPendingForTable = input
                .getPendingEntries()
                .some((entry) => entry.table === input.tableName);

              if (!hasPendingForTable) {
                try {
                  await input.ingestDocuments(input.tableName, cleaned);
                } catch {
                  await input.bufferRemoteSnapshot(input.tableName, cleaned);
                }
                return;
              }

              await input.bufferRemoteSnapshot(input.tableName, cleaned);
            },
            err: (e) => e as Error,
          }).pipe(
            Fx.inspect((err) =>
              Fx.sync(() => {
                log.error(
                  `sync: failed to ingest remote data for "${input.tableName}"`,
                  err,
                );
              }),
            ),
            Fx.recover(() => Fx.unit),
          ),
        ),
      `[sync] ingest ${input.tableName}:`,
    );
  };
}

function createRemoteSubscriptionErrorHandler(tableName: string) {
  return (err: Error) => {
    log.error(`sync: remote subscription error for "${tableName}"`, err);
  };
}

type TableRemoteSyncState = {
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
    const args = JSON.parse(entry.args) as { id?: unknown };
    if (typeof args.id === "string") {
      return args.id;
    }

    const localResult = JSON.parse(entry.localResult) as unknown;
    return typeof localResult === "string" ? localResult : null;
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
  } catch {
    // Ignore non-JSON errors and fall back to string matching below.
  }
  return { message: fallback.toLowerCase() };
}

function projectRemoteSnapshot(input: {
  localDocs: Array<Record<string, unknown>>;
  remoteDocs: Array<Record<string, unknown>>;
  pendingEntries: readonly PendingEntry[];
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
  if (code === "UNAUTHENTICATED") {
    return "reauthRequired";
  }
  if (code === "FORBIDDEN") {
    return "authorizationDenied";
  }
  if (
    message.includes("auth") ||
    message.includes("token") ||
    message.includes("unauth")
  ) {
    return "reauthRequired";
  }
  if (
    message.includes("forbidden") ||
    message.includes("not authorized") ||
    message.includes("permission") ||
    message.includes("denied")
  ) {
    return "authorizationDenied";
  }
  if (message.includes("scope")) {
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
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  getDocumentsForTable: (
    table: string,
  ) => Promise<Array<Record<string, unknown>>>;
  getPendingEntries: () => readonly PendingEntry[];
  getAliases: (id: string) => Set<string>;
  bufferRemoteSnapshot: (
    table: string,
    docs: Array<Record<string, unknown>>,
  ) => Promise<void>;
  translateRemoteSnapshotToLocal: (
    docs: Array<Record<string, unknown>>,
  ) => Array<Record<string, unknown>>;
  onUnsubscribe: (unsub: () => void) => void;
  remoteClient: ConvexClient;
  tableConfig: TableConfig;
  tableName: string;
}) {
  const unsub = (input.remoteClient as any).onUpdate(
    input.tableConfig.query,
    input.tableConfig.resolveArgs?.() ?? {},
    createRemoteUpdateHandler({
      ingestDocuments: input.ingestDocuments,
      getDocumentsForTable: input.getDocumentsForTable,
      getPendingEntries: input.getPendingEntries,
      getAliases: input.getAliases,
      bufferRemoteSnapshot: input.bufferRemoteSnapshot,
      translateRemoteSnapshotToLocal: input.translateRemoteSnapshotToLocal,
      schema: input.tableConfig.schema,
      tableName: input.tableName,
    }),
    createRemoteSubscriptionErrorHandler(input.tableName),
  );

  input.onUnsubscribe(unsub);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  /** The resolve query reference (from register() output). */
  resolve: unknown;

  /**
   * The remote query reference to subscribe to while online.
   *
   * This should be the same query the app uses locally (e.g.
   * `api.tasks.list`). The remote `ConvexClient` subscribes to it
   * reactively and pipes every update into the embedded runtime.
   */
  query: unknown;

  /** Optional args factory for the remote resolve-scoped subscription query. */
  resolveArgs?: () => Record<string, unknown>;

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
  ): Promise<void>;

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

  /** Optional platform connectivity adapter. */
  connectivity?: ConnectivityAdapter;

  /** Stable processor id used for replay ownership claims. */
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
  yjsDoc: Y.Doc;
};

type ResolveDocument = {
  docId: string;
  vector: ArrayBuffer;
};

type ResolveArgs = {
  documents: Array<ResolveDocument>;
  scopeArgs?: Record<string, unknown>;
};

type ResolveResultRow = {
  docId: string;
  diff?: ArrayBuffer;
  document?: Record<string, unknown>;
};

type PreparedResolveInput = {
  localYjsMap: Map<string, LocalYjsEntry>;
  resolveDocuments: Array<ResolveDocument>;
  schemaDef: Definition;
};

type MergeResolveOutput = {
  diffCount: number;
  mergedDocs: Array<Record<string, unknown>>;
};

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
  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown>;

  /** Manually trigger a resolve cycle (e.g., after coming back online). */
  resolveNow(): Promise<void>;

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

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * State transitions:
 *   [*] → Offline (no network)
 *   [*] → Resolving (network available)
 *   Offline → Resolving (online event)
 *   Resolving → Resolved (all resolve() calls succeed)
 *   Resolving → Error (resolve() fails after retries)
 *   Resolved → Offline (offline event)
 *   Resolved → Resolving (reconnect after temporary disconnect)
 *   Error → Resolving (retry / online event)
 *   Offline → Offline (mutations queue locally)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
): string {
  const name = getFunctionName(ref as any);

  // Extract module name (before the colon) and check if it's a known table.
  const moduleName = name.split(":")[0] ?? "";
  if (moduleName in tables) {
    return moduleName;
  }

  // Fallback: return first registered table (common case: single table app)
  const tableNames = Object.keys(tables);
  return tableNames[0] ?? "";
}

function matchTag<
  T extends Record<K, string>,
  K extends keyof T & string,
  Handlers extends {
    [V in T[K] & string]: (value: Extract<T, Record<K, V>>) => unknown;
  },
>(value: T, key: K, handlers: Handlers): ReturnType<Handlers[T[K] & string]> {
  const handler = handlers[value[key] as T[K] & string] as unknown as (
    current: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}

function getSyncCycleRoute(input: {
  aborted: boolean;
  forceResolve: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
}): SyncCycleRoute {
  if (input.aborted) return { _tag: "Skip" };
  if (!input.forceResolve && (!input.started || !input.isOnline)) {
    return { _tag: "Skip" };
  }
  if (input.hasPending) {
    return { _tag: "DeferUntilQueueDrains" };
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

function getConnectivityAdapter(
  connectivity?: ConnectivityAdapter,
): ConnectivityAdapter {
  if (connectivity) {
    return connectivity;
  }

  return {
    isOnline() {
      const hasNavigator =
        typeof globalThis !== "undefined" && "navigator" in globalThis;
      const nav = hasNavigator
        ? (globalThis as { navigator?: { onLine?: boolean } }).navigator
        : undefined;
      return nav?.onLine !== false;
    },
    onOnline(callback) {
      if (typeof globalThis.addEventListener !== "function") {
        return () => {};
      }
      globalThis.addEventListener("online", callback);
      return () => globalThis.removeEventListener("online", callback);
    },
    onOffline(callback) {
      if (typeof globalThis.addEventListener !== "function") {
        return () => {};
      }
      globalThis.addEventListener("offline", callback);
      return () => globalThis.removeEventListener("offline", callback);
    },
  };
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
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
}) {
  const uploadUrl = (await (input.remoteClient as any).mutation(
    input.uploadUrlRef,
    {},
  )) as string;

  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    throw new Error(
      "[convex-embedded] remote upload URL mutation did not return a URL string.",
    );
  }

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: input.contentType
      ? { "Content-Type": input.contentType }
      : undefined,
    body: input.blob,
  });

  const payload = (await response.json()) as {
    storageId?: unknown;
    error?: unknown;
  };

  if (!response.ok || typeof payload.storageId !== "string") {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `[convex-embedded] remote blob upload failed with status ${response.status}.`,
    );
  }

  return payload.storageId;
}

function prepareResolveInput(
  schemaDef: Definition,
  localDocs: Array<Record<string, unknown>>,
): PreparedResolveInput {
  return localDocs.reduce<PreparedResolveInput>(
    (acc, doc) => {
      const docId = doc._id as string | undefined;
      if (!docId) {
        return acc;
      }

      const yjsDoc = initYjsDoc(schemaDef, doc);
      acc.localYjsMap.set(docId, { localDoc: doc, yjsDoc });
      acc.resolveDocuments.push({
        docId,
        vector: toArrayBuffer(Y.encodeStateVector(yjsDoc)),
      });
      return acc;
    },
    {
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
  return Fx.retry.while(
    Fx.retry.compose(
      Fx.retry.jittered(Fx.retry.exponential(input.retryDelayMs)),
      Fx.retry.recurs(input.maxRetries - 1),
    ),
    (meta) => {
      if (input.signal?.aborted) return false;
      const err = meta.input as Error;
      return !(err instanceof DOMException && err.name === "AbortError");
    },
  );
}

function mergeResolveResult(input: {
  localYjsMap: Map<string, LocalYjsEntry>;
  resolveResult: Array<ResolveResultRow>;
  schemaDef: Definition;
  tableName: string;
  translateRemoteDocument: (
    document: Record<string, unknown>,
  ) => Record<string, unknown>;
}): MergeResolveOutput {
  return input.resolveResult.reduce<MergeResolveOutput>(
    (acc, { docId, diff, document }) => {
      const entry = input.localYjsMap.get(docId);
      if (!entry) {
        if (document) {
          acc.mergedDocs.push(input.translateRemoteDocument(document));
          return acc;
        }
        log.warn(
          `sync: resolve returned diff for unknown doc "${docId}" in "${input.tableName}"`,
        );
        return acc;
      }

      if (diff) {
        Y.applyUpdateV2(entry.yjsDoc, new Uint8Array(diff));
        acc.diffCount += 1;
      }

      const materialized = materializeYjsDoc(input.schemaDef, entry.yjsDoc);
      materialized._id = entry.localDoc._id;
      materialized._creationTime = entry.localDoc._creationTime;
      acc.mergedDocs.push(input.translateRemoteDocument(materialized));
      return acc;
    },
    { diffCount: 0, mergedDocs: [] },
  );
}

function ingestMergedDocsFx(input: {
  ingestDocuments: (
    table: string,
    documents: Array<Record<string, unknown>>,
  ) => Promise<void>;
  mergedDocs: Array<Record<string, unknown>>;
  tableName: string;
}) {
  return input.mergedDocs.length === 0
    ? Fx.unit
    : Fx.from({
        ok: () => input.ingestDocuments(input.tableName, input.mergedDocs),
        err: (e) => e as Error,
      });
}

function getQueueEntryRoute(input: {
  entry: PendingEntry | undefined;
  hasLocalId: (localId: string) => boolean;
  isOnline: boolean;
  signal?: AbortSignal;
}): QueueEntryRoute {
  if (input.entry === undefined || !input.isOnline || input.signal?.aborted) {
    return { _tag: "Stop" };
  }

  const localResult = JSON.parse(input.entry.localResult);
  return input.entry.ref.endsWith(":create") &&
    input.entry.hydrated === true &&
    typeof localResult === "string" &&
    input.hasLocalId(localResult)
    ? { _tag: "DropMappedCreate", localResult }
    : { _tag: "Push", localResult };
}

// ---------------------------------------------------------------------------
// engine.create()
// ---------------------------------------------------------------------------

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
  } = config;

  // Destructure the embedded client for convenience.
  const localClient = embedded.client;
  const ingestDocuments = embedded.ingestDocuments.bind(embedded);
  const getDocumentsForTable = embedded.getDocumentsForTable.bind(embedded);
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

  const tableNames = Object.keys(tables);

  let status: EngineStatus = { status: "idle" };
  const listeners = new Set<ChangeListener>();
  let started = false;
  let abortController: AbortController | null = null;

  // ID map and persistent pending queue.
  // When executeLocal is available, hydration and bookkeeping bypass the
  // patched ConvexClient methods entirely, preventing version/transition races.
  const idMap = new IdMap(
    localClient,
    executeLocalQuery,
    executeLocalMutationWithoutEffects,
    getIdentityKey,
    (id) => embedded.hasLocalDocumentId?.(id) ?? false,
  );
  const pendingQueue = new PendingQueue(
    localClient,
    executeLocalQuery,
    executeLocalMutationWithoutEffects,
    getIdentityKey,
  );
  const processorIdForReplay =
    processorId ?? `processor_${Math.random().toString(36).slice(2)}`;

  // Track whether we believe we're online (based on network events)
  let isOnline = false;

  // Serial queue processor state
  let queueProcessingPromise: Promise<void> | null = null;
  let queueProcessingRequestedWhileActive = false;
  let syncCyclePromise: Promise<void> | null = null;
  let activeEntry: PendingEntry | null = null;

  // Network event handlers
  let onOnline: (() => void) | null = null;
  let onOffline: (() => void) | null = null;
  let cleanupOnlineListener: (() => void) | null = null;
  let cleanupOfflineListener: (() => void) | null = null;

  // Active remote reactive subscriptions (unsubscribe functions)
  const remoteUnsubscribes: Array<() => void> = [];
  const tableRemoteSyncState = new Map<string, TableRemoteSyncState>();

  function getTableRemoteSyncState(tableName: string): TableRemoteSyncState {
    let state = tableRemoteSyncState.get(tableName);
    if (!state) {
      state = {
        bufferedSnapshot: null,
        flushScheduled: false,
        epoch: 0,
        retryTimer: null,
        retryCount: 0,
      };
      tableRemoteSyncState.set(tableName, state);
    }
    return state;
  }

  async function canonicalizeMappedCreate(input: {
    localId: string;
    remoteId: string;
    tableName: string;
  }): Promise<void> {
    const orderedTableNames = [
      input.tableName,
      ...tableNames.filter((candidate) => candidate !== input.tableName),
    ];

    for (const currentTableName of orderedTableNames) {
      const schema = tables[currentTableName]?.schema;
      if (!schema) {
        continue;
      }

      const currentDocs = await getDocumentsForTable(currentTableName);
      const rewrittenDocs = currentDocs.map((doc) =>
        rewriteDocumentToCanonical({
          doc,
          schema,
          localId: input.localId,
          remoteId: input.remoteId,
          rewriteOwnId: currentTableName === input.tableName,
        }),
      );

      const changed = rewrittenDocs.some(
        (doc, index) => doc !== currentDocs[index],
      );
      if (!changed) {
        continue;
      }

      await ingestDocuments(currentTableName, rewrittenDocs);
    }
  }

  function scheduleBufferedSnapshotFlush(tableName: string, delayMs = 0): void {
    const state = getTableRemoteSyncState(tableName);
    if (state.flushScheduled) {
      return;
    }

    state.flushScheduled = true;
    if (delayMs > 0) {
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
      }
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        void flushBufferedSnapshot(tableName);
      }, delayMs);
      return;
    }

    Fx.detach(
      () => flushBufferedSnapshot(tableName),
      `[sync] flush ${tableName}:`,
    );
  }

  async function flushBufferedSnapshot(tableName: string): Promise<void> {
    const state = getTableRemoteSyncState(tableName);
    if (state.bufferedSnapshot === null) {
      state.flushScheduled = false;
      return;
    }

    const snapshot = state.bufferedSnapshot;
    state.bufferedSnapshot = null;
    state.flushScheduled = false;

    const projected = projectRemoteSnapshot({
      localDocs: await getDocumentsForTable(tableName),
      remoteDocs: snapshot,
      pendingEntries: pendingQueue.entries(),
      tableName,
      getAliases: (id) => idMap.getAliases(id),
    });

    try {
      await ingestDocuments(tableName, projected);
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
      scheduleBufferedSnapshotFlush(tableName, delayMs);
      log.warn(
        `sync: delayed buffered snapshot ingest for "${tableName}" (retry ${state.retryCount}/${MAX_BUFFERED_SNAPSHOT_RETRIES})`,
        error,
      );
      return;
    }

    if (state.bufferedSnapshot !== null && !state.flushScheduled) {
      scheduleBufferedSnapshotFlush(tableName);
    }
  }

  async function bufferRemoteSnapshot(
    tableName: string,
    docs: Array<Record<string, unknown>>,
  ): Promise<void> {
    const state = getTableRemoteSyncState(tableName);
    state.bufferedSnapshot = docs;
    state.retryCount = 0;
    scheduleBufferedSnapshotFlush(tableName);
  }

  function clearBufferedSnapshots(): void {
    for (const state of tableRemoteSyncState.values()) {
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
      }
      state.retryCount = 0;
    }
    tableRemoteSyncState.clear();
  }

  function ensureReplayProcessing(): void {
    if (!isOnline || pendingQueue.isEmpty) {
      return;
    }

    Fx.detach(async () => {
      await processQueue();

      if (pendingQueue.isEmpty) {
        for (const tableName of tableNames) {
          void flushBufferedSnapshot(tableName);
        }
        if (remoteUnsubscribes.length === 0 && started) {
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
          }),
        );
      } finally {
        heartbeat.stop();
      }
      await idMap.set(dependency.localStorageId, remoteStorageId, "_storage");
    }
  }

  // -------------------------------------------------------------------------
  // Serial queue processor — processes pending mutations one at a time
  // -------------------------------------------------------------------------

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
  async function processQueue(signal?: AbortSignal): Promise<void> {
    if (queueProcessingPromise) {
      queueProcessingRequestedWhileActive = true;
      return queueProcessingPromise;
    }
    if (pendingQueue.isEmpty) {
      await pendingQueue.hydrate();
    }
    if (pendingQueue.isEmpty) return;

    log.info(`sync: processing ${pendingQueue.length} queued mutation(s)`);

    queueProcessingPromise = Fx.run(
      Fx.bracket(
        // Acquire: no-op, queueProcessingPromise is the active guard
        Fx.unit,
        // Use: process entries
        () =>
          Fx.gen(function* () {
            while (isOnline && !signal?.aborted) {
              queueProcessingRequestedWhileActive = false;

              while (!pendingQueue.isEmpty && isOnline && !signal?.aborted) {
                const entry = yield* Fx.from({
                  ok: () =>
                    pendingQueue.claimNext(processorIdForReplay, leaseMs),
                  err: (e) => e as Error,
                });
                if (!entry) {
                  break;
                }
                activeEntry = entry;
                if (entry?.state === "blocked") {
                  log.warn(
                    `sync: blocked pending entry for ${entry.ref}; halting replay`,
                  );
                  break;
                }
                const route = getQueueEntryRoute({
                  entry,
                  hasLocalId: (localId) => idMap.hasLocalId(localId),
                  isOnline,
                  signal,
                });

                const shouldContinue = yield* matchTag(route, "_tag", {
                  Stop: () => Fx.succeed(false),
                  DropMappedCreate: () =>
                    Fx.from({
                      ok: () =>
                        pendingQueue.remove(entry, processorIdForReplay),
                      err: (e) => e as Error,
                    }).pipe(
                      Fx.tap(() =>
                        Fx.sync(() => {
                          log.debug(
                            `sync: dropping already-mapped create mutation (remaining: ${pendingQueue.length})`,
                          );
                        }),
                      ),
                      Fx.map(() => true),
                    ),
                  Push: (current) =>
                    Fx.from({
                      ok: async () => {
                        const ref = makeFunctionReference<"mutation">(
                          entry!.ref,
                        );
                        const originalArgs = JSON.parse(entry!.args) as Record<
                          string,
                          unknown
                        >;
                        await ensureRemoteStorageMappings(entry, originalArgs);
                        const translatedArgs =
                          idMap.translateArgs(originalArgs);
                        const leaseHeld = await pendingQueue.renewLease(
                          entry,
                          processorIdForReplay,
                          leaseMs,
                        );
                        if (!leaseHeld) {
                          if (entry.hydrated === true) {
                            activeEntry = null;
                            log.warn(
                              `sync: lost replay lease before remote push (table: ${entry!.table})`,
                            );
                            return false;
                          }
                          log.warn(
                            `sync: continuing replay for current-session entry after lease renewal miss (table: ${entry!.table})`,
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
                            (remoteClient as any).mutation(ref, translatedArgs),
                          );
                        } finally {
                          heartbeat.stop();
                        }

                        if (
                          typeof current.localResult === "string" &&
                          typeof remoteResult === "string" &&
                          current.localResult !== remoteResult
                        ) {
                          await idMap.set(
                            current.localResult,
                            remoteResult,
                            entry!.table,
                          );
                          await pendingQueue.remove(
                            entry,
                            processorIdForReplay,
                          );
                          activeEntry = null;
                          await canonicalizeMappedCreate({
                            localId: current.localResult,
                            remoteId: remoteResult,
                            tableName: entry!.table,
                          });
                        } else {
                          await pendingQueue.remove(
                            entry,
                            processorIdForReplay,
                          );
                          activeEntry = null;
                        }

                        log.debug(
                          `sync: pushed mutation to remote (table: ${entry!.table}, remaining: ${pendingQueue.length})`,
                        );
                        return true;
                      },
                      err: (e) => e as Error,
                    }).pipe(
                      Fx.recover((err) =>
                        Fx.from({
                          ok: async () => {
                            if (
                              entry &&
                              isAlreadyAppliedReplayError(entry, err as Error)
                            ) {
                              await pendingQueue.remove(
                                entry,
                                processorIdForReplay,
                              );
                              activeEntry = null;
                              log.debug(
                                `sync: dropping already-applied mutation (table: ${entry.table}, remaining: ${pendingQueue.length})`,
                              );
                              return true;
                            }

                            if (err instanceof ReplayLeaseLostError) {
                              activeEntry = null;
                              log.warn(
                                `sync: replay lease lost while processing ${entry?.ref ?? "unknown entry"}`,
                              );
                              return false;
                            }

                            const reason = classifyReplayError(err as Error);
                            if (reason !== "unknown" && entry) {
                              await pendingQueue.block(entry, reason);
                              activeEntry = null;
                            } else if (entry) {
                              await pendingQueue.release(
                                entry,
                                processorIdForReplay,
                              );
                              activeEntry = null;
                            }
                            log.warn(
                              "sync: remote push failed, stopping queue processing",
                              err,
                            );
                            return false;
                          },
                          err: (cause) => cause as Error,
                        }),
                      ),
                    ),
                });

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
          }),
        // Release: no-op, queueProcessingPromise is cleared in finally()
        () => Fx.unit,
      ),
    ).finally(() => {
      queueProcessingPromise = null;
    });

    await queueProcessingPromise;

    if (pendingQueue.isEmpty) {
      log.info("sync: queue fully processed");
    }
  }

  function runSyncCycle(options?: { forceResolve?: boolean }): Promise<void> {
    if (syncCyclePromise) return syncCyclePromise;

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    syncCyclePromise = Fx.run(
      Fx.gen(function* () {
        yield* Fx.from({
          ok: () => processQueue(signal),
          err: (e) => e as Error,
        });

        const route = getSyncCycleRoute({
          aborted: signal.aborted,
          forceResolve: options?.forceResolve ?? false,
          hasPending: !pendingQueue.isEmpty,
          isOnline,
          started,
        });

        yield* matchTag(route, "_tag", {
          Skip: () => Fx.unit,
          DeferUntilQueueDrains: () =>
            Fx.sync(() => {
              stopRemoteSubscriptions();
              log.warn(
                "sync: deferring resolve and remote subscriptions until pending queue drains",
              );
            }),
          Resolve: () =>
            Fx.from({
              ok: () => resolveAll(signal),
              err: (e) => e as Error,
            }),
        });

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
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              log.error("sync: online cycle failed", err);
            }
          }),
        ),
        Fx.recover(() => Fx.unit),
      ),
    ).finally(() => {
      syncCyclePromise = null;
      if (abortController?.signal === signal) {
        abortController = null;
      }
    });

    return syncCyclePromise;
  }

  // -------------------------------------------------------------------------
  // Resolve — pulls remote state via CRDT diff
  // -------------------------------------------------------------------------

  function resolveAll(signal?: AbortSignal): Promise<void> {
    const progress: ResolveProgress = {
      tables: [...tableNames],
      completed: 0,
      total: tableNames.length,
    };

    emit({ status: "resolving", progress });

    return Fx.run(
      Fx.each(tableNames, (tableName) =>
        Fx.defer(() => {
          if (signal?.aborted) {
            return Fx.fail(new DOMException("Aborted", "AbortError"));
          }
          return resolveTableFx(tableName, tables[tableName]!, signal).pipe(
            Fx.tap(() =>
              Fx.sync(() => {
                progress.completed++;
                emit({ status: "resolving", progress: { ...progress } });
              }),
            ),
          );
        }),
      ).pipe(
        Fx.tap(() =>
          Fx.sync(() => {
            emit({ status: "resolved" });
            log.info("sync: all tables resolved successfully");
          }),
        ),
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (signal?.aborted) return;
            if (err instanceof DOMException && err.name === "AbortError")
              return;
            log.error("sync: resolve failed", err);
            emit({
              status: "error",
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }),
        ),
        // Recover so the outer promise doesn't reject for resolve failures
        // (they're already surfaced via status emission)
        Fx.recover((err) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            return Fx.unit as any;
          }
          return Fx.unit as any;
        }),
        Fx.map(() => undefined as void),
      ),
    );
  }

  function resolveTableFx(
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
  ) {
    let attempts = 0;
    const retrySchedule = createResolveRetrySchedule({
      maxRetries,
      retryDelayMs,
      signal,
    });

    return Fx.gen(function* () {
      // ------------------------------------------------------------------
      // 1. Read local documents and encode Yjs state vectors.
      // ------------------------------------------------------------------

      const localDocs = yield* Fx.from({
        ok: () => getDocumentsForTable(tableName),
        err: (e) => e as Error,
      });

      const { schemaDef, localYjsMap, resolveDocuments } = prepareResolveInput(
        tableConfig.schema,
        localDocs,
      );

      log.debug(
        `sync: resolving "${tableName}" with ${resolveDocuments.length} local doc(s)`,
      );

      // ------------------------------------------------------------------
      // 2. Call the remote resolve query with retry.
      // ------------------------------------------------------------------

      const resolveResult: Array<ResolveResultRow> = yield* Fx.defer(() => {
        if (signal?.aborted) {
          return Fx.fail(new DOMException("Aborted", "AbortError"));
        }
        attempts++;
        return Fx.from({
          ok: () =>
            (remoteClient as any).query(tableConfig.resolve, {
              documents: resolveDocuments,
              ...(tableConfig.resolveArgs
                ? { scopeArgs: tableConfig.resolveArgs() }
                : {}),
            } satisfies ResolveArgs) as Promise<Array<ResolveResultRow>>,
          err: (err) => err as Error,
        });
      }).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => {
            if (!(err instanceof DOMException && err.name === "AbortError")) {
              log.warn(
                `sync: resolve attempt ${attempts}/${maxRetries} failed for "${tableName}"`,
                err,
              );
            }
          }),
        ),
        Fx.retry(retrySchedule),
      );

      // ------------------------------------------------------------------
      // 3. Apply diffs, materialize, and ingest.
      // ------------------------------------------------------------------

      const { mergedDocs, diffCount } = mergeResolveResult({
        localYjsMap,
        resolveResult,
        schemaDef,
        tableName,
        translateRemoteDocument: (document) =>
          stripOmittedFields(schemaDef, [document])[0] ?? document,
      });

      // ------------------------------------------------------------------
      // 4. Ingest the merged documents.
      //    ingestDocuments diffs against local state, so docs that didn't
      //    change will be no-ops (no unnecessary writes).
      // ------------------------------------------------------------------

      yield* ingestMergedDocsFx({
        ingestDocuments,
        mergedDocs,
        tableName,
      });

      log.debug(
        `sync: resolved table "${tableName}" — ` +
          `${resolveResult.length} doc(s), ${diffCount} diff(s) applied`,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Reactive remote subscriptions
  // -------------------------------------------------------------------------

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
    // Avoid duplicate subscriptions.
    stopRemoteSubscriptions();

    for (const [tableName, tableConfig] of Object.entries(tables)) {
      registerRemoteSubscription({
        ingestDocuments,
        getDocumentsForTable,
        getPendingEntries: () => pendingQueue.entries(),
        getAliases: (id) => idMap.getAliases(id),
        bufferRemoteSnapshot,
        translateRemoteSnapshotToLocal: (docs) => docs,
        onUnsubscribe: (unsub) => remoteUnsubscribes.push(unsub),
        remoteClient,
        tableConfig,
        tableName,
      });
    }

    log.info(`sync: subscribed to ${tableNames.length} remote table(s)`);
  }

  /**
   * Unsubscribe from all active remote reactive subscriptions.
   */
  function stopRemoteSubscriptions(): void {
    if (remoteUnsubscribes.length === 0) return;

    for (const unsub of remoteUnsubscribes) {
      try {
        unsub();
      } catch {
        // Ignore — the remote client may already be closed.
      }
    }
    remoteUnsubscribes.length = 0;

    log.info("sync: unsubscribed from remote tables");
  }

  // -------------------------------------------------------------------------
  // Network event handlers
  // -------------------------------------------------------------------------

  function handleOnline() {
    log.info("sync: online event — flushing queue, resolving, subscribing");
    isOnline = true;

    // Process the serial queue, pull remote state, then start reactive
    // subscriptions so we receive ongoing changes from other clients.
    Fx.detach(() => runSyncCycle(), "[sync] handleOnline:");
  }

  function handleOffline() {
    log.info("sync: offline event");
    isOnline = false;
    abortController?.abort();
    abortController = null;
    stopRemoteSubscriptions();
    clearBufferedSnapshots();
    emit({ status: "offline" });
  }

  function hydrateIdentityState(): Promise<void> {
    return Fx.run(
      Fx.zip(
        Fx.from({ ok: () => idMap.hydrate(), err: (e) => e as Error }),
        Fx.from({ ok: () => pendingQueue.hydrate(), err: (e) => e as Error }),
      ).pipe(
        Fx.inspect((err) =>
          Fx.sync(() => log.warn("sync: hydration failed", err)),
        ),
        Fx.recover(() => Fx.unit),
        Fx.map(() => undefined as void),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    start() {
      if (started) return;
      started = true;

      log.info("sync: started");

      // Hydrate ID map and pending queue from embedded DB.
      // This is fire-and-forget — the queue processor will wait
      // for hydration to complete before accessing the data.
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

      abortController?.abort();
      abortController = null;
      if (activeEntry) {
        const entry = activeEntry;
        activeEntry = null;
        Fx.detach(
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

      listeners.clear();
      emit({ status: "idle" });
    },

    on(event: "change", listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getStatus(): EngineStatus {
      return status;
    },

    mutation(
      ref: unknown,
      args: Record<string, unknown>,
      options?: { enqueueForReplay?: boolean },
    ): Promise<unknown> {
      // 1. Execute against the embedded runtime directly.
      // 2. Optionally persist the result to the pending queue for replay.
      // 3. When online: creates wait for replay so the caller observes the
      //    stable remote ID instead of a provisional local ID.
      const enqueueForReplay = options?.enqueueForReplay ?? true;
      const executeMutationLocally = executeLocalMutationWithEffects
        ? executeLocalMutationWithEffects
        : (r: unknown, a: Record<string, unknown>) =>
            (localClient as any).mutation(r, a) as Promise<unknown>;
      return Fx.run(
        Fx.from({
          ok: async () => {
            const refName = getFunctionName(ref as any);
            const localArgs = idMap.translateRemoteIdsToLocal(args);
            const localResult = await executeMutationLocally(ref, localArgs);

            if (isLocalUploadUrl(localResult)) {
              registerUploadUrlSource?.(localResult, refName);
              return localResult;
            }

            if (enqueueForReplay) {
              try {
                const table = inferTableFromRef(ref, tables);
                await pendingQueue.push(
                  ref,
                  args,
                  localResult,
                  table,
                  getReplayPayloadVersion?.(refName) ?? 1,
                );

                if (isOnline) {
                  if (
                    refName.endsWith(":create") &&
                    typeof localResult === "string"
                  ) {
                    await processQueue();
                  } else {
                    ensureReplayProcessing();
                  }
                } else {
                  log.debug("sync: offline — mutation queued for later push");
                }
              } catch (err) {
                log.warn("sync: failed to queue mutation", err);
                throw err;
              }
            }

            return idMap.translateResult(localResult);
          },
          err: (e) => e as Error,
        }),
      );
    },

    resolveNow(): Promise<void> {
      if (isOnline) {
        stopRemoteSubscriptions();
      }
      return runSyncCycle({ forceResolve: true });
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** @internal */
export const engine = {
  create: createEngine,
};
