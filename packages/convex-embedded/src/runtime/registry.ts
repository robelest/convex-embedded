import type { ProtocolChange } from "@/replication/protocol";
import type { SubscriptionManager } from "@/replication/subscriptions";
import type { QueryDependency } from "@/runtime/db/types";
import { structuralEqual } from "@/shared/equals";

export type QueryEvaluation = {
  result: unknown;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
  logs?: string[];
};

/**
 * Thrown by `_evaluateLocalQuery` and `_evaluateLocalPaginatedWatch` when the
 * underlying UDF rejects. Carries the partial dependency tracking the query
 * accumulated before the throw so the observer registry can still subscribe to
 * those tables — without this, an observer that errored on its first eval
 * would subscribe to nothing and never re-evaluate when the missing data
 * finally lands.
 */
export class LocalQueryEvaluationError extends Error {
  readonly partialTablesRead: Set<string>;
  readonly partialDependencies: QueryDependency[];

  constructor(
    cause: unknown,
    partialTablesRead: Set<string>,
    partialDependencies: QueryDependency[],
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "LocalQueryEvaluationError";
    this.cause = cause;
    this.partialTablesRead = partialTablesRead;
    this.partialDependencies = partialDependencies;
  }
}

type QueryObserverStateInput = {
  result: unknown;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
  logs?: string[];
};

export interface RuntimeQueryObserver<TMeta> {
  token: string;
  meta: TMeta;
  evaluate: () => Promise<QueryEvaluation>;
  listeners: Set<() => void>;
  currentValue: unknown;
  currentError: Error | null;
  currentLogs: string[] | undefined;
  hasValue: boolean;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
  evaluation: Promise<void> | null;
  needsReevaluation: boolean;
  manualRefresh: boolean;
  depVersions: Map<string, number> | null;
  pendingDelete: boolean;
}

export type TableVersionGetter = (tableName: string) => number;

let globalStateVersion = 0;

function bumpIfChanged<TMeta>(observer: RuntimeQueryObserver<TMeta>): void {
  const ext = observer as RuntimeQueryObserver<TMeta> & {
    _prevValue?: unknown;
    _prevError?: Error | null;
    _prevHasValue?: boolean;
    _stateVersion?: number;
  };

  const valueChanged =
    ext._prevHasValue !== observer.hasValue ||
    ext._prevError !== observer.currentError ||
    !structuralEqual(ext._prevValue, observer.currentValue);

  if (valueChanged) {
    ext._prevValue = observer.currentValue;
    ext._prevError = observer.currentError;
    ext._prevHasValue = observer.hasValue;
    ext._stateVersion = ++globalStateVersion;
  }
}

function stateChanged<TMeta>(observer: RuntimeQueryObserver<TMeta>): boolean {
  const ext = observer as RuntimeQueryObserver<TMeta> & {
    _stateVersion?: number;
    _notifiedVersion?: number;
  };

  bumpIfChanged(observer);

  const version = ext._stateVersion ?? 0;
  const notified = ext._notifiedVersion ?? -1;
  if (version !== notified) {
    ext._notifiedVersion = version;
    return true;
  }
  return false;
}

export interface RuntimeQueryObserverRegistry<TMeta> {
  ensure(
    token: string,
    meta: TMeta,
    evaluate: () => Promise<QueryEvaluation>,
    options?: { manualRefresh?: boolean },
  ): RuntimeQueryObserver<TMeta>;
  get(token: string): RuntimeQueryObserver<TMeta> | undefined;
  values(): RuntimeQueryObserver<TMeta>[];
  subscribe(token: string, callback: () => void): () => void;
  refresh(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
  ): Promise<void>;
  replicationState(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
    state: QueryObserverStateInput,
    options?: { notify?: boolean },
  ): void;
  track(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
    tracking: { tablesRead: Set<string>; dependencies: QueryDependency[] },
  ): void;
  refreshAll(): Promise<void>;
  getRelevantObservers(
    changesOrTables: Set<string> | ProtocolChange[],
  ): RuntimeQueryObserver<TMeta>[];
  delete(token: string): void;
  clear(): void;
}

export function createRuntimeQueryObserverRegistry<TMeta>(
  subscriptions: SubscriptionManager,
  getTableVersion: TableVersionGetter = () => 0,
): RuntimeQueryObserverRegistry<TMeta> {
  const entries = new Map<
    string,
    { observer: RuntimeQueryObserver<TMeta>; unsubscribe: () => void }
  >();

  function captureDepVersions(observer: RuntimeQueryObserver<TMeta>): void {
    if (observer.tablesRead.size === 0) {
      observer.depVersions = new Map();
      return;
    }
    const versions = new Map<string, number>();
    for (const tableName of observer.tablesRead) {
      versions.set(tableName, getTableVersion(tableName));
    }
    observer.depVersions = versions;
  }

  function invalidateCallback(
    observer: RuntimeQueryObserver<TMeta>,
  ): () => void {
    if (observer.manualRefresh) {
      return () => undefined;
    }
    return () => {
      void registry.refresh(observer);
    };
  }

  const registry: RuntimeQueryObserverRegistry<TMeta> = {
    ensure(token, meta, evaluate, options): RuntimeQueryObserver<TMeta> {
      const existing = entries.get(token)?.observer;
      if (existing) {
        existing.meta = meta;
        existing.evaluate = evaluate;
        return existing;
      }

      const observer: RuntimeQueryObserver<TMeta> = {
        token,
        meta,
        evaluate,
        listeners: new Set(),
        currentValue: undefined,
        currentError: null,
        currentLogs: undefined,
        hasValue: false,
        tablesRead: new Set(),
        dependencies: [],
        evaluation: null,
        needsReevaluation: false,
        manualRefresh: options?.manualRefresh ?? false,
        depVersions: null,
        pendingDelete: false,
      };

      entries.set(token, {
        observer,
        unsubscribe: subscriptions.subscribe(
          token,
          new Set(),
          [],
          invalidateCallback(observer),
        ),
      });
      return observer;
    },
    get(token) {
      return entries.get(token)?.observer;
    },
    values() {
      return [...entries.values()].map((entry) => entry.observer);
    },
    subscribe(token, callback) {
      const observer = entries.get(token)?.observer;
      if (!observer) {
        return () => {};
      }
      observer.listeners.add(callback);
      observer.pendingDelete = false;
      return () => {
        observer.listeners.delete(callback);
        if (observer.listeners.size === 0) {
          observer.pendingDelete = true;
          const entry = entries.get(token);
          entry?.unsubscribe();
          entries.delete(token);
        }
      };
    },
    async refresh(tokenOrObserver) {
      const observer =
        typeof tokenOrObserver === "string"
          ? entries.get(tokenOrObserver)?.observer
          : tokenOrObserver;
      if (!observer) {
        return;
      }

      if (observer.evaluation) {
        observer.needsReevaluation = true;
        await observer.evaluation;
        return;
      }

      if (
        observer.hasValue &&
        observer.currentError === null &&
        observer.depVersions !== null
      ) {
        let stillFresh = true;
        for (const [tableName, version] of observer.depVersions) {
          if (getTableVersion(tableName) !== version) {
            stillFresh = false;
            break;
          }
        }
        if (stillFresh) {
          return;
        }
      }

      observer.evaluation = (async () => {
        do {
          observer.needsReevaluation = false;
          if (observer.pendingDelete) return;
          const versionsBefore = new Map<string, number>();
          for (const table of observer.tablesRead) {
            versionsBefore.set(table, getTableVersion(table));
          }
          try {
            const evaluation = await observer.evaluate();
            if (observer.pendingDelete) return;
            registry.replicationState(observer, evaluation, { notify: false });
            captureDepVersions(observer);
          } catch (error) {
            if (observer.pendingDelete) return;
            observer.currentValue = undefined;
            observer.currentError =
              error instanceof Error ? error : new Error(String(error));
            observer.currentLogs = [observer.currentError.message];
            observer.hasValue = true;
            const partialTablesRead =
              error instanceof LocalQueryEvaluationError
                ? error.partialTablesRead
                : new Set<string>();
            observer.tablesRead = partialTablesRead;
            observer.dependencies = [];
            observer.depVersions = null;
            const entry = entries.get(observer.token);
            entry?.unsubscribe();
            entries.set(observer.token, {
              observer,
              unsubscribe: subscriptions.subscribe(
                observer.token,
                partialTablesRead,
                [],
                invalidateCallback(observer),
              ),
            });
            for (const table of partialTablesRead) {
              const before = versionsBefore.get(table);
              const after = getTableVersion(table);
              if (before === undefined ? after > 0 : before !== after) {
                observer.needsReevaluation = true;
                break;
              }
            }
          }

          if (observer.pendingDelete) return;
          if (stateChanged(observer)) {
            for (const listener of Array.from(observer.listeners)) {
              listener();
            }
          }
        } while (observer.needsReevaluation);
      })().finally(() => {
        observer.evaluation = null;
        if (!observer.pendingDelete && observer.needsReevaluation) {
          void registry.refresh(observer);
        }
      });

      await observer.evaluation;
    },
    replicationState(tokenOrObserver, state, options = {}) {
      const observer =
        typeof tokenOrObserver === "string"
          ? entries.get(tokenOrObserver)?.observer
          : tokenOrObserver;
      if (!observer) {
        return;
      }

      observer.currentValue = state.result;
      observer.currentError = null;
      observer.currentLogs = state.logs;
      observer.hasValue = true;
      observer.tablesRead = state.tablesRead;
      observer.dependencies = state.dependencies;

      const entry = entries.get(observer.token);
      entry?.unsubscribe();
      entries.set(observer.token, {
        observer,
        unsubscribe: subscriptions.subscribe(
          observer.token,
          state.tablesRead,
          state.dependencies,
          invalidateCallback(observer),
        ),
      });

      if ((options.notify ?? true) && stateChanged(observer)) {
        for (const listener of Array.from(observer.listeners)) {
          listener();
        }
      }
    },
    track(tokenOrObserver, tracking) {
      const observer =
        typeof tokenOrObserver === "string"
          ? entries.get(tokenOrObserver)?.observer
          : tokenOrObserver;
      if (!observer) {
        return;
      }

      observer.tablesRead = tracking.tablesRead;
      observer.dependencies = tracking.dependencies;
      captureDepVersions(observer);

      const entry = entries.get(observer.token);
      entry?.unsubscribe();
      entries.set(observer.token, {
        observer,
        unsubscribe: subscriptions.subscribe(
          observer.token,
          tracking.tablesRead,
          tracking.dependencies,
          invalidateCallback(observer),
        ),
      });
    },
    async refreshAll() {
      const observers = registry.values();
      await Promise.all(
        observers.map((observer) =>
          registry.refresh(observer).catch(() => undefined),
        ),
      );
    },
    getRelevantObservers(changesOrTables) {
      const relevantTokens =
        subscriptions.gatherRelevantTokens(changesOrTables);
      return [...relevantTokens]
        .map((token) => entries.get(token)?.observer)
        .filter(
          (observer): observer is RuntimeQueryObserver<TMeta> =>
            observer !== undefined,
        );
    },
    delete(token) {
      const entry = entries.get(token);
      if (!entry) {
        return;
      }
      entry.unsubscribe();
      entries.delete(token);
    },
    clear() {
      for (const token of Array.from(entries.keys())) {
        registry.delete(token);
      }
    },
  };

  return registry;
}

export interface ProtocolQueryRecord {
  queryId: number;
  udfPath: string;
  args: unknown[];
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
}

type SessionQueries = {
  queryIds: Set<number>;
};

function tokenFor(sessionId: string, queryId: number): string {
  return `${sessionId}:${queryId}`;
}

export interface RuntimeProtocolQueryRegistry {
  getAllObservers(
    sessionId: string,
  ): RuntimeQueryObserver<ProtocolQueryRecord>[];
  hasQueries(sessionId: string): boolean;
  ensure(
    sessionId: string,
    query: ProtocolQueryRecord,
    evaluate: () => Promise<QueryEvaluation>,
  ): RuntimeQueryObserver<ProtocolQueryRecord>;
  track(
    sessionId: string,
    queryId: number,
    tracking: { tablesRead: Set<string>; dependencies: QueryDependency[] },
  ): void;
  delete(sessionId: string, queryId: number): void;
  clearSession(sessionId: string): void;
  clear(): void;
  getRelevantObservers(
    sessionId: string,
    affectedTables?: Set<string>,
    affectedChanges?: ProtocolChange[] | null,
  ): RuntimeQueryObserver<ProtocolQueryRecord>[];
}

export function createRuntimeProtocolQueryRegistry(
  observers: RuntimeQueryObserverRegistry<ProtocolQueryRecord>,
): RuntimeProtocolQueryRegistry {
  const sessions = new Map<string, SessionQueries>();

  function getOrCreateSession(sessionId: string): SessionQueries {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { queryIds: new Set() };
      sessions.set(sessionId, session);
    }
    return session;
  }

  const registry: RuntimeProtocolQueryRegistry = {
    getAllObservers(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return [];
      }
      return [...session.queryIds]
        .map((queryId) => observers.get(tokenFor(sessionId, queryId)))
        .filter(
          (observer): observer is RuntimeQueryObserver<ProtocolQueryRecord> =>
            observer !== undefined,
        );
    },
    hasQueries(sessionId) {
      return (sessions.get(sessionId)?.queryIds.size ?? 0) > 0;
    },
    ensure(sessionId, query, evaluate) {
      const session = getOrCreateSession(sessionId);
      session.queryIds.add(query.queryId);
      return observers.ensure(
        tokenFor(sessionId, query.queryId),
        query,
        evaluate,
        { manualRefresh: true },
      );
    },
    track(sessionId, queryId, tracking) {
      const observer = observers.get(tokenFor(sessionId, queryId));
      if (!observer) {
        return;
      }
      observers.track(observer, tracking);
    },
    delete(sessionId, queryId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      session.queryIds.delete(queryId);
      observers.delete(tokenFor(sessionId, queryId));
      if (session.queryIds.size === 0) {
        sessions.delete(sessionId);
      }
    },
    clearSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return;
      }
      for (const queryId of session.queryIds) {
        observers.delete(tokenFor(sessionId, queryId));
      }
      sessions.delete(sessionId);
    },
    clear() {
      for (const sessionId of Array.from(sessions.keys())) {
        registry.clearSession(sessionId);
      }
    },
    getRelevantObservers(sessionId, affectedTables, affectedChanges) {
      if (!sessions.has(sessionId)) {
        return [];
      }
      if (affectedTables === undefined) {
        return registry.getAllObservers(sessionId);
      }
      const session = sessions.get(sessionId)!;
      return observers
        .getRelevantObservers(affectedChanges ?? affectedTables)
        .filter((observer) => session.queryIds.has(observer.meta.queryId));
    },
  };

  return registry;
}
