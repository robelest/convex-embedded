/**
 * Convex WebSocket sync protocol handler.
 *
 * Implements the server side of the Convex sync protocol that ConvexClient
 * speaks. The handler parses incoming client messages, delegates execution
 * to the provided executor, and returns the appropriate server responses.
 */

import type { JSONValue } from "convex/values";

import type { SubscriptionManager } from "./subscriptions.js";

// ---------------------------------------------------------------------------
// State version
// ---------------------------------------------------------------------------

/** Monotonically increasing version that tracks query-set state. */
export type StateVersion = {
  querySetVersion: number;
  ts: number;
  identity: number;
};

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | ClientConnect
  | ClientModifyQuerySet
  | ClientMutation
  | ClientAction
  | ClientAuthenticate;

interface ClientConnect {
  type: "Connect";
  sessionId: string;
}

interface ClientModifyQuerySet {
  type: "ModifyQuerySet";
  baseVersion: number;
  /** Queries to add — each carries a token, the function path, and args. */
  modifications: Array<{
    type: "Add" | "Remove";
    queryToken: string;
    udfPath?: string;
    args?: JSONValue[];
  }>;
}

interface ClientMutation {
  type: "Mutation";
  requestId: number;
  udfPath: string;
  args: JSONValue[];
}

interface ClientAction {
  type: "Action";
  requestId: number;
  udfPath: string;
  args: JSONValue[];
}

interface ClientAuthenticate {
  type: "Authenticate";
  token: string;
}

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export type ServerMessage =
  | ServerTransition
  | ServerMutationResponse
  | ServerActionResponse
  | ServerAuthError;

interface ServerTransition {
  type: "Transition";
  startVersion: StateVersion;
  endVersion: StateVersion;
  modifications: Record<string, { result: JSONValue | undefined; logLines: string[] }>;
}

interface ServerMutationResponse {
  type: "MutationResponse";
  requestId: number;
  success: boolean;
  result?: JSONValue;
  errorMessage?: string;
}

interface ServerActionResponse {
  type: "ActionResponse";
  requestId: number;
  success: boolean;
  result?: JSONValue;
  errorMessage?: string;
}

interface ServerAuthError {
  type: "AuthError";
  errorMessage: string;
}

// ---------------------------------------------------------------------------
// Session state tracked per-connection inside the handler
// ---------------------------------------------------------------------------

interface SessionState {
  /** Current state version for this session. */
  version: StateVersion;
  /** Auth identity set via Authenticate, if any. */
  identity: unknown | null;
}

// ---------------------------------------------------------------------------
// SyncProtocolHandler
// ---------------------------------------------------------------------------

export interface SyncProtocolHandlerOptions {
  /** Function executor — expected to expose `runQuery`, `runMutation`, `runAction`. */
  executor: any;
  subscriptions: SubscriptionManager;
  /** Auth handler — expected to expose `verifyToken(token: string)`. */
  auth: any;
}

/**
 * Handles the server side of the Convex sync protocol.
 *
 * Each incoming {@link ClientMessage} is dispatched to the appropriate
 * handler and one or more {@link ServerMessage}s are returned to be sent
 * back over the wire.
 */
export class SyncProtocolHandler {
  private _executor: any;
  private _subscriptions: SubscriptionManager;
  private _auth: any;

  /** Per-session bookkeeping. */
  private _sessions: Map<string, SessionState> = new Map();

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
    switch (message.type) {
      case "Connect":
        return this._handleConnect(sessionId);
      case "ModifyQuerySet":
        return this._handleModifyQuerySet(sessionId, message);
      case "Mutation":
        return this._handleMutation(sessionId, message);
      case "Action":
        return this._handleAction(sessionId, message);
      case "Authenticate":
        return this._handleAuthenticate(sessionId, message);
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private _getOrCreateSession(sessionId: string): SessionState {
    let session = this._sessions.get(sessionId);
    if (!session) {
      session = {
        version: { querySetVersion: 0, ts: 0, identity: 0 },
        identity: null,
      };
      this._sessions.set(sessionId, session);
    }
    return session;
  }

  /** Connect — acknowledge the session with an empty transition. */
  private _handleConnect(sessionId: string): ServerMessage[] {
    const session = this._getOrCreateSession(sessionId);
    const version = { ...session.version };
    return [
      {
        type: "Transition",
        startVersion: version,
        endVersion: version,
        modifications: {},
      },
    ];
  }

  /** ModifyQuerySet — add/remove query subscriptions and return results. */
  private async _handleModifyQuerySet(
    sessionId: string,
    message: ClientModifyQuerySet,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);
    const startVersion = { ...session.version };
    const modifications: Record<
      string,
      { result: JSONValue | undefined; logLines: string[] }
    > = {};

    for (const mod of message.modifications) {
      if (mod.type === "Add" && mod.udfPath) {
        try {
          const result = await this._executor.runQuery(
            mod.udfPath,
            ...(mod.args ?? []),
          );
          modifications[mod.queryToken] = { result, logLines: [] };
        } catch (err: any) {
          modifications[mod.queryToken] = {
            result: undefined,
            logLines: [err.message ?? String(err)],
          };
        }
      }
      // For "Remove" we just acknowledge — unsubscribe is handled at the
      // session layer.
    }

    session.version = {
      ...session.version,
      querySetVersion: session.version.querySetVersion + 1,
    };

    return [
      {
        type: "Transition",
        startVersion,
        endVersion: { ...session.version },
        modifications,
      },
    ];
  }

  /** Mutation — execute and return success/error. */
  private async _handleMutation(
    _sessionId: string,
    message: ClientMutation,
  ): Promise<ServerMessage[]> {
    try {
      const result = await this._executor.runMutation(
        message.udfPath,
        ...(message.args ?? []),
      );
      return [
        {
          type: "MutationResponse",
          requestId: message.requestId,
          success: true,
          result,
        },
      ];
    } catch (err: any) {
      return [
        {
          type: "MutationResponse",
          requestId: message.requestId,
          success: false,
          errorMessage: err.message ?? String(err),
        },
      ];
    }
  }

  /** Action — execute and return success/error. */
  private async _handleAction(
    _sessionId: string,
    message: ClientAction,
  ): Promise<ServerMessage[]> {
    try {
      const result = await this._executor.runAction(
        message.udfPath,
        ...(message.args ?? []),
      );
      return [
        {
          type: "ActionResponse",
          requestId: message.requestId,
          success: true,
          result,
        },
      ];
    } catch (err: any) {
      return [
        {
          type: "ActionResponse",
          requestId: message.requestId,
          success: false,
          errorMessage: err.message ?? String(err),
        },
      ];
    }
  }

  /** Authenticate — verify the token and return a Transition or AuthError. */
  private async _handleAuthenticate(
    sessionId: string,
    message: ClientAuthenticate,
  ): Promise<ServerMessage[]> {
    const session = this._getOrCreateSession(sessionId);

    try {
      const identity = await this._auth.verifyToken(message.token);
      session.identity = identity;

      const startVersion = { ...session.version };
      session.version = {
        ...session.version,
        identity: session.version.identity + 1,
      };

      return [
        {
          type: "Transition",
          startVersion,
          endVersion: { ...session.version },
          modifications: {},
        },
      ];
    } catch (err: any) {
      return [
        {
          type: "AuthError",
          errorMessage: err.message ?? String(err),
        },
      ];
    }
  }
}
