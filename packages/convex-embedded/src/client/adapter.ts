import type { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";

import type { CachedEntry, EmbeddedQueryCache } from "@/client/cache";
import {
  assertRemotePlanOnline,
  type MutationPlan,
  type ReadPlan,
} from "@/client/routing/plan";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import {
  isConnectivityOffline,
  type ConnectivityAdapter,
} from "@/runtime/platform";
import type { QueryCacheStorage } from "@/runtime/sqlite/cache_table";
import { structuralEqual } from "@/shared/equals";
import { createLogger } from "@/shared/logger";
import { nowMs } from "@/shared/perf";
import { stableValueKey } from "@/shared/valuekey";
import {
  createDefaultWorkScheduler,
  type WorkScheduler,
} from "@/shared/work";
import { withSpanSync } from "@/tracing/spans";

import { effectToTransitions } from "@/client/optimistic/apply";
import { deriveOptimisticEffect } from "@/client/optimistic/derive";

const log = createLogger("cache");

function createNoopUnsubscribe(): any {
  const noop = (() => {}) as any;
  noop.unsubscribe = noop;
  noop.getCurrentValue = () => undefined;
  noop.getQueryLogs = () => undefined;
  return noop;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function collectDocs(
  value: unknown,
  out: Array<Record<string, unknown>>,
  depth = 0,
): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value) collectDocs(item, out, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  if (typeof value._id === "string") {
    const creationTime =
      typeof value._creationTime === "number" ? value._creationTime : 0;
    out.push({ ...value, _creationTime: creationTime });
    return;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child) || isPlainObject(child)) {
      collectDocs(child, out, depth + 1);
    }
  }
}

function normalizeClientResult(
  rawValue: unknown,
  translatedValue: unknown,
): unknown {
  if (Array.isArray(translatedValue)) {
    const rawItems = Array.isArray(rawValue) ? rawValue : [];
    return translatedValue.map((entryValue, index) =>
      normalizeClientResult(rawItems[index], entryValue),
    );
  }

  if (!isPlainObject(translatedValue)) {
    return translatedValue;
  }

  const rawEntries = isPlainObject(rawValue) ? rawValue : {};

  return Object.fromEntries(
    Object.entries(translatedValue).map(([key, entryValue]) => [
      key,
      normalizeClientResult(rawEntries[key], entryValue),
    ]),
  );
}

function toClientResult<T>(value: T, translate?: <U>(value: U) => U): T {
  const translated = translate?.(value) ?? value;
  return normalizeClientResult(value, translated) as T;
}

function isSystemRefName(refName: string): boolean {
  return refName.startsWith("_system:");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(null);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface CachePipelineConfig {
  cache: EmbeddedQueryCache;
  getCacheStorage: () => QueryCacheStorage | null;
  remoteClient: ConvexClient | null;
  connectivity?: ConnectivityAdapter;
  asError: (error: unknown) => Error;
  runtime: EmbeddedRuntime;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
}

interface ActiveSubscription {
  refName: string;
  args: unknown;
  argsKey: string;
  listeners: Set<(value: unknown) => void>;
  errorListeners: Set<(error: Error) => void>;
  currentValue: unknown;
  hasValue: boolean;
  lastRemoteValue: unknown;
  optimisticAppliedAtMs: number;
  remoteUnsubscribe: (() => void) | null;
  storageLoadPromise: Promise<void> | null;
  localUnsubscribe: (() => void) | null;
  localHandle: (() => void) | null;
  pendingPushValue: unknown;
  pendingPushHasValue: boolean;
  pendingPushTimer: ReturnType<typeof setTimeout> | null;
  lastPushAtMs: number;
}

const REMOTE_PUSH_COALESCE_MS = 16;

const OPTIMISTIC_PROTECTION_MS = 500;

class CachePipeline {
  private readonly active = new Map<string, ActiveSubscription>();
  private readonly removeOnlineListener: (() => void) | null;

  constructor(private readonly config: CachePipelineConfig) {
    const connectivity = config.connectivity;
    this.removeOnlineListener =
      connectivity?.onOnline?.(() => {
        this.openDeferredSubscriptions();
      }) ?? null;
  }

  private openDeferredSubscriptions(): void {
    if (!this.config.remoteClient) return;
    if (isConnectivityOffline(this.config.connectivity)) return;
    for (const entry of this.active.values()) {
      if (entry.remoteUnsubscribe === null) {
        this.openRemoteSubscription(entry);
      }
    }
  }

  getCurrentValue(refName: string, args: unknown): unknown {
    const argsKey = `${refName} ${stableValueKey(args)}`;
    const existing = this.active.get(argsKey);
    if (existing && existing.hasValue) {
      return existing.currentValue;
    }
    const cached = this.config.cache.get(refName, args);
    return cached?.value;
  }

  private deferredScheduler: (fn: () => void) => void = (fn) => fn();
  private workScheduler: WorkScheduler = createDefaultWorkScheduler();

  setDeferredScheduler(scheduler: (fn: () => void) => void): void {
    this.deferredScheduler =
      typeof scheduler === "function" ? scheduler : (fn) => fn();
  }

  setWorkScheduler(scheduler: WorkScheduler | null): void {
    this.workScheduler = scheduler ?? createDefaultWorkScheduler();
  }

  getWorkScheduler(): WorkScheduler {
    return this.workScheduler;
  }

  applyOptimisticTransition(
    updates: Array<{
      refName: string;
      args: unknown;
      value: unknown;
      priority?: "discrete" | "transition";
    }>,
  ): void {
    if (updates.length === 0) return;
    const transition: typeof updates = [];
    for (const update of updates) {
      if (update.priority === "transition") {
        transition.push(update);
        continue;
      }
      this.applyOptimisticOne(update);
    }
    if (transition.length > 0) {
      this.deferredScheduler(() => {
        for (const update of transition) {
          this.applyOptimisticOne(update);
        }
      });
    }
  }

  private applyOptimisticOne(update: {
    refName: string;
    args: unknown;
    value: unknown;
  }): void {
    const argsKey = `${update.refName} ${stableValueKey(update.args)}`;
    const previous = this.config.cache.get(update.refName, update.args);
    const nextEntry: CachedEntry = {
      value: update.value,
      receivedAtMs: Date.now(),
      ts: previous?.ts,
      paginationCursor: previous?.paginationCursor,
      paginationIsDone: previous?.paginationIsDone,
    };
    const changed = this.config.cache.set(
      update.refName,
      update.args,
      nextEntry,
    );
    if (!changed) return;

    const entry = this.active.get(argsKey);
    if (entry) {
      const valueChanged =
        !entry.hasValue || !structuralEqual(entry.currentValue, update.value);
      entry.currentValue = update.value;
      entry.hasValue = true;
      entry.optimisticAppliedAtMs = nowMs();
      if (valueChanged) {
        this.notifyListeners(entry);
      }
      void this.persistEntry(entry, nextEntry);
    }
  }

  subscribe(input: {
    refName: string;
    args: unknown;
    onValue: (value: unknown) => void;
    onError?: (error: Error) => void;
  }): () => void {
    const { refName, args } = input;
    const argsKey = `${refName} ${stableValueKey(args)}`;
    let entry = this.active.get(argsKey);
    if (!entry) {
      entry = {
        refName,
        args,
        argsKey,
        listeners: new Set(),
        errorListeners: new Set(),
        currentValue: undefined,
        hasValue: false,
        lastRemoteValue: undefined,
        optimisticAppliedAtMs: 0,
        remoteUnsubscribe: null,
        storageLoadPromise: null,
        localUnsubscribe: null,
        localHandle: null,
        pendingPushValue: undefined,
        pendingPushHasValue: false,
        pendingPushTimer: null,
        lastPushAtMs: 0,
      };
      this.active.set(argsKey, entry);
      this.bootstrapEntry(entry);
    }

    entry.listeners.add(input.onValue);
    if (input.onError) {
      entry.errorListeners.add(input.onError);
    }

    if (entry.hasValue) {
      try {
        input.onValue(entry.currentValue);
      } catch {
        /* listener error */
      }
    }

    return () => {
      const current = this.active.get(argsKey);
      if (!current) return;
      current.listeners.delete(input.onValue);
      if (input.onError) {
        current.errorListeners.delete(input.onError);
      }
      if (current.listeners.size === 0 && current.errorListeners.size === 0) {
        if (current.pendingPushTimer !== null) {
          clearTimeout(current.pendingPushTimer);
          current.pendingPushTimer = null;
          current.pendingPushHasValue = false;
          current.pendingPushValue = undefined;
        }
        if (current.remoteUnsubscribe) {
          try {
            current.remoteUnsubscribe();
          } catch {
            /* ignore */
          }
          current.remoteUnsubscribe = null;
        }
        if (current.localUnsubscribe) {
          try {
            current.localUnsubscribe();
          } catch {
            /* ignore */
          }
          current.localUnsubscribe = null;
        }
        this.active.delete(argsKey);
      }
    };
  }

  private bootstrapEntry(entry: ActiveSubscription): void {
    const startedAt = nowMs();
    const cached = this.config.cache.get(entry.refName, entry.args);
    let cacheState: "hit" | "miss-disk" | "miss-cold" = "miss-cold";
    if (cached) {
      entry.currentValue = cached.value;
      entry.hasValue = true;
      entry.lastRemoteValue = cached.value;
      cacheState = "hit";
    } else if (this.config.getCacheStorage()) {
      entry.storageLoadPromise = this.loadFromStorage(entry).catch(() => {
        /* swallow */
      });
      cacheState = "miss-disk";
    }

    if (
      this.config.remoteClient &&
      !isConnectivityOffline(this.config.connectivity)
    ) {
      this.openRemoteSubscription(entry);
    }

    this.openLocalWatch(entry);
    log.debug(
      `bootstrapEntry ${entry.refName} ${cacheState} ms=${(nowMs() - startedAt).toFixed(1)}`,
    );
  }

  private openLocalWatch(entry: ActiveSubscription): void {
    const runtime = this.config.runtime;
    if (!runtime || typeof runtime.watchLocalQuery !== "function") return;
    const translatedArgs =
      this.config.translateLocalArgsToRuntime?.(
        entry.args as Record<string, unknown>,
      ) ?? (entry.args as Record<string, unknown>);

    let watch: any;
    try {
      watch = runtime.watchLocalQuery(entry.refName, translatedArgs);
    } catch {
      return;
    }

    const handleLocal = () => {
      if (!this.active.has(entry.argsKey)) return;
      withSpanSync(
        "convex-embedded.cache.localUpdate",
        (span) => {
          const startedAt = nowMs();
          let result: unknown;
          let usedRemoteFallback = false;
          try {
            result = watch.localQueryResult();
          } catch (error) {
            log.debug(
              `local-watch eval threw for ${entry.refName}: ${(error as Error).message}`,
            );
            if (entry.lastRemoteValue === undefined) {
              span.setAttributes({ "convex.cache.skip": "throw" });
              return;
            }
            result = entry.lastRemoteValue;
            usedRemoteFallback = true;
          }
          if (result === undefined) {
            if (entry.lastRemoteValue === undefined) {
              span.setAttributes({ "convex.cache.skip": "undefined" });
              return;
            }
            result = entry.lastRemoteValue;
            usedRemoteFallback = true;
          }
          if (
            !usedRemoteFallback &&
            entry.lastRemoteValue !== undefined &&
            Array.isArray(result) &&
            Array.isArray(entry.lastRemoteValue) &&
            result.length < entry.lastRemoteValue.length
          ) {
            log.debug(
              `local-watch ${entry.refName} smaller than remote (${result.length} < ${entry.lastRemoteValue.length}); preferring remote`,
            );
            result = entry.lastRemoteValue;
            usedRemoteFallback = true;
          }
          const equalStart = nowMs();
          const valueChanged =
            !entry.hasValue || !structuralEqual(entry.currentValue, result);
          const equalMs = nowMs() - equalStart;
          if (!valueChanged) {
            span.setAttributes({
              "convex.cache.skip": "unchanged",
              "convex.cache.eval_ms": +(nowMs() - startedAt).toFixed(2),
            });
            log.debug(
              `local-watch ${entry.refName} unchanged read_ms=${(equalStart - startedAt).toFixed(1)} equal_ms=${equalMs.toFixed(1)}`,
            );
            return;
          }
          if (
            entry.hasValue &&
            entry.optimisticAppliedAtMs > 0 &&
            nowMs() - entry.optimisticAppliedAtMs < OPTIMISTIC_PROTECTION_MS
          ) {
            span.setAttributes({
              "convex.cache.skip": "optimistic-window",
              "convex.cache.eval_ms": +(nowMs() - startedAt).toFixed(2),
            });
            log.debug(
              `local-watch ${entry.refName} skipped (optimistic-window ${(nowMs() - entry.optimisticAppliedAtMs).toFixed(1)}ms ago)`,
            );
            return;
          }
          log.debug(
            `local-watch ${entry.refName} result.length=${Array.isArray(result) ? result.length : "non-array"} fallback=${usedRemoteFallback} read_ms=${(equalStart - startedAt).toFixed(1)} equal_ms=${equalMs.toFixed(1)}`,
          );
          const previous = this.config.cache.get(entry.refName, entry.args);
          const nextEntry: CachedEntry = {
            value: result,
            receivedAtMs: Date.now(),
            ts: previous?.ts,
            paginationCursor: previous?.paginationCursor,
            paginationIsDone: previous?.paginationIsDone,
          };
          const changed = this.config.cache.set(
            entry.refName,
            entry.args,
            nextEntry,
          );
          entry.currentValue = result;
          entry.hasValue = true;
          if (changed) {
            void this.persistEntry(entry, nextEntry);
          }
          span.setAttributes({
            "convex.cache.ref": entry.refName,
            "convex.cache.value_changed": true,
            "convex.cache.eval_ms": +(nowMs() - startedAt).toFixed(2),
            "convex.cache.fallback": usedRemoteFallback,
          });
          this.notifyListeners(entry);
        },
      );
    };

    let unsubscribe: (() => void) | null = null;
    try {
      const result = watch.onUpdate(handleLocal) as any;
      if (typeof result === "function") {
        unsubscribe = result;
      } else if (result && typeof result.unsubscribe === "function") {
        unsubscribe = () => result.unsubscribe();
      }
    } catch {
      return;
    }
    entry.localUnsubscribe = unsubscribe;
    entry.localHandle = handleLocal;
    handleLocal();
  }


  private async loadFromStorage(entry: ActiveSubscription): Promise<void> {
    const storage = this.config.getCacheStorage();
    if (!storage) return;
    const argsHash = stableValueKey(entry.args);
    let row;
    try {
      row = await storage.load(entry.refName, argsHash);
    } catch {
      return;
    }
    if (!row) return;
    if (entry.hasValue) return;
    if (!this.active.has(entry.argsKey)) return;
    const value = safeJsonParse(row.valueJson);
    const cacheEntry: CachedEntry = {
      value,
      receivedAtMs: row.receivedAt,
      ts: row.ts ?? undefined,
      paginationCursor: row.paginationCursor ?? undefined,
      paginationIsDone:
        row.paginationIsDone === null
          ? undefined
          : row.paginationIsDone === 1,
    };
    this.config.cache.set(entry.refName, entry.args, cacheEntry);
    entry.currentValue = value;
    entry.hasValue = true;
    entry.lastRemoteValue = value;
    this.notifyListeners(entry);
  }

  private openRemoteSubscription(entry: ActiveSubscription): void {
    const remoteClient = this.config.remoteClient;
    if (!remoteClient) return;
    const onUpdate = (remoteClient as any).onUpdate as
      | ((
          ref: unknown,
          args: unknown,
          callback: (value: unknown) => void,
          onError?: (error: Error) => void,
        ) => unknown)
      | undefined;
    if (typeof onUpdate !== "function") return;

    const applyPush = (value: unknown) => {
      if (!this.active.has(entry.argsKey)) return;
      const remoteChanged =
        entry.lastRemoteValue === undefined ||
        !structuralEqual(entry.lastRemoteValue, value);
      if (!remoteChanged) return;
      const previousRemote = entry.lastRemoteValue;
      entry.lastRemoteValue = value;
      this.workScheduler.post("background", () => {
        this.extractDocsToStore(entry.refName, value, previousRemote);
      });
      const previous = this.config.cache.get(entry.refName, entry.args);
      const persistedEntry: CachedEntry = {
        value,
        receivedAtMs: Date.now(),
        ts: previous?.ts,
        paginationCursor: previous?.paginationCursor,
        paginationIsDone: previous?.paginationIsDone,
      };
      void this.persistEntry(entry, persistedEntry);
      if (entry.localHandle) {
        entry.localHandle();
      }
    };

    const flushPending = () => {
      entry.pendingPushTimer = null;
      if (!entry.pendingPushHasValue) return;
      const value = entry.pendingPushValue;
      entry.pendingPushHasValue = false;
      entry.pendingPushValue = undefined;
      log.debug(
        `remote-push ${entry.refName} flushing coalesced value.length=${Array.isArray(value) ? value.length : "non-array"}`,
      );
      applyPush(value);
    };

    const handlePush = (value: unknown) => {
      if (!this.active.has(entry.argsKey)) return;
      log.debug(
        `remote-push ${entry.refName} value.length=${Array.isArray(value) ? value.length : "non-array"} type=${Array.isArray(value) ? "array" : typeof value}`,
      );
      const now = nowMs();
      if (
        entry.lastPushAtMs > 0 &&
        now - entry.lastPushAtMs < REMOTE_PUSH_COALESCE_MS
      ) {
        entry.pendingPushValue = value;
        entry.pendingPushHasValue = true;
        if (entry.pendingPushTimer === null) {
          const delay = Math.max(
            0,
            REMOTE_PUSH_COALESCE_MS - (now - entry.lastPushAtMs),
          );
          entry.pendingPushTimer = setTimeout(flushPending, delay);
        }
        return;
      }
      entry.lastPushAtMs = now;
      applyPush(value);
    };

    const handleError = (error: Error) => {
      const normalized = this.config.asError(error);
      for (const listener of entry.errorListeners) {
        try {
          listener(normalized);
        } catch {
          /* listener error */
        }
      }
    };

    let unsubscribe: (() => void) | null = null;
    try {
      const result = onUpdate.call(
        remoteClient,
        entry.refName as unknown,
        entry.args,
        handlePush,
        handleError,
      ) as any;
      if (typeof result === "function") {
        unsubscribe = result;
      } else if (result && typeof result.unsubscribe === "function") {
        unsubscribe = () => result.unsubscribe();
      }
    } catch (error) {
      handleError(this.config.asError(error));
      return;
    }
    entry.remoteUnsubscribe = unsubscribe;
  }

  private extractDocsToStore(
    refName: string,
    value: unknown,
    previousValue: unknown,
  ): void {
    const tableName = refName.split(":")[0];
    if (!tableName || tableName.startsWith("_")) return;
    const collectStart = nowMs();
    const docs: Array<Record<string, unknown>> = [];
    collectDocs(value, docs);
    if (docs.length === 0) return;

    let changed: Array<Record<string, unknown>> = docs;
    if (previousValue !== undefined && Array.isArray(value) && Array.isArray(previousValue)) {
      const previousById = new Map<string, unknown>();
      for (const item of previousValue) {
        if (isPlainObject(item) && typeof item._id === "string") {
          previousById.set(item._id, item);
        }
      }
      changed = docs.filter((doc) => {
        const id = typeof doc._id === "string" ? doc._id : null;
        if (id === null) return true;
        const prior = previousById.get(id);
        if (prior === undefined) return true;
        return !structuralEqual(prior, doc);
      });
    }
    const collectMs = nowMs() - collectStart;
    if (changed.length === 0) {
      log.debug(
        `extractDocsToStore ${refName} table=${tableName} docs=${docs.length} unchanged collect_ms=${collectMs.toFixed(1)}`,
      );
      return;
    }
    const runtime = this.config.runtime;
    if (!runtime || typeof runtime.upsertDocsFromCache !== "function") return;
    log.debug(
      `extractDocsToStore ${refName} table=${tableName} docs=${docs.length} changed=${changed.length} collect_ms=${collectMs.toFixed(1)}`,
    );
    void runtime.upsertDocsFromCache(tableName, changed).catch(() => {
      /* swallow extraction errors */
    });
  }

  private async persistEntry(
    entry: ActiveSubscription,
    cacheEntry: CachedEntry,
  ): Promise<void> {
    const storage = this.config.getCacheStorage();
    if (!storage) return;
    const argsHash = stableValueKey(entry.args);
    try {
      await storage.upsert({
        refName: entry.refName,
        argsHash,
        argsJson: safeJsonStringify(entry.args),
        valueJson: safeJsonStringify(cacheEntry.value),
        receivedAt: cacheEntry.receivedAtMs,
        ts: cacheEntry.ts ?? null,
        paginationCursor: cacheEntry.paginationCursor ?? null,
        paginationIsDone:
          cacheEntry.paginationIsDone === undefined
            ? null
            : cacheEntry.paginationIsDone
              ? 1
              : 0,
      });
    } catch {
      /* swallow */
    }
  }

  private notifyListeners(entry: ActiveSubscription): void {
    if (entry.listeners.size === 0) return;
    log.debug(
      `notify ${entry.refName} listeners=${entry.listeners.size} ts=${nowMs().toFixed(1)}`,
    );
    withSpanSync(
      "convex-embedded.cache.notifyListeners",
      (span) => {
        const startedAt = nowMs();
        let count = 0;
        for (const listener of entry.listeners) {
          try {
            listener(entry.currentValue);
            count += 1;
          } catch {
            /* listener error */
          }
        }
        span.setAttributes({
          "convex.cache.ref": entry.refName,
          "convex.cache.listeners": count,
          "convex.cache.notify_ms": +(nowMs() - startedAt).toFixed(2),
        });
      },
    );
  }
}

function createCacheOnUpdate(input: {
  pipeline: CachePipeline;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  translateLocalResultToClient?: <T>(value: T) => T;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const refName = input.getRefName(ref);

    const fireValue = (raw: unknown) => {
      try {
        const translated = toClientResult(
          raw,
          input.translateLocalResultToClient,
        );
        callback(
          translated,
          "Second argument to onUpdate callback is reserved for later use",
        );
      } catch (error) {
        const normalized = input.asError(error);
        if (onError) {
          onError(
            normalized,
            "Second argument to onUpdate onError is reserved for later use",
          );
        } else {
          void Promise.reject(normalized);
        }
      }
    };

    const fireError = (error: Error) => {
      const normalized = input.asError(error);
      if (onError) {
        onError(
          normalized,
          "Second argument to onUpdate onError is reserved for later use",
        );
      } else {
        void Promise.reject(normalized);
      }
    };

    const unsubscribe = input.pipeline.subscribe({
      refName,
      args: args ?? {},
      onValue: fireValue,
      onError: fireError,
    }) as any;

    unsubscribe.unsubscribe = unsubscribe;
    unsubscribe.getCurrentValue = () => {
      const raw = input.pipeline.getCurrentValue(refName, args ?? {});
      if (raw === undefined) return undefined;
      return toClientResult(raw, input.translateLocalResultToClient);
    };
    unsubscribe.getQueryLogs = () => undefined;
    return unsubscribe;
  };
}

function createCachePaginatedOnUpdate(input: {
  pipeline: CachePipeline;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  translateLocalResultToClient?: <T>(value: T) => T;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const refName = input.getRefName(ref);

    const baseArgs: Record<string, unknown> = {
      ...(args ?? {}),
      paginationOpts: {
        cursor: null,
        numItems: options.initialNumItems,
        ...(isPlainObject((args ?? {}).paginationOpts)
          ? ((args ?? {}).paginationOpts as Record<string, unknown>)
          : {}),
      },
    };

    const fireValue = (raw: unknown) => {
      try {
        const translated = toClientResult(
          raw,
          input.translateLocalResultToClient,
        );
        callback(
          translated,
          "Second argument to onUpdate callback is reserved for later use",
        );
      } catch (error) {
        const normalized = input.asError(error);
        if (onError) {
          onError(
            normalized,
            "Second argument to onUpdate onError is reserved for later use",
          );
        } else {
          void Promise.reject(normalized);
        }
      }
    };

    const fireError = (error: Error) => {
      const normalized = input.asError(error);
      if (onError) {
        onError(
          normalized,
          "Second argument to onUpdate onError is reserved for later use",
        );
      } else {
        void Promise.reject(normalized);
      }
    };

    const unsubscribe = input.pipeline.subscribe({
      refName,
      args: baseArgs,
      onValue: fireValue,
      onError: fireError,
    }) as any;

    unsubscribe.unsubscribe = unsubscribe;
    unsubscribe.getCurrentValue = () => {
      const raw = input.pipeline.getCurrentValue(refName, baseArgs);
      if (raw === undefined) return undefined;
      return toClientResult(raw, input.translateLocalResultToClient);
    };
    unsubscribe.getQueryLogs = () => undefined;
    return unsubscribe;
  };
}

function createRuntimeLocalOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const refName = input.getRefName(ref);
    void input.ensureReadReady?.(refName, args ?? {});
    const translatedArgs =
      input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
    const watch = input.runtime.watchLocalQuery(refName, translatedArgs);

    const notify = () => {
      try {
        callback(
          toClientResult(
            watch.localQueryResult(),
            input.translateLocalResultToClient,
          ),
          "Second argument to onUpdate callback is reserved for later use",
        );
      } catch (error) {
        const normalized = input.asError(error);
        if (onError) {
          onError(
            normalized,
            "Second argument to onUpdate onError is reserved for later use",
          );
        } else {
          void Promise.reject(normalized);
        }
      }
    };

    const unsubscribe = watch.onUpdate(notify) as any;
    unsubscribe.unsubscribe = unsubscribe;
    unsubscribe.getCurrentValue = () =>
      toClientResult(
        watch.localQueryResult(),
        input.translateLocalResultToClient,
      );
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function createRuntimeLocalPaginatedOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const refName = input.getRefName(ref);
    void input.ensureReadReady?.(refName, args ?? {});
    const translatedArgs =
      input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
    const watch = input.runtime.watchLocalPaginatedQuery(
      refName,
      translatedArgs,
      options,
    );

    const notify = () => {
      try {
        callback(
          toClientResult(
            watch.localQueryResult(),
            input.translateLocalResultToClient,
          ),
          "Second argument to onUpdate callback is reserved for later use",
        );
      } catch (error) {
        const normalized = input.asError(error);
        if (onError) {
          onError(
            normalized,
            "Second argument to onUpdate onError is reserved for later use",
          );
        } else {
          void Promise.reject(normalized);
        }
      }
    };

    const unsubscribe = watch.onUpdate(notify) as any;
    unsubscribe.unsubscribe = unsubscribe;
    unsubscribe.getCurrentValue = () =>
      toClientResult(
        watch.localQueryResult(),
        input.translateLocalResultToClient,
      );
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function patchBaseClientLocalQueryAccess(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  resolveReadPlanByName: (refName: string) => ReadPlan;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
  cache?: EmbeddedQueryCache | null;
}) {
  const baseClient = (input.client as any).client as any;
  if (!baseClient) {
    return;
  }

  const originalLocalQueryResult =
    baseClient.localQueryResult?.bind(baseClient);
  const originalLocalQueryLogs = baseClient.localQueryLogs?.bind(baseClient);

  if (typeof originalLocalQueryResult === "function") {
    baseClient.localQueryResult = (
      refName: string,
      args: Record<string, unknown>,
    ) => {
      if (input.resolveReadPlanByName(refName).kind !== "local") {
        return originalLocalQueryResult(refName, args);
      }

      if (input.cache && !isSystemRefName(refName)) {
        const cached = input.cache.get(refName, args ?? {});
        if (cached !== undefined) {
          return toClientResult(
            cached.value,
            input.translateLocalResultToClient,
          );
        }
      }

      const translatedArgs =
        input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
      void input.ensureReadReady?.(refName, args ?? {});
      const result = input.runtime
        .watchLocalQuery(refName, translatedArgs)
        .localQueryResult();
      return toClientResult(result, input.translateLocalResultToClient);
    };
  }

  if (typeof originalLocalQueryLogs === "function") {
    baseClient.localQueryLogs = (
      refName: string,
      args: Record<string, unknown>,
    ) => {
      if (input.resolveReadPlanByName(refName).kind !== "local") {
        return originalLocalQueryLogs(refName, args);
      }

      return input.runtime
        .watchLocalQuery(refName, args ?? {})
        .localQueryLogs();
    };
  }
}

function deferSubscription(input: {
  factory: () => Promise<any>;
  asError: (error: unknown) => Error;
  onInitError?: (error: Error) => void;
}): any {
  let inner: any = null;
  let cancelled = false;

  const unsubscribe = (() => {
    cancelled = true;
    if (typeof inner === "function") {
      inner();
    } else if (inner && typeof inner.unsubscribe === "function") {
      inner.unsubscribe();
    }
  }) as any;

  unsubscribe.unsubscribe = unsubscribe;
  unsubscribe.getCurrentValue = () => {
    if (inner && typeof inner.getCurrentValue === "function") {
      return inner.getCurrentValue();
    }
    return undefined;
  };
  unsubscribe.getQueryLogs = () => {
    if (inner && typeof inner.getQueryLogs === "function") {
      return inner.getQueryLogs();
    }
    return undefined;
  };

  void input
    .factory()
    .then(
      (actual) => {
        if (cancelled) {
          if (typeof actual === "function") {
            actual();
          } else if (actual && typeof actual.unsubscribe === "function") {
            actual.unsubscribe();
          }
          return;
        }
        inner = actual;
      },
      (error) => {
        const normalized = input.asError(error);
        if (input.onInitError) {
          try {
            input.onInitError(normalized);
            return;
          } catch {
            /* listener error */
          }
        }
        console.error(
          "[convex-embedded] failed to initialize subscription",
          normalized,
        );
      },
    )
    .catch((error: unknown) => {
      console.error("[adapter] deferSubscription:", error);
    });

  return unsubscribe;
}

type WaitUntilReady = <T>(run: () => Promise<T>) => Promise<T>;

export function patchRoutedConvexClient(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  remoteClient?: ConvexClient | null;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  resolveMutationPlan: (ref: unknown) => MutationPlan;
  resolveReadPlan: (ref: unknown) => ReadPlan;
  resolveReadPlanByName: (refName: string) => ReadPlan;
  executeLocalMutation: (
    ref: unknown,
    args: Record<string, unknown>,
    enqueueForReplay: boolean,
  ) => Promise<unknown>;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
  waitUntilReady?: WaitUntilReady;
  isReady?: () => boolean;
  connectivity?: ConnectivityAdapter;
  cache?: EmbeddedQueryCache | null;
  getCacheStorage?: () => QueryCacheStorage | null;
  knownTables?: ReadonlySet<string>;
}) {
  patchBaseClientLocalQueryAccess({
    client: input.client,
    runtime: input.runtime,
    resolveReadPlanByName: input.resolveReadPlanByName,
    ensureReadReady: input.ensureReadReady,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
    cache: input.cache ?? null,
  });

  const cache = input.cache ?? null;
  const getCacheStorage = input.getCacheStorage ?? (() => null);
  const remoteClient = input.remoteClient ?? null;

  const explicitOptimistic = new WeakMap<
    object,
    (
      store: { getQuery: (refName: string, args: unknown) => unknown },
      args: Record<string, unknown>,
    ) => Array<{ refName: string; args: unknown; value: unknown }>
  >();

  const lookupExplicitOptimistic = (
    ref: unknown,
  ):
    | ((
        store: { getQuery: (refName: string, args: unknown) => unknown },
        args: Record<string, unknown>,
      ) => Array<{ refName: string; args: unknown; value: unknown }>)
    | undefined => {
    if (typeof ref !== "object" || ref === null) return undefined;
    return explicitOptimistic.get(ref);
  };

  const pipeline = cache
    ? new CachePipeline({
        cache,
        getCacheStorage,
        remoteClient,
        connectivity: input.connectivity,
        asError: input.asError,
        runtime: input.runtime,
        translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
      })
    : null;

  const runtimeLocalOnUpdate = createRuntimeLocalOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
    ensureReadReady: input.ensureReadReady,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });
  const runtimeLocalPaginatedOnUpdate = createRuntimeLocalPaginatedOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
    ensureReadReady: input.ensureReadReady,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });
  const cacheOnUpdate = pipeline
    ? createCacheOnUpdate({
        pipeline,
        getRefName: input.getRefName,
        asError: input.asError,
        translateLocalResultToClient: input.translateLocalResultToClient,
      })
    : null;
  const cachePaginatedOnUpdate = pipeline
    ? createCachePaginatedOnUpdate({
        pipeline,
        getRefName: input.getRefName,
        asError: input.asError,
        translateLocalResultToClient: input.translateLocalResultToClient,
      })
    : null;

  const localOnUpdate = (...args: any[]): any => {
    const refName = input.getRefName(args[0]);
    if (cacheOnUpdate && !isSystemRefName(refName)) {
      return cacheOnUpdate(args[0], args[1], args[2], args[3]);
    }
    return runtimeLocalOnUpdate(args[0], args[1], args[2], args[3]);
  };

  const localPaginatedOnUpdate = (...args: any[]): any => {
    const refName = input.getRefName(args[0]);
    if (cachePaginatedOnUpdate && !isSystemRefName(refName)) {
      return cachePaginatedOnUpdate(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
      );
    }
    return runtimeLocalPaginatedOnUpdate(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
    );
  };

  const waitUntilReady = input.waitUntilReady ?? ((run) => run());
  const isReady = input.isReady ?? (() => true);

  const executeLocalRead = async (
    ref: unknown,
    args: Record<string, unknown>,
    kind: "query" | "action",
  ) => {
    const translatedArgs = input.translateLocalArgsToRuntime?.(args) ?? args;
    try {
      const result = await input.runtime.executeLocal({
        kind,
        path: input.getRefName(ref),
        args: translatedArgs,
      });
      return toClientResult(result, input.translateLocalResultToClient);
    } catch (error) {
      throw input.asError(error);
    }
  };

  const createSubscriptionFactory = (
    localSubscribe: (...args: any[]) => any,
    remoteSubscribe: (...args: any[]) => any,
    errorArgIndex: number,
  ) => {
    const subscribeWithRoute = (...args: any[]): any => {
      const route = input.resolveReadPlan(args[0]);
      if (route.kind === "local") {
        return localSubscribe(...args);
      }
      if (route.kind === "error") {
        throw route.error;
      }

      if (isConnectivityOffline(input.connectivity)) {
        let error: Error;
        try {
          assertRemotePlanOnline(route, input.connectivity);
          error = new Error("unreachable");
        } catch (current) {
          error = input.asError(current);
        }
        const onError = args[errorArgIndex];
        if (typeof onError === "function") {
          onError(error);
          return createNoopUnsubscribe();
        }
        throw error;
      }

      return remoteSubscribe(...args);
    };

    return (...args: any[]): any => {
      if (isReady()) {
        return subscribeWithRoute(...args);
      }

      const onInitError = args[errorArgIndex];
      return deferSubscription({
        factory: () => waitUntilReady(async () => subscribeWithRoute(...args)),
        asError: input.asError,
        onInitError:
          typeof onInitError === "function" ? onInitError : undefined,
      });
    };
  };

  (input.client as any).mutation = function patchedMutation(
    ...args: Parameters<typeof input.client.mutation>
  ): Promise<any> {
    if (pipeline) {
      try {
        const ref = args[0];
        const argsObj = (args[1] ?? {}) as Record<string, unknown>;
        const refName = input.getRefName(ref);
        const explicit = lookupExplicitOptimistic(ref);
        const updates = explicit
          ? explicit({ getQuery: pipeline.getCurrentValue.bind(pipeline) }, argsObj)
          : (() => {
              const effect = deriveOptimisticEffect({
                refName,
                args: argsObj,
                knownTables: input.knownTables,
              });
              if (!effect) return [];
              return effectToTransitions(effect, cache!);
            })();
        if (updates.length > 0) {
          pipeline.applyOptimisticTransition(updates);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[convex-embedded] optimistic apply failed:", error);
      }
    }

    return waitUntilReady(async () => {
      const route = input.resolveMutationPlan(args[0]);
      if (route.kind === "error") {
        throw route.error;
      }
      if (route.kind === "local") {
        try {
          return await input.executeLocalMutation(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
            route.enqueueForReplay,
          );
        } catch (error) {
          throw input.asError(error);
        }
      }

      try {
        assertRemotePlanOnline(route, input.connectivity);
        if (!remoteClient) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote mutation execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "mutation",
          });
        }
        return await (remoteClient as any).mutation(...args);
      } catch (error) {
        throw input.asError(error);
      }
    });
  };

  (input.client as any).query = function patchedQuery(
    ...args: Parameters<typeof input.client.query>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveReadPlan(args[0]);
      if (route.kind === "error") {
        throw route.error;
      }
      if (route.kind === "local") {
        try {
          await input.ensureReadReady?.(
            input.getRefName(args[0]),
            (args[1] ?? {}) as Record<string, unknown>,
          );
          return await executeLocalRead(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
            "query",
          );
        } catch (error) {
          throw input.asError(error);
        }
      }

      try {
        assertRemotePlanOnline(route, input.connectivity);
        if (!remoteClient) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote query execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "query",
          });
        }
        return await (remoteClient as any).query(...args);
      } catch (error) {
        throw input.asError(error);
      }
    });
  };

  (input.client as any).action = function patchedAction(
    ...args: Parameters<typeof input.client.action>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveReadPlan(args[0]);
      if (route.kind === "error") {
        throw route.error;
      }
      if (route.kind === "local") {
        try {
          await input.ensureReadReady?.(
            input.getRefName(args[0]),
            (args[1] ?? {}) as Record<string, unknown>,
          );
          return await executeLocalRead(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
            "action",
          );
        } catch (error) {
          throw input.asError(error);
        }
      }

      try {
        assertRemotePlanOnline(route, input.connectivity);
        if (!remoteClient) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote action execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "action",
          });
        }
        return await (remoteClient as any).action(...args);
      } catch (error) {
        throw input.asError(error);
      }
    });
  };

  (input.client as any).onUpdate = createSubscriptionFactory(
    localOnUpdate,
    remoteClient
      ? (remoteClient as any).onUpdate.bind(remoteClient)
      : () => createNoopUnsubscribe(),
    3,
  );

  (input.client as any).peekCurrentValue = (
    ref: unknown,
    args: unknown,
  ): unknown => {
    if (!pipeline) return undefined;
    const refName = input.getRefName(ref);
    const raw = pipeline.getCurrentValue(refName, args ?? {});
    if (raw === undefined) return undefined;
    return toClientResult(raw, input.translateLocalResultToClient);
  };

  (input.client as any).peekPaginatedCurrentValue = (
    ref: unknown,
    args: unknown,
    options: { initialNumItems: number },
  ): unknown => {
    if (!pipeline) return undefined;
    const refName = input.getRefName(ref);
    const argRecord = (args ?? {}) as Record<string, unknown>;
    const existingPaginationOpts = isPlainObject(argRecord.paginationOpts)
      ? (argRecord.paginationOpts as Record<string, unknown>)
      : {};
    const baseArgs: Record<string, unknown> = {
      ...argRecord,
      paginationOpts: {
        cursor: null,
        numItems: options.initialNumItems,
        ...existingPaginationOpts,
      },
    };
    const raw = pipeline.getCurrentValue(refName, baseArgs);
    if (raw === undefined) return undefined;
    return toClientResult(raw, input.translateLocalResultToClient);
  };

  (input.client as any).applyOptimisticTransition = (
    updates: Array<{ refName: string; args: unknown; value: unknown }>,
  ): void => {
    if (!pipeline) return;
    pipeline.applyOptimisticTransition(updates);
  };

  (input.client as any).registerOptimisticUpdate = (
    ref: unknown,
    callback: (
      store: { getQuery: (refName: string, args: unknown) => unknown },
      args: Record<string, unknown>,
    ) => Array<{ refName: string; args: unknown; value: unknown }>,
  ): void => {
    if (typeof ref !== "object" || ref === null) return;
    explicitOptimistic.set(ref, callback);
  };

  (input.client as any).setOptimisticDeferredScheduler = (
    scheduler: (fn: () => void) => void,
  ): void => {
    pipeline?.setDeferredScheduler(scheduler);
  };

  (input.client as any).setWorkScheduler = (
    scheduler: WorkScheduler | null,
  ): void => {
    pipeline?.setWorkScheduler(scheduler);
  };

  (input.client as any).getWorkScheduler = (): WorkScheduler | undefined =>
    pipeline?.getWorkScheduler();

  (input.client as any).applyOptimisticEffects = (
    effects: ReadonlyArray<{ kind: string }>,
  ): void => {
    if (!pipeline || !cache) return;
    const transitions: Array<{
      refName: string;
      args: unknown;
      value: unknown;
      priority?: "discrete" | "transition";
    }> = [];
    for (const effect of effects) {
      const updates = effectToTransitions(
        effect as Parameters<typeof effectToTransitions>[0],
        cache,
      );
      for (const update of updates) transitions.push(update);
    }
    if (transitions.length > 0) {
      pipeline.applyOptimisticTransition(transitions);
    }
  };

  if (
    typeof (input.client as any).onPaginatedUpdate_experimental === "function"
  ) {
    (input.client as any).onPaginatedUpdate_experimental =
      createSubscriptionFactory(
        localPaginatedOnUpdate,
        remoteClient
          ? (remoteClient as any).onPaginatedUpdate_experimental.bind(
              remoteClient,
            )
          : () => createNoopUnsubscribe(),
        4,
      );
  }
}
