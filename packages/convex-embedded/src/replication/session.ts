/**
 * Session management for connected clients.
 *
 * Each WebSocket connection is represented by a {@link Session} that tracks
 * active query subscriptions and auth identity. The {@link SessionManager}
 * creates, retrieves, and tears down sessions.
 */

import type { StateVersion } from "@/replication/protocol";

export interface ActiveQuery {
  tableName: string;
  unsubscribe: () => void;
}

/**
 * Represents a single connected client session.
 */
export interface Session {
  readonly id: string;
  /** Active query subscriptions keyed by queryToken. */
  activeQueries: Map<string, ActiveQuery>;
  /** Current auth identity, or `null` if unauthenticated. */
  identity: unknown;
  /** Last state version sent to this client. */
  lastStateVersion: StateVersion;
  /** Unsubscribe all active queries and clear the map. */
  cleanup(): void;
}

export function createSession(id: string): Session {
  const session: Session = {
    id,
    activeQueries: new Map(),
    identity: null,
    lastStateVersion: { querySet: 0, ts: 0, identity: 0 },
    cleanup() {
      for (const query of session.activeQueries.values()) {
        query.unsubscribe();
      }
      session.activeQueries.clear();
      session.identity = null;
    },
  };
  return session;
}

/**
 * Creates, retrieves, and removes {@link Session} instances.
 */
export class SessionManager {
  private _sessions: Map<string, Session> = new Map();
  private _counter = 0;

  /** Create a new session and return its ID. */
  createSession(): string {
    let id: string;
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      id = crypto.randomUUID();
    } else {
      this._counter += 1;
      id = `session_${this._counter}`;
    }
    this._sessions.set(id, createSession(id));
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
  deleteSession(id: string): void {
    const session = this._sessions.get(id);
    if (session) {
      session.cleanup();
      this._sessions.delete(id);
    }
  }

  /** Remove all sessions, cleaning up their subscriptions. */
  clear(): void {
    for (const session of this._sessions.values()) {
      session.cleanup();
    }
    this._sessions.clear();
  }
}
