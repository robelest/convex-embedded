import {
  createSession,
  createSessionManager,
} from "@embedded/replication/session";
import { describe, expect, it, vi } from "@tests/testkit";

describe.concurrent("Session", () => {
  describe("constructor", () => {
    it("stores the provided id", () => {
      expect(createSession("abc-123").id).toBe("abc-123");
    });

    it("initializes activeQueries as an empty map", () => {
      const session = createSession("s1");
      expect(session.activeQueries).toBeInstanceOf(Map);
      expect(session.activeQueries.size).toBe(0);
    });

    it("initializes identity as null", () => {
      expect(createSession("s1").identity).toBeNull();
    });

    it("initializes lastStateVersion with zeroed-out values", () => {
      expect(createSession("s1").lastStateVersion).toEqual({
        querySet: 0,
        ts: 0,
        identity: 0,
      });
    });
  });

  describe("cleanup", () => {
    it("calls unsubscribe on all active queries", () => {
      const session = createSession("s1");
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
      const session = createSession("s1");
      session.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: vi.fn(),
      });

      session.cleanup();

      expect(session.activeQueries.size).toBe(0);
    });

    it("resets identity to null", () => {
      const session = createSession("s1");
      session.identity = { subject: "user1" };

      session.cleanup();

      expect(session.identity).toBeNull();
    });

    it("is safe to call when no active queries exist", () => {
      expect(() => createSession("s1").cleanup()).not.toThrow();
    });
  });
});

describe.concurrent("SessionManager", () => {
  describe("createSession", () => {
    it("returns a unique session ID", () => {
      const manager = createSessionManager();

      expect(manager.createSession()).not.toBe(manager.createSession());
    });

    it("returns a non-empty string", () => {
      const id = createSessionManager().createSession();

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe("getSession", () => {
    it("returns the session by ID", () => {
      const manager = createSessionManager();
      const id = manager.createSession();

      const session = manager.getSession(id);

      expect(session.id).toBe(id);
      expect(session.activeQueries).toBeInstanceOf(Map);
    });

    it("returns the same Session instance on repeated calls", () => {
      const manager = createSessionManager();
      const id = manager.createSession();

      expect(manager.getSession(id)).toBe(manager.getSession(id));
    });
  });

  describe("session not found", () => {
    it("throws for an unknown session ID", () => {
      expect(() => createSessionManager().getSession("nonexistent")).toThrow(
        "Session not found",
      );
    });

    it("throws with the missing session ID in the message", () => {
      expect(() => createSessionManager().getSession("abc-999")).toThrow(
        "abc-999",
      );
    });
  });

  describe("deleteSession", () => {
    it("cleans up the session's active queries", () => {
      const manager = createSessionManager();
      const id = manager.createSession();
      const session = manager.getSession(id);
      const unsub = vi.fn();
      session.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: unsub,
      });
      session.identity = { subject: "user1" };

      manager.deleteSession(id);

      expect(unsub).toHaveBeenCalledOnce();
      expect(session.activeQueries.size).toBe(0);
      expect(session.identity).toBeNull();
    });

    it("deletes the session so it can no longer be retrieved", () => {
      const manager = createSessionManager();
      const id = manager.createSession();

      manager.deleteSession(id);

      expect(() => manager.getSession(id)).toThrow("Session not found");
    });

    it("is a no-op for unknown session IDs", () => {
      expect(() =>
        createSessionManager().deleteSession("nonexistent"),
      ).not.toThrow();
    });
  });

  describe("multiple sessions", () => {
    it("each has independent state", () => {
      const manager = createSessionManager();
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      const session1 = manager.getSession(id1);
      session1.identity = { subject: "alice" };
      session1.activeQueries.set("q1", {
        tableName: "users",
        unsubscribe: vi.fn(),
      });

      const session2 = manager.getSession(id2);
      expect(session2.identity).toBeNull();
      expect(session2.activeQueries.size).toBe(0);
    });

    it("removing one session does not affect others", () => {
      const manager = createSessionManager();
      const id1 = manager.createSession();
      const id2 = manager.createSession();

      manager.deleteSession(id1);

      expect(manager.getSession(id2).id).toBe(id2);
    });
  });
});
