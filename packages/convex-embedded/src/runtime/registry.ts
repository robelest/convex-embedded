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

export class RuntimeQueryObserverRegistry<TMeta> {
  private readonly _entries = new Map<
    string,
    { observer: RuntimeQueryObserver<TMeta>; unsubscribe: () => void }
  >();

  constructor(
    private readonly _subscriptions: SubscriptionManager,
    private readonly _getTableVersion: TableVersionGetter = () => 0,
  ) {}

  ensure(
    token: string,
    meta: TMeta,
    evaluate: () => Promise<QueryEvaluation>,
    options?: { manualRefresh?: boolean },
  ): RuntimeQueryObserver<TMeta> {
    const existing = this._entries.get(token)?.observer;
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

    this._entries.set(token, {
      observer,
      unsubscribe: this._subscriptions.subscribe(
        token,
        new Set(),
        [],
        this._invalidateCallback(observer),
      ),
    });
    return observer;
  }

  private _invalidateCallback(
    observer: RuntimeQueryObserver<TMeta>,
  ): () => void {
    if (observer.manualRefresh) {
      return () => undefined;
    }
    return () => {
      void this.refresh(observer);
    };
  }

  private _captureDepVersions(observer: RuntimeQueryObserver<TMeta>): void {
    if (observer.tablesRead.size === 0) {
      observer.depVersions = new Map();
      return;
    }
    const versions = new Map<string, number>();
    for (const tableName of observer.tablesRead) {
      versions.set(tableName, this._getTableVersion(tableName));
    }
    observer.depVersions = versions;
  }

  get(token: string): RuntimeQueryObserver<TMeta> | undefined {
    return this._entries.get(token)?.observer;
  }

  values(): RuntimeQueryObserver<TMeta>[] {
    return [...this._entries.values()].map((entry) => entry.observer);
  }

  subscribe(token: string, callback: () => void): () => void {
    const observer = this._entries.get(token)?.observer;
    if (!observer) {
      return () => {};
    }
    observer.listeners.add(callback);
    observer.pendingDelete = false;
    return () => {
      observer.listeners.delete(callback);
      if (observer.listeners.size === 0) {
        observer.pendingDelete = true;
        const entry = this._entries.get(token);
        entry?.unsubscribe();
        this._entries.delete(token);
      }
    };
  }

  async refresh(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
  ): Promise<void> {
    const observer =
      typeof tokenOrObserver === "string"
        ? this._entries.get(tokenOrObserver)?.observer
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
        if (this._getTableVersion(tableName) !== version) {
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
          versionsBefore.set(table, this._getTableVersion(table));
        }
        try {
          const evaluation = await observer.evaluate();
          if (observer.pendingDelete) return;
          this.replicationState(observer, evaluation, { notify: false });
          this._captureDepVersions(observer);
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
          const entry = this._entries.get(observer.token);
          entry?.unsubscribe();
          this._entries.set(observer.token, {
            observer,
            unsubscribe: this._subscriptions.subscribe(
              observer.token,
              partialTablesRead,
              [],
              this._invalidateCallback(observer),
            ),
          });
          for (const table of partialTablesRead) {
            const before = versionsBefore.get(table);
            const after = this._getTableVersion(table);
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
        void this.refresh(observer);
      }
    });

    await observer.evaluation;
  }

  replicationState(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
    state: QueryObserverStateInput,
    options: { notify?: boolean } = {},
  ): void {
    const observer =
      typeof tokenOrObserver === "string"
        ? this._entries.get(tokenOrObserver)?.observer
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

    const entry = this._entries.get(observer.token);
    entry?.unsubscribe();
    this._entries.set(observer.token, {
      observer,
      unsubscribe: this._subscriptions.subscribe(
        observer.token,
        state.tablesRead,
        state.dependencies,
        this._invalidateCallback(observer),
      ),
    });

    if ((options.notify ?? true) && stateChanged(observer)) {
      for (const listener of Array.from(observer.listeners)) {
        listener();
      }
    }
  }

  track(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
    tracking: { tablesRead: Set<string>; dependencies: QueryDependency[] },
  ): void {
    const observer =
      typeof tokenOrObserver === "string"
        ? this._entries.get(tokenOrObserver)?.observer
        : tokenOrObserver;
    if (!observer) {
      return;
    }

    observer.tablesRead = tracking.tablesRead;
    observer.dependencies = tracking.dependencies;
    this._captureDepVersions(observer);

    const entry = this._entries.get(observer.token);
    entry?.unsubscribe();
    this._entries.set(observer.token, {
      observer,
      unsubscribe: this._subscriptions.subscribe(
        observer.token,
        tracking.tablesRead,
        tracking.dependencies,
        this._invalidateCallback(observer),
      ),
    });
  }

  async refreshAll(): Promise<void> {
    const observers = this.values();
    await Promise.all(
      observers.map((observer) =>
        this.refresh(observer).catch(() => undefined),
      ),
    );
  }

  getRelevantObservers(
    changesOrTables: Set<string> | ProtocolChange[],
  ): RuntimeQueryObserver<TMeta>[] {
    const relevantTokens =
      this._subscriptions.gatherRelevantTokens(changesOrTables);
    return [...relevantTokens]
      .map((token) => this._entries.get(token)?.observer)
      .filter(
        (observer): observer is RuntimeQueryObserver<TMeta> =>
          observer !== undefined,
      );
  }

  delete(token: string): void {
    const entry = this._entries.get(token);
    if (!entry) {
      return;
    }
    entry.unsubscribe();
    this._entries.delete(token);
  }

  clear(): void {
    for (const token of Array.from(this._entries.keys())) {
      this.delete(token);
    }
  }
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

export class RuntimeProtocolQueryRegistry {
  private readonly _sessions = new Map<string, SessionQueries>();
  private readonly _observers: RuntimeQueryObserverRegistry<ProtocolQueryRecord>;

  constructor(
    observersOrSubscriptions:
      | RuntimeQueryObserverRegistry<ProtocolQueryRecord>
      | SubscriptionManager,
  ) {
    this._observers =
      observersOrSubscriptions instanceof RuntimeQueryObserverRegistry
        ? observersOrSubscriptions
        : new RuntimeQueryObserverRegistry(observersOrSubscriptions);
  }

  getAllObservers(
    sessionId: string,
  ): RuntimeQueryObserver<ProtocolQueryRecord>[] {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return [...session.queryIds]
      .map((queryId) => this._observers.get(tokenFor(sessionId, queryId)))
      .filter(
        (observer): observer is RuntimeQueryObserver<ProtocolQueryRecord> =>
          observer !== undefined,
      );
  }

  hasQueries(sessionId: string): boolean {
    return (this._sessions.get(sessionId)?.queryIds.size ?? 0) > 0;
  }

  ensure(
    sessionId: string,
    query: ProtocolQueryRecord,
    evaluate: () => Promise<QueryEvaluation>,
  ): RuntimeQueryObserver<ProtocolQueryRecord> {
    const session = this._getOrCreateSession(sessionId);
    session.queryIds.add(query.queryId);
    return this._observers.ensure(
      tokenFor(sessionId, query.queryId),
      query,
      evaluate,
      { manualRefresh: true },
    );
  }

  track(
    sessionId: string,
    queryId: number,
    tracking: { tablesRead: Set<string>; dependencies: QueryDependency[] },
  ): void {
    const observer = this._observers.get(tokenFor(sessionId, queryId));
    if (!observer) {
      return;
    }
    this._observers.track(observer, tracking);
  }

  delete(sessionId: string, queryId: number): void {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.queryIds.delete(queryId);
    this._observers.delete(tokenFor(sessionId, queryId));
    if (session.queryIds.size === 0) {
      this._sessions.delete(sessionId);
    }
  }

  clearSession(sessionId: string): void {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return;
    }
    for (const queryId of session.queryIds) {
      this._observers.delete(tokenFor(sessionId, queryId));
    }
    this._sessions.delete(sessionId);
  }

  clear(): void {
    for (const sessionId of Array.from(this._sessions.keys())) {
      this.clearSession(sessionId);
    }
  }

  getRelevantObservers(
    sessionId: string,
    affectedTables?: Set<string>,
    affectedChanges?: ProtocolChange[] | null,
  ): RuntimeQueryObserver<ProtocolQueryRecord>[] {
    if (!this._sessions.has(sessionId)) {
      return [];
    }
    if (affectedTables === undefined) {
      return this.getAllObservers(sessionId);
    }
    const session = this._sessions.get(sessionId)!;
    return this._observers
      .getRelevantObservers(affectedChanges ?? affectedTables)
      .filter((observer) => session.queryIds.has(observer.meta.queryId));
  }

  private _getOrCreateSession(sessionId: string): SessionQueries {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = { queryIds: new Set() };
      this._sessions.set(sessionId, session);
    }
    return session;
  }
}
