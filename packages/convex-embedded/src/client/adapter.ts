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
import { nowMs } from "@/shared/perf";
import { stableValueKey } from "@/shared/valuekey";
import { withSpanSync } from "@/tracing/spans";

import { effectToTransitions } from "@/client/optimistic/apply";
import { deriveOptimisticEffect } from "@/client/optimistic/derive";

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

function wouldShrinkRemoteResult(
  previous: unknown,
  next: unknown,
): boolean {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return next.length < previous.length;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    if (Array.isArray(previous.page) && Array.isArray(next.page)) {
      return next.page.length < previous.page.length;
    }
  }
  return false;
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

function getStringId(value: unknown): string | null {
  return isPlainObject(value) && typeof value._id === "string"
    ? value._id
    : null;
}

function dedupeTranslatedArray(
  rawValues: unknown[],
  translatedValues: unknown[],
): unknown[] {
  const groups = new Map<
    string,
    { indexes: number[]; rawIds: Set<string>; translatedIds: Set<string> }
  >();

  for (let index = 0; index < translatedValues.length; index += 1) {
    const translatedId = getStringId(translatedValues[index]);
    if (translatedId === null) {
      continue;
    }
    const rawId = getStringId(rawValues[index]);
    const group = groups.get(translatedId) ?? {
      indexes: [],
      rawIds: new Set<string>(),
      translatedIds: new Set<string>(),
    };
    group.indexes.push(index);
    group.translatedIds.add(translatedId);
    if (rawId !== null) {
      group.rawIds.add(rawId);
    }
    groups.set(translatedId, group);
  }

  const keep = new Set<number>(translatedValues.map((_, index) => index));
  let changed = false;

  for (const group of groups.values()) {
    if (group.indexes.length < 2) {
      continue;
    }

    if (group.rawIds.size <= 1 && group.translatedIds.size === 1) {
      continue;
    }

    changed = true;
    const lastIndex = group.indexes[group.indexes.length - 1]!;
    for (const index of group.indexes) {
      if (index !== lastIndex) {
        keep.delete(index);
      }
    }
  }

  return changed
    ? translatedValues.filter((_, index) => keep.has(index))
    : translatedValues;
}

function normalizeClientResult(
  rawValue: unknown,
  translatedValue: unknown,
): unknown {
  if (Array.isArray(translatedValue)) {
    const rawItems = Array.isArray(rawValue) ? rawValue : [];
    const normalizedItems = translatedValue.map((entryValue, index) =>
      normalizeClientResult(rawItems[index], entryValue),
    );
    return dedupeTranslatedArray(rawItems, normalizedItems);
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
  remoteUnsubscribe: (() => void) | null;
  storageLoadPromise: Promise<void> | null;
  localUnsubscribe: (() => void) | null;
}

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

  setDeferredScheduler(scheduler: (fn: () => void) => void): void {
    this.deferredScheduler =
      typeof scheduler === "function" ? scheduler : (fn) => fn();
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
        remoteUnsubscribe: null,
        storageLoadPromise: null,
        localUnsubscribe: null,
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
    const cached = this.config.cache.get(entry.refName, entry.args);
    if (cached) {
      entry.currentValue = cached.value;
      entry.hasValue = true;
    } else if (this.config.getCacheStorage()) {
      entry.storageLoadPromise = this.loadFromStorage(entry).catch(() => {
        /* swallow */
      });
    }

    if (
      this.config.remoteClient &&
      !isConnectivityOffline(this.config.connectivity)
    ) {
      this.openRemoteSubscription(entry);
    }

    this.openLocalWatch(entry);
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
          try {
            result = watch.localQueryResult();
          } catch {
            span.setAttributes({ "convex.cache.skip": "throw" });
            return;
          }
          if (result === undefined) {
            span.setAttributes({ "convex.cache.skip": "undefined" });
            return;
          }
          const previous = this.config.cache.get(entry.refName, entry.args);
          if (
            previous !== undefined &&
            wouldShrinkRemoteResult(previous.value, result)
          ) {
            span.setAttributes({ "convex.cache.skip": "shrink" });
            return;
          }
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
          const valueChanged =
            !entry.hasValue || !structuralEqual(entry.currentValue, result);
          entry.currentValue = result;
          entry.hasValue = true;
          if (changed) {
            void this.persistEntry(entry, nextEntry);
          }
          span.setAttributes({
            "convex.cache.ref": entry.refName,
            "convex.cache.value_changed": valueChanged,
            "convex.cache.eval_ms": +(nowMs() - startedAt).toFixed(2),
          });
          if (valueChanged) {
            this.notifyListeners(entry);
          }
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

    const handlePush = (value: unknown) => {
      if (!this.active.has(entry.argsKey)) return;
      const previous = this.config.cache.get(entry.refName, entry.args);
      const nextEntry: CachedEntry = {
        value,
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
      const valueChanged =
        !entry.hasValue || !structuralEqual(entry.currentValue, value);
      entry.currentValue = value;
      entry.hasValue = true;
      if (changed) {
        void this.persistEntry(entry, nextEntry);
      }
      this.extractDocsToStore(entry.refName, value);
      if (valueChanged) {
        this.notifyListeners(entry);
      }
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

  private extractDocsToStore(refName: string, value: unknown): void {
    const tableName = refName.split(":")[0];
    if (!tableName || tableName.startsWith("_")) return;
    const docs: Array<Record<string, unknown>> = [];
    collectDocs(value, docs);
    if (docs.length === 0) return;
    const runtime = this.config.runtime;
    if (!runtime || typeof runtime.upsertDocsFromCache !== "function") return;
    void runtime.upsertDocsFromCache(tableName, docs).catch(() => {
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
    // eslint-disable-next-line no-console
    console.log(
      `[notify] ${entry.refName} listeners=${entry.listeners.size} ts=${nowMs().toFixed(1)}`,
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
