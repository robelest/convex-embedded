import { describe, it, expect, vi } from "vitest";

import { Session, SessionManager } from "#embedded/sync/session";

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

describe("Session", () => {
  describe("constructor", () => {
    it("stores the provided id", () => {
      const session = new Session("abc-123");
      expect(session.id).toBe("abc-123");
    });

    it("initializes activeQueries as an empty map", () => {
      const session = new Session("s1");
      expect(session.activeQueries).toBeInstanceOf(Map);
      expect(session.activeQueries.size).toBe(0);
    });

    it("initializes identity as null", () => {
      const session = new Session("s1");
      expect(session.identity).toBeNull();
    });

    it("initializes lastStateVersion with zeroed-out values", () => {
      const session = new Session("s1");
      expect(session.lastStateVersion).toEqual({
        querySet: 0,
        ts: 0,
        identity: 0,
      });
    });
  });

  describe("cleanup", () => {
    it("calls unsubscribe on all active queries", () => {
      const session = new Session("s1");
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();

      session.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: unsub1,
      });
      session.activeQueries.set("q2", {
        tableName: "posts",
        unsubscribe: unsub2,
      });

      session.cleanup();

      expect(unsub1).toHaveBeenCalledOnce();
      expect(unsub2).toHaveBeenCalledOnce();
    });

    it("clears the activeQueries map", () => {
      const session = new Session("s1");
      session.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: vi.fn(),
      });

      session.cleanup();

      expect(session.activeQueries.size).toBe(0);
    });

    it("resets identity to null", () => {
      const session = new Session("s1");
      session.identity = { subject: "user1" };

      session.cleanup();

      expect(session.identity).toBeNull();
    });

    it("is safe to call when no active queries exist", () => {
      const session = new Session("s1");
      expect(() => session.cleanup()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  // -----------------------------------------------------------------------
  // createSession
  // -----------------------------------------------------------------------

  describe("createSession", () => {
    it("returns a unique session ID", () => {
      const manager = new SessionManager();
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      expect(typeof id1).toBe("string");
      expect(typeof id2).toBe("string");
      expect(id1).not.toBe(id2);
    });

    it("returns a non-empty string", () => {
      const manager = new SessionManager();
      const id = manager.createSession();
      expect(id.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // getSession
  // -----------------------------------------------------------------------

  describe("getSession", () => {
    it("returns the session by ID", () => {
      const manager = new SessionManager();
      const id = manager.createSession();

      const session = manager.getSession(id);
      expect(session).toBeInstanceOf(Session);
      expect(session.id).toBe(id);
    });

    it("returns the same Session instance on repeated calls", () => {
      const manager = new SessionManager();
      const id = manager.createSession();

      const a = manager.getSession(id);
      const b = manager.getSession(id);
      expect(a).toBe(b);
    });
  });

  // -----------------------------------------------------------------------
  // Session not found
  // -----------------------------------------------------------------------

  describe("session not found", () => {
    it("throws for an unknown session ID", () => {
      const manager = new SessionManager();

      expect(() => manager.getSession("nonexistent")).toThrow(
        "Session not found",
      );
    });

    it("throws with the missing session ID in the message", () => {
      const manager = new SessionManager();

      expect(() => manager.getSession("abc-999")).toThrow("abc-999");
    });
  });

  // -----------------------------------------------------------------------
  // removeSession
  // -----------------------------------------------------------------------

  describe("removeSession", () => {
    it("cleans up the session and deletes it", () => {
      const manager = new SessionManager();
      const id = manager.createSession();
      const session = manager.getSession(id);

      const unsub = vi.fn();
      session.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: unsub,
      });
      session.identity = { subject: "user1" };

      manager.removeSession(id);

      // cleanup was called
      expect(unsub).toHaveBeenCalledOnce();
      expect(session.activeQueries.size).toBe(0);
      expect(session.identity).toBeNull();

      // session is deleted
      expect(() => manager.getSession(id)).toThrow("Session not found");
    });

    it("is a no-op for unknown session IDs", () => {
      const manager = new SessionManager();
      expect(() => manager.removeSession("nonexistent")).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple sessions
  // -----------------------------------------------------------------------

  describe("multiple sessions", () => {
    it("each has independent state", () => {
      const manager = new SessionManager();
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      const session1 = manager.getSession(id1);
      const session2 = manager.getSession(id2);

      // Mutate session1
      session1.identity = { subject: "alice" };
      session1.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: vi.fn(),
      });

      // session2 should be unaffected
      expect(session2.identity).toBeNull();
      expect(session2.activeQueries.size).toBe(0);
    });

    it("removing one session does not affect others", () => {
      const manager = new SessionManager();
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      manager.removeSession(id1);

      // session2 is still accessible
      expect(() => manager.getSession(id2)).not.toThrow();
      expect(manager.getSession(id2).id).toBe(id2);
    });
  });
});
