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

import { convexToJson } from "convex/values";
import type { JSONValue, Value } from "convex/values";

import type { QueryDependency, StoredDocument } from "@/runtime/db/types";
import {
  RuntimeProtocolQueryRegistry,
  type ProtocolQueryRecord,
  type RuntimeQueryObserver,
} from "@/runtime/registry";
import { encodeBase64 } from "@/shared/base64";
import { createLogger } from "@/shared/logger";
import { matchTag } from "@/shared/match";

const log = createLogger("protocol");

/**
 * Encode a numeric timestamp as a base64-encoded little-endian 8-byte u64.
 *
 * The Convex SDK encodes `ts` fields using `Long.toBytesLE()` → base64.
 * We replicate that here without pulling in the Long library.
 */
function numberToEncodedU64(n: number): string {
  const bytes = new Uint8Array(8);
  let val = n;
  for (let i = 0; i < 8; i++) {
    bytes[i] = val & 0xff;
    val = Math.floor(val / 256);
  }
  return encodeBase64(bytes);
}

/**
 * Server state version matching the real Convex wire format.
 *
 * On the wire, `ts` is a base64-encoded LE u64 string. The SDK's
 * `parseServerMessage` decodes it into a Long internally.
 */
export type StateVersion = {
  querySet: number;
  ts: number;
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
  ts: string;
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
      ? (convexToJson(data as Value) as JSONValue)
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

type AuthResult =
  | ReturnType<typeof authSuccessResult>
  | ReturnType<typeof authFailureResult>;

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
  ts?: string;
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

interface SessionState {
  /** Current state version for this session. */
  version: StateVersion;
  /** Auth identity set via Authenticate, if any. */
  identity: unknown;
  identityKey: string | null;
}

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
  queryStore: RuntimeProtocolQueryRegistry;
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
  private _queryStore: RuntimeProtocolQueryRegistry;
  private _auth: ProtocolAuth;

  /** Per-session bookkeeping. */
  private _sessions: Map<string, SessionState> = new Map();

  /** Per-session operation queue to keep version transitions ordered. */
  private _sessionQueues: Map<string, Promise<void>> = new Map();

  /** Monotonically increasing internal timestamp. */
  private _ts = 0;

  constructor(opts: SyncProtocolHandlerOptions) {
    this._executor = opts.executor;
    this._queryStore = opts.queryStore;
    this._auth = opts.auth;
  }

  async handleMessage(
    sessionId: string,
    message: ClientMessage,
  ): Promise<ServerMessage[]> {
    return this._withSessionLock(sessionId, async () => {
      log.debug(message.type, sessionId);
      return matchTag(message, "type", {
        Connect: (current) =>
          Promise.resolve(this._handleConnect(sessionId, current)),
        ModifyQuerySet: (current) =>
          this._handleModifyQuerySet(sessionId, current),
        Mutation: (current) => this._handleMutation(sessionId, current),
        Action: (current) => this._handleAction(sessionId, current),
        Authenticate: (current) => this._handleAuthenticate(sessionId, current),
        Event: () => Promise.resolve([] as ServerMessage[]),
      });
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
        if (!session || !this._queryStore.hasQueries(sessionId)) return;

        const relevantQueries = this._queryStore.getRelevantObservers(
          sessionId,
          affectedTables,
          affectedChanges,
        );
        if (relevantQueries.length === 0) return;

        const startVersion = { ...session.version };

        const modifications = await Promise.all(
          relevantQueries.map((observer) =>
            this._refreshProtocolQueryObserver(sessionId, session, observer),
          ),
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
    this._queryStore.clearSession(sessionId);
    this._sessions.delete(sessionId);
    this._sessionQueues.delete(sessionId);
  }

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
      };
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Run a single query and return the appropriate state modification.
   * Catches errors and returns a QueryFailed modification instead of throwing.
   */
  private async _evaluateQuery(q: {
    sessionId: string;
    identity: unknown;
    identityKey: string | null;
    queryId: number;
    udfPath: string;
    args: unknown[];
  }): Promise<{
    modification: StateModification;
    tablesRead: Set<string>;
    dependencies: QueryDependency[];
  }> {
    try {
      const value = await this._executor.runQuery(
        {
          sessionId: q.sessionId,
          identity: q.identity,
          identityKey: q.identityKey,
        },
        q.udfPath,
        ...q.args,
      );
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
          logLines: [] as string[],
          journal: null,
        } as StateModification,
        tablesRead,
        dependencies: (dependencies ?? []) as QueryDependency[],
      };
    } catch (err) {
      return {
        modification: {
          type: "QueryFailed",
          queryId: q.queryId,
          errorMessage: errorMessage(err),
          logLines: [errorMessage(err)] as string[],
          errorData: extractErrorData(err) ?? null,
          journal: null,
        } as StateModification,
        tablesRead: new Set<string>(),
        dependencies: [] as QueryDependency[],
      };
    }
  }

  private _createProtocolQueryObserver(
    sessionId: string,
    session: SessionState,
    query: ProtocolQueryRecord,
  ): RuntimeQueryObserver<ProtocolQueryRecord> {
    return this._queryStore.ensure(sessionId, query, async () => {
      const evaluated = await this._evaluateQuery({
        sessionId,
        identity: session.identity,
        identityKey: session.identityKey,
        ...query,
      });
      query.tablesRead = evaluated.tablesRead;
      query.dependencies = evaluated.dependencies;
      return {
        result: evaluated.modification,
        tablesRead: evaluated.tablesRead,
        dependencies: evaluated.dependencies,
        logs:
          "logLines" in evaluated.modification
            ? evaluated.modification.logLines
            : [],
      };
    });
  }

  private async _refreshProtocolQueryObserver(
    sessionId: string,
    session: SessionState,
    observer: RuntimeQueryObserver<ProtocolQueryRecord>,
  ): Promise<StateModification> {
    const evaluated = await this._evaluateQuery({
      sessionId,
      identity: session.identity,
      identityKey: session.identityKey,
      ...observer.meta,
    });
    observer.meta.tablesRead = evaluated.tablesRead;
    observer.meta.dependencies = evaluated.dependencies;
    this._queryStore.track(sessionId, observer.meta.queryId, {
      tablesRead: evaluated.tablesRead,
      dependencies: evaluated.dependencies,
    });
    return evaluated.modification;
  }

  /** Connect — acknowledge the session with an empty transition. */
  private _handleConnect(
    sessionId: string,
    _message: ClientConnect,
  ): ServerMessage[] {
    const session = this._getOrCreateSession(sessionId);
    session.version = { querySet: 0, ts: 0, identity: 0 };
    session.identity = null;
    this._queryStore.clearSession(sessionId);

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
    const results: Array<StateModification | null> = [];
    for (const modification of message.modifications) {
      const result = await matchTag(modification, "type", {
        Add: async (current) => {
          const query = {
            queryId: current.queryId,
            udfPath: current.udfPath,
            args: current.args ?? [],
            tablesRead: new Set<string>(),
            dependencies: [] as QueryDependency[],
          };
          const observer = this._createProtocolQueryObserver(
            sessionId,
            session,
            query,
          );
          return this._refreshProtocolQueryObserver(
            sessionId,
            session,
            observer,
          );
        },
        Remove: (current) => {
          this._queryStore.delete(sessionId, current.queryId);
          return Promise.resolve(null);
        },
      });
      results.push(result as StateModification | null);
    }
    const modifications = results.filter(
      (value): value is StateModification => value !== null,
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
    let writtenChanges: ProtocolChange[] | null = null;
    let mutationResponse: ServerMessage;
    try {
      const value = await this._executor.runMutation(
        {
          sessionId,
          identity: session.identity,
          identityKey: session.identityKey,
        },
        message.udfPath,
        ...(message.args ?? []),
      );
      const { result, tablesWritten, changes } =
        typeof value === "object" &&
        value !== null &&
        "result" in value &&
        "tablesWritten" in value
          ? (value as {
              result: JSONValue;
              tablesWritten: Set<string>;
              changes?: ProtocolChange[];
            })
          : {
              result: value as JSONValue,
              tablesWritten: null as Set<string> | null,
              changes: null as ProtocolChange[] | null,
            };
      writtenTables = tablesWritten;
      writtenChanges = changes ?? null;
      mutationResponse = {
        type: "MutationResponse",
        requestId: message.requestId,
        success: true,
        result: result ?? null,
        ts: numberToEncodedU64(this._nextTs()),
        logLines: [],
      };
    } catch (err) {
      const data = extractErrorData(err);
      mutationResponse = {
        type: "MutationResponse",
        requestId: message.requestId,
        success: false,
        result: errorMessage(err),
        logLines: [],
        ...(data !== undefined && { errorData: data }),
      };
    }

    let transition: ServerMessage | null = null;
    if (
      this._queryStore.hasQueries(sessionId) &&
      !(writtenTables !== null && writtenTables.size === 0)
    ) {
      const startVersion = { ...session.version };
      const relevantQueries = this._queryStore.getRelevantObservers(
        sessionId,
        writtenTables ?? undefined,
        writtenChanges,
      );
      const modifications = await Promise.all(
        relevantQueries.map((observer) =>
          this._refreshProtocolQueryObserver(sessionId, session, observer),
        ),
      );

      session.version = {
        ...session.version,
        ts: this._nextTs(),
      };

      transition = buildTransition(
        startVersion,
        session.version,
        modifications,
      );
    }

    return transition ? [mutationResponse, transition] : [mutationResponse];
  }

  /** Action — execute and return success/error. */
  private async _handleAction(
    sessionId: string,
    message: ClientAction,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);
    let response: ServerMessage;
    try {
      const result = await this._executor.runAction(
        {
          sessionId,
          identity: session.identity,
          identityKey: session.identityKey,
        },
        message.udfPath,
        ...(message.args ?? []),
      );
      response = {
        type: "ActionResponse",
        requestId: message.requestId,
        success: true,
        result: result ?? null,
        logLines: [],
      };
    } catch (err) {
      const data = extractErrorData(err);
      response = {
        type: "ActionResponse",
        requestId: message.requestId,
        success: false,
        result: errorMessage(err),
        logLines: [],
        ...(data !== undefined && { errorData: data }),
      };
    }
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

    let authResult: AuthResult;
    if (message.tokenType === "None") {
      authResult = authSuccessResult({ identity: null, identityKey: null });
    } else {
      try {
        const value = await this._auth.verifyToken(message.value ?? "");
        authResult = authSuccessResult(normalizeVerifiedIdentity(value));
      } catch (err) {
        authResult = authFailureResult(errorMessage(err));
      }
    }

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
      Failure: (current): ServerMessage[] => [
        {
          type: "AuthError" as const,
          error: current.error,
          baseVersion: message.baseVersion,
          authUpdateAttempted: true,
        },
      ],
    });
  }
}
