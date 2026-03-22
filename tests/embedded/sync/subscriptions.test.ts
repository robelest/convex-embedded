import { SubscriptionManager } from "@embedded/sync/subscriptions";
import { describe, it, expect, vi } from "vite-plus/test";

describe("SubscriptionManager", () => {
  // -------------------------------------------------------------------------
  // subscribe + invalidate
  // -------------------------------------------------------------------------

  describe("subscribe + invalidate", () => {
    it("fires callback when a subscribed table is written", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cb);
      manager.invalidate(new Set(["users"]));

      expect(cb).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // No false positives
  // -------------------------------------------------------------------------

  describe("no false positives", () => {
    it("does NOT fire callback when an unrelated table is written", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cb);
      manager.invalidate(new Set(["posts"]));

      expect(cb).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple subscriptions
  // -------------------------------------------------------------------------

  describe("multiple subscriptions", () => {
    it("each fires independently when their tables are written", () => {
      const manager = new SubscriptionManager();
      const cbUsers = vi.fn();
      const cbPosts = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cbUsers);
      manager.subscribe("q2", new Set(["posts"]), cbPosts);

      manager.invalidate(new Set(["users"]));

      expect(cbUsers).toHaveBeenCalledOnce();
      expect(cbPosts).not.toHaveBeenCalled();

      manager.invalidate(new Set(["posts"]));

      expect(cbUsers).toHaveBeenCalledOnce(); // still only 1
      expect(cbPosts).toHaveBeenCalledOnce();
    });

    it("fires both when both tables are written at once", () => {
      const manager = new SubscriptionManager();
      const cbUsers = vi.fn();
      const cbPosts = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cbUsers);
      manager.subscribe("q2", new Set(["posts"]), cbPosts);

      manager.invalidate(new Set(["users", "posts"]));

      expect(cbUsers).toHaveBeenCalledOnce();
      expect(cbPosts).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Multi-table subscription
  // -------------------------------------------------------------------------

  describe("multi-table subscription", () => {
    it("fires when ANY of its tables is written", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users", "posts", "comments"]), cb);

      manager.invalidate(new Set(["posts"]));
      expect(cb).toHaveBeenCalledOnce();

      manager.invalidate(new Set(["comments"]));
      expect(cb).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Fires at most once per invalidation
  // -------------------------------------------------------------------------

  describe("fires at most once per invalidation", () => {
    it("fires only once even if multiple subscribed tables overlap with written set", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users", "posts"]), cb);
      // Both "users" and "posts" are in the written set
      manager.invalidate(new Set(["users", "posts"]));

      expect(cb).toHaveBeenCalledOnce();
    });

    it("fires once when written set is a superset of subscribed tables", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users", "posts"]), cb);
      manager.invalidate(new Set(["users", "posts", "comments", "likes"]));

      expect(cb).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Unsubscribe
  // -------------------------------------------------------------------------

  describe("unsubscribe", () => {
    it("returned function removes the subscription so callback no longer fires", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      const unsubscribe = manager.subscribe("q1", new Set(["users"]), cb);

      // Verify it works before unsubscribing
      manager.invalidate(new Set(["users"]));
      expect(cb).toHaveBeenCalledOnce();

      unsubscribe();

      manager.invalidate(new Set(["users"]));
      expect(cb).toHaveBeenCalledOnce(); // still only 1
    });

    it("unsubscribing one does not affect others", () => {
      const manager = new SubscriptionManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = manager.subscribe("q1", new Set(["users"]), cb1);
      manager.subscribe("q2", new Set(["users"]), cb2);

      unsub1();

      manager.invalidate(new Set(["users"]));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Clear
  // -------------------------------------------------------------------------

  describe("clear", () => {
    it("removes all subscriptions", () => {
      const manager = new SubscriptionManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cb1);
      manager.subscribe("q2", new Set(["posts"]), cb2);

      manager.clear();

      manager.invalidate(new Set(["users", "posts"]));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Subscribe with same token replaces previous subscription
  // -------------------------------------------------------------------------

  describe("subscribe with same token", () => {
    it("replaces previous subscription", () => {
      const manager = new SubscriptionManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cb1);
      manager.subscribe("q1", new Set(["posts"]), cb2);

      // Old table should not fire old callback
      manager.invalidate(new Set(["users"]));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();

      // New table fires only the new callback
      manager.invalidate(new Set(["posts"]));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it("old unsubscribe function still removes the token", () => {
      const manager = new SubscriptionManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const unsub1 = manager.subscribe("q1", new Set(["users"]), cb1);
      manager.subscribe("q1", new Set(["posts"]), cb2);

      // The old unsub should delete the token entirely
      unsub1();

      manager.invalidate(new Set(["posts"]));
      expect(cb2).not.toHaveBeenCalled();
    });
  });
});
