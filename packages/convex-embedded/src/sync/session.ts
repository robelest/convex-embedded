/**
 * Session management for connected clients.
 *
 * Each WebSocket connection is represented by a {@link Session} that tracks
 * active query subscriptions and auth identity. The {@link SessionManager}
 * creates, retrieves, and tears down sessions.
 */

import type { StateVersion } from "./protocol.js";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface ActiveQuery {
  tableName: string;
  unsubscribe: () => void;
}

/**
 * Represents a single connected client session.
 */
export class Session {
  readonly id: string;
  /** Active query subscriptions keyed by queryToken. */
  activeQueries: Map<string, ActiveQuery> = new Map();
  /** Current auth identity, or `null` if unauthenticated. */
  identity: unknown = null;
  /** Last state version sent to this client. */
  lastStateVersion: StateVersion;

  constructor(id: string) {
    this.id = id;
    this.lastStateVersion = { querySet: 0, ts: 0, identity: 0 };
  }

  /** Unsubscribe all active queries and clear the map. */
  cleanup(): void {
    for (const query of this.activeQueries.values()) {
      query.unsubscribe();
    }
    this.activeQueries.clear();
    this.identity = null;
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Creates, retrieves, and removes {@link Session} instances.
 */
export class SessionManager {
  private _sessions: Map<string, Session> = new Map();
  private _counter = 0;

  /** Create a new session and return its ID. */
  createSession(): string {
    let id: string;
    // Prefer crypto.randomUUID when available (Node 19+, most modern runtimes).
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      id = crypto.randomUUID();
    } else {
      this._counter += 1;
      id = `session_${this._counter}`;
    }
    this._sessions.set(id, new Session(id));
    return id;
  }

  /**
   * Retrieve a session by ID.
   * @throws if the session does not exist.
   */
  getSession(id: string): Session {
    const session = this._sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  /** Remove a session, cleaning up its subscriptions. */
  removeSession(id: string): void {
    const session = this._sessions.get(id);
    if (session) {
      session.cleanup();
      this._sessions.delete(id);
    }
  }
}
