import type { ConvexClient } from "convex/browser";

import { getBrowserDebugApi } from "@/browser/debug";
import {
  getActiveSubscriptions,
  subscribeActiveSubscriptions,
} from "@/client/adapter";
import { getAuthState, subscribeAuthState } from "@/client/auth";
import type { AuthState } from "@/client/auth";
import { getEmbeddedClientEntry } from "@/client/entry";
import { getRemoteState, subscribeRemoteState } from "@/client/remote";
import type { RemoteState } from "@/client/remote";
import {
  operationsToPerfSummary,
  spansToOperations,
} from "@/devtools/core/operations";
import type {
  AuthSnapshot,
  CrdtEntry,
  DataRows,
  DataTable,
  DevtoolsLogLine,
  DevtoolsSnapshot,
  EmbeddedDevtoolsSource,
  OperationEntry,
  PendingEntry,
  PerfSummary,
  RunFunctionInput,
  SchemaTable,
  SubscriptionEntry,
  SyncSnapshot,
} from "@/devtools/core/types";
import type { SerializedQuery } from "@/runtime/db/types";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import { createLogger } from "@/shared/logger";
import { installInMemoryTracing } from "@/tracing/memory";
import type { BufferingTracingHandle } from "@/tracing/memory";

const log = createLogger("devtools");

const SYS_PENDING_GET_ALL = "_system:pendingGetAll";
const DEFAULT_ROW_LIMIT = 50;

interface PendingRow {
  _id?: unknown;
  ref?: unknown;
  table?: unknown;
  state?: unknown;
  createdAt?: unknown;
}

function getRuntime(client: ConvexClient): EmbeddedRuntime | null {
  return getEmbeddedClientEntry(client)?.runtime ?? null;
}

function mapRemoteState(state: RemoteState): SyncSnapshot {
  const online = state.status === "resolved" || state.status === "resolving";
  const detail: Record<string, unknown> = {};
  if (state.status === "resolving" && state.progress) {
    detail.progress = state.progress;
  }
  if (state.status === "error" && state.error) {
    detail.error = state.error.message;
  }
  return {
    status: state.status,
    online,
    detail: Object.keys(detail).length > 0 ? detail : undefined,
  };
}

function mapAuthState(state: AuthState): AuthSnapshot {
  const identityKey =
    "identityKey" in state && typeof state.identityKey === "string"
      ? state.identityKey
      : null;
  return {
    status: state.status,
    identityKey,
  };
}

function mapPendingRows(rows: unknown): PendingEntry[] {
  if (!Array.isArray(rows)) return [];
  const entries: PendingEntry[] = [];
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as PendingRow;
    if (typeof row._id !== "string" || typeof row.ref !== "string") continue;
    entries.push({
      id: row._id,
      ref: row.ref,
      table: typeof row.table === "string" ? row.table : undefined,
      status: typeof row.state === "string" ? row.state : "pending",
      createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
    });
  }
  return entries;
}

class EmbeddedDevtoolsSourceImpl implements EmbeddedDevtoolsSource {
  private readonly handle: BufferingTracingHandle;
  private disposed = false;
  private pendingCache: PendingEntry[] = [];
  private readonly pendingListeners = new Set<() => void>();
  private dataCache: DataTable[] | null = null;
  private dataRefreshing = false;
  private readonly dataListeners = new Set<() => void>();

  constructor(private readonly client: ConvexClient) {
    this.handle = installInMemoryTracing();
  }

  getSnapshot<V extends keyof DevtoolsSnapshot>(view: V): DevtoolsSnapshot[V] {
    switch (view) {
      case "operations":
        return this.readOperations() as DevtoolsSnapshot[V];
      case "performance":
        return this.readPerformance() as DevtoolsSnapshot[V];
      case "logs":
        return this.readLogs() as DevtoolsSnapshot[V];
      case "subscriptions":
        return this.readSubscriptions() as DevtoolsSnapshot[V];
      case "sync":
        return mapRemoteState(
          getRemoteState(this.client),
        ) as DevtoolsSnapshot[V];
      case "auth":
        return mapAuthState(getAuthState(this.client)) as DevtoolsSnapshot[V];
      case "pending":
        void this.refreshPending();
        return this.pendingCache.slice() as DevtoolsSnapshot[V];
      case "data":
        void this.refreshDataTables();
        return (this.dataCache ??
          this.readDataTablesSync()) as DevtoolsSnapshot[V];
      case "schema":
        return this.readSchema() as DevtoolsSnapshot[V];
      case "crdt":
        return this.readCrdt() as DevtoolsSnapshot[V];
      default:
        return this.readCrdt() as DevtoolsSnapshot[V];
    }
  }

  private readCrdt(): CrdtEntry[] {
    return [];
  }

  subscribe(view: keyof DevtoolsSnapshot, callback: () => void): () => void {
    switch (view) {
      case "operations":
      case "performance":
      case "logs":
        return this.handle.subscribe(callback);
      case "subscriptions":
        return subscribeActiveSubscriptions(this.client, callback);
      case "sync":
        return subscribeRemoteState(this.client, () => callback());
      case "auth":
        return subscribeAuthState(this.client, () => callback());
      case "pending":
        return this.subscribePending(callback);
      case "data":
        return this.subscribeData(callback);
      default:
        return () => {};
    }
  }

  private subscribeData(callback: () => void): () => void {
    this.dataListeners.add(callback);
    const unsubscribe = this.handle.subscribe(() => {
      void this.refreshDataTables();
    });
    void this.refreshDataTables();
    return () => {
      this.dataListeners.delete(callback);
      unsubscribe();
    };
  }

  private async refreshDataTables(): Promise<void> {
    if (this.dataRefreshing) return;
    const runtime = getRuntime(this.client);
    if (!runtime) return;
    this.dataRefreshing = true;
    try {
      const db = runtime.db;
      const next = await Promise.all(
        db.getTableNames().map(async (name) => ({
          name,
          rowCount: await db.countAsync(name),
        })),
      );
      if (this.disposed) return;
      if (this.dataCache && sameData(this.dataCache, next)) return;
      this.dataCache = next;
      for (const listener of this.dataListeners) {
        try {
          listener();
        } catch {
          /* listener error */
        }
      }
    } finally {
      this.dataRefreshing = false;
    }
  }

  private subscribePending(callback: () => void): () => void {
    this.pendingListeners.add(callback);
    const unsubscribe = this.handle.subscribe(() => {
      void this.refreshPending();
    });
    void this.refreshPending();
    return () => {
      this.pendingListeners.delete(callback);
      unsubscribe();
    };
  }

  private async refreshPending(): Promise<void> {
    const next = await this.loadPending();
    if (this.disposed) return;
    if (samePending(this.pendingCache, next)) return;
    this.pendingCache = next;
    for (const listener of this.pendingListeners) {
      try {
        listener();
      } catch {
        /* listener error */
      }
    }
  }

  async listTableRows(
    table: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<DataRows> {
    const runtime = getRuntime(this.client);
    if (!runtime) {
      return { table, rows: [], cursor: null, isDone: true };
    }
    const limit = Math.max(1, options?.limit ?? DEFAULT_ROW_LIMIT);
    const query: SerializedQuery = {
      source: { type: "FullTableScan", tableName: table, order: "asc" },
      operators: [],
    };
    const result = await runtime.db.paginateAsync({
      query,
      cursor: options?.cursor ?? null,
      pageSize: limit,
    });
    return {
      table,
      rows: result.page.map((doc) => ({ ...doc }) as Record<string, unknown>),
      cursor: result.isDone ? null : result.continueCursor,
      isDone: result.isDone,
    };
  }

  async runFunction(input: RunFunctionInput): Promise<unknown> {
    const runtime = getRuntime(this.client);
    if (!runtime) {
      throw new Error(
        "[convex-embedded] devtools: embedded runtime is not available for this client.",
      );
    }
    if (input.kind === "mutation") {
      return runtime.executeLocal({
        kind: "mutation",
        path: input.path,
        args: input.args,
        applyLocalEffects: true,
      });
    }
    return runtime.executeLocal({
      kind: input.kind,
      path: input.path,
      args: input.args,
    });
  }

  async patchDocument(
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const runtime = getRuntime(this.client);
    if (!runtime) {
      throw new Error(
        "[convex-embedded] devtools: embedded runtime is not available for this client.",
      );
    }
    const existing = runtime.db
      .getDocumentsForTable(table)
      .find((doc) => doc._id === id);
    if (!existing) {
      throw new Error(
        `[convex-embedded] devtools: document "${id}" was not found in table "${table}".`,
      );
    }
    const merged: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
      ...fields,
      _id: existing._id,
      _creationTime: existing._creationTime,
    };
    await runtime.ingestDocuments(table, [merged]);
  }

  async clearLocalData(): Promise<void> {
    const api = getBrowserDebugApi();
    if (!api) {
      log.warn("clearLocalData: no browser debug api registered");
      return;
    }
    await api.clearLocalData();
  }

  clearActivity(): void {
    this.handle.clearSpans();
    this.handle.clearLogs();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.handle.close().catch((error: unknown) => {
      log.warn("failed to close tracing handle", error);
    });
  }

  async loadPending(): Promise<PendingEntry[]> {
    const runtime = getRuntime(this.client);
    if (!runtime) return [];
    try {
      const rows = await runtime.executeLocal({
        kind: "query",
        path: SYS_PENDING_GET_ALL,
        args: { identityKey: null },
      });
      return mapPendingRows(rows);
    } catch (error) {
      log.warn("failed to load pending entries", error);
      return [];
    }
  }

  private readOperations(): OperationEntry[] {
    return spansToOperations(this.handle.getSpans(), this.handle.getLogs());
  }

  private readPerformance(): PerfSummary {
    return operationsToPerfSummary(this.readOperations());
  }

  private readLogs(): DevtoolsLogLine[] {
    return this.handle.getLogs().map((entry) => {
      const category = entry.attributes.category;
      return {
        severity: entry.severity,
        body: entry.body,
        timeMs: entry.timeMs,
        category: typeof category === "string" ? category : undefined,
      };
    });
  }

  private readSubscriptions(): SubscriptionEntry[] {
    return getActiveSubscriptions(this.client).map((entry) => ({
      id: entry.id,
      path: entry.path,
      args: entry.args,
      value: entry.value,
      updateCount: entry.updateCount,
      lastUpdateMs: entry.lastUpdateMs,
    }));
  }

  private readDataTablesSync(): DataTable[] {
    const runtime = getRuntime(this.client);
    if (!runtime) return [];
    const db = runtime.db;
    return db.getTableNames().map((name) => ({
      name,
      rowCount: db.count(name),
    }));
  }

  private readSchema(): SchemaTable[] {
    const runtime = getRuntime(this.client);
    if (!runtime) return [];
    const db = runtime.db;
    return db.getTableNames().map((name) => ({
      name,
      indexes: db.getIndexDefinitions(name).map((definition) => ({
        name: definition.indexName,
        fields: definition.fields,
      })),
    }));
  }
}

function samePending(left: PendingEntry[], right: PendingEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) return false;
    if (a.id !== b.id || a.status !== b.status) return false;
  }
  return true;
}

function sameData(left: DataTable[], right: DataTable[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b) return false;
    if (a.name !== b.name || a.rowCount !== b.rowCount) return false;
  }
  return true;
}

/**
 * Create the framework-agnostic devtools data source for an embedded
 * {@link ConvexClient}.
 */
export function createEmbeddedDevtoolsSource(
  client: ConvexClient,
): EmbeddedDevtoolsSource {
  return new EmbeddedDevtoolsSourceImpl(client);
}
