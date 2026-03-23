/**
 * Convex WebSocket remote protocol handler.
 *
 * Implements the server side of the Convex remote protocol that ConvexClient
 * speaks. The handler parses incoming client messages, delegates execution
 * to the provided executor, and returns the appropriate server responses.
 *
 * Wire format matches the real Convex backend so that the standard
 * `ConvexReactClient` / `ConvexClient` can talk to us without modification.
 */

import { Fx } from "@robelest/fx";
import { convexToJson } from "convex/values";
import type { JSONValue } from "convex/values";

import { compareValues } from "@/core/compare";
import { evaluateFieldPath } from "@/core/query-engine";
import type {
  QueryDependency,
  SerializedRangeExpression,
  StoredDocument,
} from "@/core/types";
import type { SubscriptionManager } from "@/sync/subscriptions";

// ---------------------------------------------------------------------------
// Base64 helpers for LE-encoded u64 timestamps
// ---------------------------------------------------------------------------

/**
 * Encode a numeric timestamp as a base64-encoded little-endian 8-byte u64.
 *
 * The Convex SDK encodes `ts` fields using `Long.toBytesLE()` → base64.
 * We replicate that here without pulling in the Long library.
 */
function numberToEncodedU64(n: number): string {
  const bytes = new Uint8Array(8);
  // Write as unsigned 64-bit LE — JS numbers are safe up to 2^53.
  let val = n;
  for (let i = 0; i < 8; i++) {
    bytes[i] = val & 0xff;
    val = Math.floor(val / 256);
  }
  return btoa(String.fromCharCode(...bytes));
}

// ---------------------------------------------------------------------------
// State version
// ---------------------------------------------------------------------------

/**
 * Server state version matching the real Convex wire format.
 *
 * On the wire, `ts` is a base64-encoded LE u64 string. The SDK's
 * `parseServerMessage` decodes it into a Long internally.
 */
export type StateVersion = {
  querySet: number;
  ts: number; // internal numeric — encoded to base64 on the wire
  identity: number;
};

export interface ProtocolSessionContext {
  sessionId: string;
  identity: unknown;
  identityKey: string | null;
}

export interface VerifiedIdentity {
  identity: unknown;
  identityKey: string | null;
}

export interface ProtocolChange {
  tableName: string;
  before: StoredDocument | null;
  after: StoredDocument | null;
}

type EncodedStateVersion = {
  querySet: number;
  ts: string; // base64-encoded LE u64
  identity: number;
};

function encodeStateVersion(v: StateVersion): EncodedStateVersion {
  return {
    querySet: v.querySet,
    ts: numberToEncodedU64(v.ts),
    identity: v.identity,
  };
}

/** Extract a message string from an unknown caught value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract ConvexError data from a thrown value, if present. */
function extractErrorData(err: unknown): JSONValue | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    Symbol.for("ConvexError") in err
  ) {
    const data = (err as { data?: unknown }).data;
    return data !== undefined
      ? (convexToJson(data as any) as JSONValue)
      : undefined;
  }
  return undefined;
}

function buildTransition(
  startVersion: StateVersion,
  endVersion: StateVersion,
  modifications: StateModification[],
): ServerMessage {
  return {
    type: "Transition",
    startVersion: encodeStateVersion(startVersion),
    endVersion: encodeStateVersion(endVersion),
    modifications,
  };
}

function authSuccessResult(identity: VerifiedIdentity) {
  return { _tag: "Success" as const, identity };
}

function authFailureResult(error: string) {
  return { _tag: "Failure" as const, error };
}

function normalizeVerifiedIdentity(value: unknown): VerifiedIdentity {
  if (
    typeof value === "object" &&
    value !== null &&
    "identity" in value &&
    "identityKey" in value
  ) {
    return value as VerifiedIdentity;
  }
  return { identity: value, identityKey: null };
}

function matchesRangeExpressions(
  doc: StoredDocument,
  range: ReadonlyArray<SerializedRangeExpression>,
): boolean {
  return range.every((filter) => {
    const result = evaluateFieldPath(filter.fieldPath, doc);
    const value = filter.value as unknown;
    return filter.type === "Eq"
      ? compareValues(result, value) === 0
      : filter.type === "Gt"
        ? compareValues(result, value) > 0
        : filter.type === "Gte"
          ? compareValues(result, value) >= 0
          : filter.type === "Lt"
            ? compareValues(result, value) < 0
            : compareValues(result, value) <= 0;
  });
}

function dependencyOverlapsChanges(
  dependency: QueryDependency,
  changes: ProtocolChange[],
): boolean {
  return changes.some(({ tableName, before, after }) => {
    if (dependency.tableName !== tableName) {
      return false;
    }

    if (dependency.type === "IndexRange") {
      return [before, after].some(
        (doc) => doc !== null && matchesRangeExpressions(doc, dependency.range),
      );
    }

    return true;
  });
}

function matchTag<
  T extends Record<K, string>,
  K extends keyof T & string,
  Handlers extends {
    [V in T[K] & string]: (value: Extract<T, Record<K, V>>) => unknown;
  },
>(value: T, key: K, handlers: Handlers): ReturnType<Handlers[T[K] & string]> {
  const handler = handlers[value[key] as T[K] & string] as (
    current: T,
  ) => ReturnType<Handlers[T[K] & string]>;
  return handler(value);
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | ClientConnect
  | ClientModifyQuerySet
  | ClientMutation
  | ClientAction
  | ClientAuthenticate
  | ClientEvent;

interface ClientConnect {
  type: "Connect";
  sessionId: string;
  connectionCount: number;
  lastCloseReason: string | null;
  maxObservedTimestamp?: string | undefined;
  clientTs: number;
}

interface ClientModifyQuerySet {
  type: "ModifyQuerySet";
  baseVersion: number;
  newVersion: number;
  modifications: Array<AddQuery | RemoveQuery>;
}

interface AddQuery {
  type: "Add";
  queryId: number;
  udfPath: string;
  args: JSONValue[];
  journal?: string | null | undefined;
  componentPath?: string | undefined;
}

interface RemoveQuery {
  type: "Remove";
  queryId: number;
}

interface ClientMutation {
  type: "Mutation";
  requestId: number;
  udfPath: string;
  args: JSONValue[];
  componentPath?: string | undefined;
}

interface ClientAction {
  type: "Action";
  requestId: number;
  udfPath: string;
  args: JSONValue[];
  componentPath?: string | undefined;
}

interface ClientAuthenticate {
  type: "Authenticate";
  tokenType: "User" | "Admin" | "None";
  value?: string;
  baseVersion: number;
  impersonating?: any;
}

interface ClientEvent {
  type: "Event";
  eventType: string;
  event: any;
}

// ---------------------------------------------------------------------------
// Server → Client messages (encoded wire format)
// ---------------------------------------------------------------------------

type StateModification =
  | {
      type: "QueryUpdated";
      queryId: number;
      value: JSONValue;
      logLines: string[];
      journal: string | null;
    }
  | {
      type: "QueryFailed";
      queryId: number;
      errorMessage: string;
      logLines: string[];
      errorData: JSONValue;
      journal: string | null;
    }
  | {
      type: "QueryRemoved";
      queryId: number;
    };

export type ServerMessage =
  | ServerTransition
  | ServerMutationResponse
  | ServerActionResponse
  | ServerAuthError
  | ServerFatalError
  | ServerPing;

interface ServerTransition {
  type: "Transition";
  startVersion: EncodedStateVersion;
  endVersion: EncodedStateVersion;
  modifications: StateModification[];
}

interface ServerMutationResponse {
  type: "MutationResponse";
  requestId: number;
  success: boolean;
  result: JSONValue;
  ts?: string; // base64-encoded LE u64 — present on success
  logLines: string[];
  errorData?: JSONValue;
}

interface ServerActionResponse {
  type: "ActionResponse";
  requestId: number;
  success: boolean;
  result: JSONValue;
  logLines: string[];
  errorData?: JSONValue;
}

interface ServerAuthError {
  type: "AuthError";
  error: string;
  baseVersion: number;
  authUpdateAttempted: boolean;
}

interface ServerFatalError {
  type: "FatalError";
  error: string;
}

interface ServerPing {
  type: "Ping";
}

// ---------------------------------------------------------------------------
// Session state tracked per-connection inside the handler
// ---------------------------------------------------------------------------

/** A tracked query subscription that can be re-evaluated after mutations. */
interface ActiveQuery {
  queryId: number;
  udfPath: string;
  args: JSONValue[];
  tablesRead: Set<string>;
  dependencies: QueryDependency[];
}

interface SessionState {
  /** Current state version for this session. */
  version: StateVersion;
  /** Auth identity set via Authenticate, if any. */
  identity: unknown;
  identityKey: string | null;
  /** Active query subscriptions keyed by queryId. */
  activeQueries: Map<number, ActiveQuery>;
}

// ---------------------------------------------------------------------------
// SyncProtocolHandler
// ---------------------------------------------------------------------------

/** Executor interface expected by the remote protocol handler. */
export interface ProtocolExecutor {
  runQuery(
    context: ProtocolSessionContext,
    udfPath: string,
    ...args: unknown[]
  ): Promise<{
    result: JSONValue;
    tablesRead: Set<string>;
    dependencies: QueryDependency[];
  }>;
  runMutation(
    context: ProtocolSessionContext,
    udfPath: string,
    ...args: unknown[]
  ): Promise<{ result: JSONValue; tablesWritten: Set<string> | null }>;
  runAction(
    context: ProtocolSessionContext,
    udfPath: string,
    ...args: unknown[]
  ): Promise<JSONValue>;
}

/** Auth interface expected by the remote protocol handler. */
export interface ProtocolAuth {
  verifyToken(token: string): Promise<VerifiedIdentity>;
}

export interface SyncProtocolHandlerOptions {
  /** Function executor for running queries, mutations, and actions. */
  executor: ProtocolExecutor;
  subscriptions: SubscriptionManager;
  /** Auth handler for token verification. */
  auth: ProtocolAuth;
}

/**
 * Handles the server side of the Convex remote protocol.
 *
 * Each incoming {@link ClientMessage} is dispatched to the appropriate
 * handler and one or more {@link ServerMessage}s are returned to be sent
 * back over the wire.
 */
export class SyncProtocolHandler {
  private _executor: ProtocolExecutor;
  private _subscriptions: SubscriptionManager;
  private _auth: ProtocolAuth;

  /** Per-session bookkeeping. */
  private _sessions: Map<string, SessionState> = new Map();

  /** Per-session operation queue to keep version transitions ordered. */
  private _sessionQueues: Map<string, Promise<void>> = new Map();

  /** Monotonically increasing internal timestamp. */
  private _ts = 0;

  constructor(opts: SyncProtocolHandlerOptions) {
    this._executor = opts.executor;
    this._subscriptions = opts.subscriptions;
    this._auth = opts.auth;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async handleMessage(
    sessionId: string,
    message: ClientMessage,
  ): Promise<ServerMessage[]> {
    return this._withSessionLock(sessionId, async () => {
      console.debug("[convex-embedded:protocol]", message.type, sessionId);
      return Fx.run(
        Fx.match(message, message.type, {
          Connect: (current) =>
            Fx.from({
              ok: () => this._handleConnect(sessionId, current),
              err: (err) => err as Error,
            }),
          ModifyQuerySet: (current) =>
            Fx.from({
              ok: () => this._handleModifyQuerySet(sessionId, current),
              err: (err) => err as Error,
            }),
          Mutation: (current) =>
            Fx.from({
              ok: () => this._handleMutation(sessionId, current),
              err: (err) => err as Error,
            }),
          Action: (current) =>
            Fx.from({
              ok: () => this._handleAction(sessionId, current),
              err: (err) => err as Error,
            }),
          Authenticate: (current) =>
            Fx.from({
              ok: () => this._handleAuthenticate(sessionId, current),
              err: (err) => err as Error,
            }),
          Event: () => Fx.succeed([]),
        }),
      );
    });
  }

  /**
   * Re-evaluate all active queries across all sessions.
   *
   * Used by cross-tab sync: when another tab writes, the runtime
   * re-reads the affected tables from IndexedDB, then calls this
   * method to re-run every active query and produce `Transition`
   * messages that can be pushed to the ConvexClient.
   *
   * @returns A map of session IDs to arrays of server messages
   *   (`Transition` with `QueryUpdated` / `QueryFailed` modifications).
   *   Sessions with no active queries are omitted.
   */
  async reEvaluateQueries(
    affectedTablesOrChanges?: Set<string> | ProtocolChange[],
  ): Promise<Map<string, ServerMessage[]>> {
    const result = new Map<string, ServerMessage[]>();

    const affectedChanges = Array.isArray(affectedTablesOrChanges)
      ? affectedTablesOrChanges
      : null;
    const affectedTables = Array.isArray(affectedTablesOrChanges)
      ? new Set(affectedTablesOrChanges.map((change) => change.tableName))
      : affectedTablesOrChanges;

    for (const sessionId of this._sessions.keys()) {
      await this._withSessionLock(sessionId, async () => {
        const session = this._sessions.get(sessionId);
        if (!session || session.activeQueries.size === 0) return;

        const relevantQueries = [...session.activeQueries.values()].filter(
          (query) =>
            affectedTables === undefined ||
            query.dependencies.length === 0 ||
            query.dependencies.some((dependency) =>
              affectedChanges
                ? dependencyOverlapsChanges(dependency, affectedChanges)
                : affectedTables.has(dependency.tableName),
            ),
        );
        if (relevantQueries.length === 0) return;

        const startVersion = { ...session.version };

        const evaluated = await Fx.run(
          Fx.each(relevantQueries, (q) =>
            this._evaluateQuery({
              sessionId,
              identity: session.identity,
              identityKey: session.identityKey,
              ...q,
            }),
          ),
        );
        const modifications = evaluated.map(
          ({ modification, tablesRead, dependencies }, index) => {
            relevantQueries[index]!.tablesRead = tablesRead;
            relevantQueries[index]!.dependencies = dependencies;
            return modification;
          },
        );

        session.version = {
          ...session.version,
          ts: this._nextTs(),
        };

        result.set(sessionId, [
          {
            type: "Transition",
            startVersion: encodeStateVersion(startVersion),
            endVersion: encodeStateVersion(session.version),
            modifications,
          },
        ]);
      });
    }

    return result;
  }

  removeSession(sessionId: string): void {
    this._sessions.delete(sessionId);
    this._sessionQueues.delete(sessionId);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private _nextTs(): number {
    return ++this._ts;
  }

  private _hasExpectedQuerySetVersion(
    session: SessionState,
    baseVersion: number,
  ): boolean {
    return session.version.querySet === baseVersion;
  }

  private _hasExpectedIdentityVersion(
    session: SessionState,
    baseVersion: number,
  ): boolean {
    return session.version.identity === baseVersion;
  }

  private _querySetVersionError(
    baseVersion: number,
    currentVersion: number,
  ): ServerMessage {
    return {
      type: "FatalError",
      error: `ModifyQuerySet baseVersion mismatch: expected ${currentVersion}, received ${baseVersion}`,
    };
  }

  private _identityVersionError(
    baseVersion: number,
    currentVersion: number,
  ): ServerMessage {
    return {
      type: "AuthError",
      error: `Authenticate baseVersion mismatch: expected ${currentVersion}, received ${baseVersion}`,
      baseVersion,
      authUpdateAttempted: false,
    };
  }

  private async _withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this._sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this._sessionQueues.set(
      sessionId,
      previous.then(
        () => current,
        () => current,
      ),
    );

    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this._sessionQueues.get(sessionId) === current) {
        this._sessionQueues.delete(sessionId);
      }
    }
  }

  private _getOrCreateSession(sessionId: string): SessionState {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = {
        version: { querySet: 0, ts: 0, identity: 0 },
        identity: null,
        identityKey: null,
        activeQueries: new Map(),
      };
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Run a single query and return the appropriate state modification.
   * Catches errors and returns a QueryFailed modification instead of throwing.
   */
  private _evaluateQuery(q: {
    sessionId: string;
    identity: unknown;
    identityKey: string | null;
    queryId: number;
    udfPath: string;
    args: unknown[];
  }): Fx<{
    modification: StateModification;
    tablesRead: Set<string>;
    dependencies: QueryDependency[];
  }> {
    return Fx.attempt(
      () =>
        this._executor.runQuery(
          {
            sessionId: q.sessionId,
            identity: q.identity,
            identityKey: q.identityKey,
          },
          q.udfPath,
          ...q.args,
        ),
      (value) => {
        const { result, tablesRead, dependencies } =
          typeof value === "object" &&
          value !== null &&
          "result" in value &&
          "tablesRead" in value
            ? (value as {
                result: JSONValue;
                tablesRead: Set<string>;
                dependencies?: QueryDependency[];
              })
            : {
                result: value as JSONValue,
                tablesRead: new Set<string>(),
                dependencies: [],
              };
        return {
          modification: {
            type: "QueryUpdated",
            queryId: q.queryId,
            value: result as JSONValue,
            logLines: [],
            journal: null,
          },
          tablesRead,
          dependencies: dependencies ?? [],
        };
      },
      (err) => ({
        modification: {
          type: "QueryFailed",
          queryId: q.queryId,
          errorMessage: errorMessage(err),
          logLines: [errorMessage(err)],
          errorData: extractErrorData(err) ?? null,
          journal: null,
        },
        tablesRead: new Set<string>(),
        dependencies: [],
      }),
    );
  }

  /** Connect — acknowledge the session with an empty transition. */
  private _handleConnect(
    sessionId: string,
    _message: ClientConnect,
  ): ServerMessage[] {
    // On reconnect, reset the session state so the client can rebuild.
    const session = this._getOrCreateSession(sessionId);
    // Reset to zero so the client can send a fresh ModifyQuerySet
    session.version = { querySet: 0, ts: 0, identity: 0 };
    session.identity = null;
    session.activeQueries.clear();

    const version = encodeStateVersion(session.version);
    return [
      {
        type: "Transition",
        startVersion: version,
        endVersion: version,
        modifications: [],
      },
    ];
  }

  /** ModifyQuerySet — add/remove query subscriptions and return results. */
  private async _handleModifyQuerySet(
    sessionId: string,
    message: ClientModifyQuerySet,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);
    if (!this._hasExpectedQuerySetVersion(session, message.baseVersion)) {
      return [
        this._querySetVersionError(
          message.baseVersion,
          session.version.querySet,
        ),
      ];
    }

    const startVersion = { ...session.version };
    const modifications = await Fx.run(
      Fx.each(message.modifications, (modification) =>
        Fx.match(modification, modification.type, {
          Add: (current) =>
            Fx.from({
              ok: async () => {
                const query = {
                  queryId: current.queryId,
                  udfPath: current.udfPath,
                  args: current.args ?? [],
                  tablesRead: new Set<string>(),
                  dependencies: [] as QueryDependency[],
                };
                const evaluated = await Fx.run(
                  this._evaluateQuery({
                    sessionId,
                    identity: session.identity,
                    identityKey: session.identityKey,
                    ...query,
                  }),
                );
                query.tablesRead = evaluated.tablesRead;
                query.dependencies = evaluated.dependencies;
                session.activeQueries.set(current.queryId, query);
                return evaluated.modification;
              },
              err: (err) => err as Error,
            }),
          Remove: (current) =>
            Fx.sync(() => {
              session.activeQueries.delete(current.queryId);
              return null;
            }),
        }),
      ).pipe(Fx.map((values) => values.filter((value) => value !== null))),
    );

    session.version = {
      ...session.version,
      querySet: message.newVersion,
      ts: this._nextTs(),
    };

    return [buildTransition(startVersion, session.version, modifications)];
  }

  /** Mutation — execute, re-evaluate active queries, return both responses. */
  private async _handleMutation(
    sessionId: string,
    message: ClientMutation,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);

    let writtenTables: Set<string> | null = new Set<string>();
    const mutationResponse: ServerMessage = await Fx.run(
      Fx.attempt(
        () =>
          this._executor.runMutation(
            {
              sessionId,
              identity: session.identity,
              identityKey: session.identityKey,
            },
            message.udfPath,
            ...(message.args ?? []),
          ),
        (value): ServerMessage => {
          const { result, tablesWritten } =
            typeof value === "object" &&
            value !== null &&
            "result" in value &&
            "tablesWritten" in value
              ? (value as { result: JSONValue; tablesWritten: Set<string> })
              : {
                  result: value as JSONValue,
                  tablesWritten: null as Set<string> | null,
                };
          writtenTables = tablesWritten;
          return {
            type: "MutationResponse",
            requestId: message.requestId,
            success: true,
            result: result ?? null,
            ts: numberToEncodedU64(this._nextTs()),
            logLines: [],
          };
        },
        (err): ServerMessage => {
          const data = extractErrorData(err);
          return {
            type: "MutationResponse",
            requestId: message.requestId,
            success: false,
            result: errorMessage(err),
            logLines: [],
            ...(data !== undefined && { errorData: data }),
          };
        },
      ),
    );

    const transition =
      session.activeQueries.size === 0 ||
      (writtenTables !== null && writtenTables.size === 0)
        ? null
        : await Fx.run(
            Fx.from({
              ok: async () => {
                const startVersion = { ...session.version };
                const relevantQueries = [
                  ...session.activeQueries.values(),
                ].filter(
                  (query) =>
                    writtenTables === null ||
                    query.tablesRead.size === 0 ||
                    [...query.tablesRead].some((table) =>
                      writtenTables.has(table),
                    ),
                );
                const evaluated = await Fx.run(
                  Fx.each(relevantQueries, (q) =>
                    this._evaluateQuery({
                      sessionId,
                      identity: session.identity,
                      identityKey: session.identityKey,
                      ...q,
                    }),
                  ),
                );
                const modifications = evaluated.map(
                  ({ modification }, index) => {
                    relevantQueries[index]!.tablesRead =
                      evaluated[index]!.tablesRead;
                    return modification;
                  },
                );

                session.version = {
                  ...session.version,
                  ts: this._nextTs(),
                };

                return buildTransition(
                  startVersion,
                  session.version,
                  modifications,
                );
              },
              err: (err) => err as Error,
            }),
          );

    return transition ? [mutationResponse, transition] : [mutationResponse];
  }

  /** Action — execute and return success/error. */
  private async _handleAction(
    sessionId: string,
    message: ClientAction,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);
    const response: ServerMessage = await Fx.run(
      Fx.attempt(
        () =>
          this._executor.runAction(
            {
              sessionId,
              identity: session.identity,
              identityKey: session.identityKey,
            },
            message.udfPath,
            ...(message.args ?? []),
          ),
        (result): ServerMessage => ({
          type: "ActionResponse",
          requestId: message.requestId,
          success: true,
          result: result ?? null,
          logLines: [],
        }),
        (err): ServerMessage => {
          const data = extractErrorData(err);
          return {
            type: "ActionResponse",
            requestId: message.requestId,
            success: false,
            result: errorMessage(err),
            logLines: [],
            ...(data !== undefined && { errorData: data }),
          };
        },
      ),
    );
    return [response];
  }

  /** Authenticate — verify the token and return a Transition or AuthError. */
  private async _handleAuthenticate(
    sessionId: string,
    message: ClientAuthenticate,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);
    if (!this._hasExpectedIdentityVersion(session, message.baseVersion)) {
      return [
        this._identityVersionError(
          message.baseVersion,
          session.version.identity,
        ),
      ];
    }

    const authResult = await Fx.run(
      Fx.match(message, message.tokenType, {
        None: () =>
          Fx.succeed(authSuccessResult({ identity: null, identityKey: null })),
        User: () =>
          Fx.from({
            ok: () => this._auth.verifyToken(message.value ?? ""),
            err: errorMessage,
          }).pipe(
            Fx.fold({
              ok: (value) =>
                authSuccessResult(normalizeVerifiedIdentity(value)),
              err: authFailureResult,
            }),
          ),
        Admin: () =>
          Fx.from({
            ok: () => this._auth.verifyToken(message.value ?? ""),
            err: errorMessage,
          }).pipe(
            Fx.fold({
              ok: (value) =>
                authSuccessResult(normalizeVerifiedIdentity(value)),
              err: authFailureResult,
            }),
          ),
      }),
    );

    return matchTag(authResult, "_tag", {
      Success: (current) => {
        session.identity = current.identity.identity;
        session.identityKey = current.identity.identityKey;
        const startVersion = { ...session.version };
        session.version = {
          ...session.version,
          identity: session.version.identity + 1,
        };
        return [buildTransition(startVersion, session.version, [])];
      },
      Failure: (current) => [
        {
          type: "AuthError",
          error: current.error,
          baseVersion: message.baseVersion,
          authUpdateAttempted: true,
        },
      ],
    });
  }
}
