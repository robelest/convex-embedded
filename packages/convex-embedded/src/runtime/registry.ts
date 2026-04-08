import { Fx } from "@robelest/fx";
import { convexToJson } from "convex/values";

import type { QueryDependency } from "@/runtime/db/types";
import type { ProtocolChange } from "@/sync/protocol";
import type { SubscriptionManager } from "@/sync/subscriptions";

export type QueryEvaluation = {
  result: unknown;
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
  logs?: string[];
};

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
}

function stableValueKey(value: unknown): string {
  if (value === undefined) {
    return JSON.stringify({ $undefined: true });
  }

  try {
    return JSON.stringify(convexToJson(value as never));
  } catch {
    return JSON.stringify(value);
  }
}

function errorKey(error: Error | null): string | null {
  return error === null ? null : `${error.name}:${error.message}`;
}

function stateChanged<TMeta>(observer: RuntimeQueryObserver<TMeta>): boolean {
  const previous = observer as RuntimeQueryObserver<TMeta> & {
    _previousHasValue?: boolean;
    _previousValueKey?: string | null;
    _previousErrorKey?: string | null;
    _previousLogsKey?: string | null;
  };

  const nextValueKey = observer.hasValue
    ? stableValueKey(observer.currentValue)
    : null;
  const nextErrorKey = errorKey(observer.currentError);
  const nextLogsKey = observer.currentLogs
    ? JSON.stringify(observer.currentLogs)
    : null;
  const changed =
    previous._previousHasValue !== observer.hasValue ||
    previous._previousValueKey !== nextValueKey ||
    previous._previousErrorKey !== nextErrorKey ||
    previous._previousLogsKey !== nextLogsKey;

  previous._previousHasValue = observer.hasValue;
  previous._previousValueKey = nextValueKey;
  previous._previousErrorKey = nextErrorKey;
  previous._previousLogsKey = nextLogsKey;

  return changed;
}

export class RuntimeQueryObserverRegistry<TMeta> {
  private readonly _entries = new Map<
    string,
    { observer: RuntimeQueryObserver<TMeta>; unsubscribe: () => void }
  >();

  constructor(private readonly _subscriptions: SubscriptionManager) {}

  ensure(
    token: string,
    meta: TMeta,
    evaluate: () => Promise<QueryEvaluation>,
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
    };

    this._entries.set(token, {
      observer,
      unsubscribe: this._subscriptions.subscribe(token, new Set(), [], () => {
        void this.refresh(token);
      }),
    });
    return observer;
  }

  get(token: string): RuntimeQueryObserver<TMeta> | undefined {
    return this._entries.get(token)?.observer;
  }

  has(token: string): boolean {
    return this._entries.has(token);
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
    return () => {
      observer.listeners.delete(callback);
      if (observer.listeners.size === 0) {
        this.delete(token);
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

    observer.evaluation = (async () => {
      do {
        observer.needsReevaluation = false;
        try {
          const evaluation = await observer.evaluate();
          this.syncState(observer, evaluation);
        } catch (error) {
          observer.currentValue = undefined;
          observer.currentError =
            error instanceof Error ? error : new Error(String(error));
          observer.currentLogs = [observer.currentError.message];
          observer.hasValue = true;
          observer.tablesRead = new Set();
          observer.dependencies = [];
          const entry = this._entries.get(observer.token);
          entry?.unsubscribe();
          this._entries.set(observer.token, {
            observer,
            unsubscribe: this._subscriptions.subscribe(
              observer.token,
              new Set(),
              [],
              () => {
                void this.refresh(observer);
              },
            ),
          });
        }

        if (stateChanged(observer)) {
          for (const listener of Array.from(observer.listeners)) {
            listener();
          }
        }
      } while (observer.needsReevaluation);
    })().finally(() => {
      observer.evaluation = null;
      if (observer.needsReevaluation) {
        void this.refresh(observer);
      }
    });

    await observer.evaluation;
  }

  syncState(
    tokenOrObserver: string | RuntimeQueryObserver<TMeta>,
    state: QueryObserverStateInput,
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
        () => {
          void this.refresh(observer);
        },
      ),
    });

    if (stateChanged(observer)) {
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

    const entry = this._entries.get(observer.token);
    entry?.unsubscribe();
    this._entries.set(observer.token, {
      observer,
      unsubscribe: this._subscriptions.subscribe(
        observer.token,
        tracking.tablesRead,
        tracking.dependencies,
        () => {
          void this.refresh(observer);
        },
      ),
    });
  }

  async refreshAll(): Promise<void> {
    await Fx.run(
      Fx.each(this.values(), (observer) =>
        Fx.from({
          ok: () => this.refresh(observer),
          err: (error) => error as Error,
        }).pipe(Fx.map(() => undefined as void)),
      ),
    );
  }

  getRelevantObservers(
    changesOrTables: Set<string> | ProtocolChange[],
  ): RuntimeQueryObserver<TMeta>[] {
    const relevantTokens =
      this._subscriptions.collectRelevantTokens(changesOrTables);
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
