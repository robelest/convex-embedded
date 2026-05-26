import { SubscriptionManager } from "@embedded/replication/subscriptions";
import type { DocumentId, StoredDocument } from "@embedded/runtime/db/types";
import type { QueryDependency } from "@embedded/runtime/db/types";
import { describe, expect, it, vi } from "@tests/testkit";

function docId(value: string): DocumentId {
  return value as unknown as DocumentId;
}

function row(id: string, fields: Record<string, unknown> = {}): StoredDocument {
  return {
    _id: docId(id),
    _creationTime: 1,
    ...fields,
  } as StoredDocument;
}

describe.concurrent("SubscriptionManager", () => {
  describe("subscribe + invalidate", () => {
    it("fires callback when a subscribed table is written", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cb);
      manager.invalidate(new Set(["users"]));

      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe("no false positives", () => {
    it("does NOT fire callback when an unrelated table is written", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users"]), cb);
      manager.invalidate(new Set(["posts"]));

      expect(cb).not.toHaveBeenCalled();
    });
  });

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
      expect(cbUsers).toHaveBeenCalledOnce();
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

  describe("dependency-aware invalidation", () => {
    it("does not fire an index-range subscription for a non-matching change", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();
      const dependencies: QueryDependency[] = [
        {
          type: "IndexRange",
          tableName: "users",
          indexName: "by_age",
          range: [{ type: "Eq", fieldPath: "age", value: 42 }],
          order: "asc",
        },
      ];
      manager.subscribe("q1", new Set(["users"]), dependencies, cb);

      manager.invalidate([
        {
          tableName: "users",
          before: row("u1", { age: 30 }),
          after: row("u1", { age: 31 }),
        },
      ]);

      expect(cb).not.toHaveBeenCalled();
    });

    it("fires an index-range subscription when a change enters the range", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();
      const dependencies: QueryDependency[] = [
        {
          type: "IndexRange",
          tableName: "users",
          indexName: "by_age",
          range: [{ type: "Eq", fieldPath: "age", value: 42 }],
          order: "asc",
        },
      ];
      manager.subscribe("q1", new Set(["users"]), dependencies, cb);

      manager.invalidate([
        {
          tableName: "users",
          before: row("u2", { age: 30 }),
          after: row("u2", { age: 42 }),
        },
      ]);

      expect(cb).toHaveBeenCalledOnce();
    });

    it("matches undefined range values through the Convex undefined sentinel", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();
      const dependencies: QueryDependency[] = [
        {
          type: "IndexRange",
          tableName: "users",
          indexName: "by_optional",
          range: [
            { type: "Eq", fieldPath: "nickname", value: { $undefined: true } },
          ],
          order: "asc",
        },
      ];
      manager.subscribe("q1", new Set(["users"]), dependencies, cb);

      manager.invalidate([
        {
          tableName: "users",
          before: row("u1", { nickname: "sam" }),
          after: row("u1"),
        },
      ]);

      expect(cb).toHaveBeenCalledOnce();
    });

    it("handles bigint equality keys without throwing during invalidation", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();
      const dependencies: QueryDependency[] = [
        {
          type: "IndexRange",
          tableName: "users",
          indexName: "by_balance",
          range: [{ type: "Eq", fieldPath: "balance", value: "5" }],
          order: "asc",
        },
      ];
      manager.subscribe("q1", new Set(["users"]), dependencies, cb);

      expect(() =>
        manager.invalidate([
          {
            tableName: "users",
            before: row("u1", { balance: 4n }),
            after: row("u1", { balance: 5n }),
          },
        ]),
      ).not.toThrow();
    });

    it("falls back to table invalidation when a change lacks precise row data", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();
      const dependencies: QueryDependency[] = [
        {
          type: "IndexRange",
          tableName: "users",
          indexName: "by_age",
          range: [{ type: "Eq", fieldPath: "age", value: 42 }],
          order: "asc",
        },
      ];
      manager.subscribe("q1", new Set(["users"]), dependencies, cb);

      manager.invalidate([{ tableName: "users", before: null, after: null }]);

      expect(cb).toHaveBeenCalledOnce();
    });
  });

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

  describe("fires at most once per invalidation", () => {
    it("fires only once even if multiple subscribed tables overlap with written set", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();

      manager.subscribe("q1", new Set(["users", "posts"]), cb);
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

  describe("unsubscribe", () => {
    it("returned function removes the subscription so callback no longer fires", () => {
      const manager = new SubscriptionManager();
      const cb = vi.fn();
      const unsubscribe = manager.subscribe("q1", new Set(["users"]), cb);

      manager.invalidate(new Set(["users"]));
      expect(cb).toHaveBeenCalledOnce();

      unsubscribe();
      manager.invalidate(new Set(["users"]));
      expect(cb).toHaveBeenCalledOnce();
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

  describe("subscribe with same token", () => {
    it("replaces previous subscription", () => {
      const manager = new SubscriptionManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      manager.subscribe("q1", new Set(["users"]), cb1);
      manager.subscribe("q1", new Set(["posts"]), cb2);

      manager.invalidate(new Set(["users"]));
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();

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

      unsub1();
      manager.invalidate(new Set(["posts"]));

      expect(cb2).not.toHaveBeenCalled();
    });
  });
});
