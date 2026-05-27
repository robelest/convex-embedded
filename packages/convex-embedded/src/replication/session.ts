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
export interface SessionManager {
  createSession(): string;
  getSession(id: string): Session;
  deleteSession(id: string): void;
  clear(): void;
}

export function createSessionManager(): SessionManager {
  const sessions = new Map<string, Session>();
  let counter = 0;

  return {
    createSession(): string {
      let id: string;
      if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
      ) {
        id = crypto.randomUUID();
      } else {
        counter += 1;
        id = `session_${counter}`;
      }
      sessions.set(id, createSession(id));
      return id;
    },
    getSession(id: string): Session {
      const session = sessions.get(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }
      return session;
    },
    deleteSession(id: string): void {
      const session = sessions.get(id);
      if (session) {
        session.cleanup();
        sessions.delete(id);
      }
    },
    clear(): void {
      for (const session of sessions.values()) {
        session.cleanup();
      }
      sessions.clear();
    },
  };
}
