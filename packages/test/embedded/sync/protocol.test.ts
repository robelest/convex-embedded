import { ConvexError } from "convex/values";
import { describe, it, expect, vi } from "vitest";

import { SyncProtocolHandler } from "#embedded/sync/protocol";
import type { ClientMessage } from "#embedded/sync/protocol";
import { SubscriptionManager } from "#embedded/sync/subscriptions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMocks() {
  const executor = {
    runQuery: vi.fn().mockResolvedValue({ items: [] }),
    runMutation: vi.fn().mockResolvedValue("mutationResult"),
    runAction: vi.fn().mockResolvedValue("actionResult"),
  };
  const subscriptions = new SubscriptionManager();
  const auth = {
    verifyToken: vi
      .fn()
      .mockResolvedValue({ subject: "user1", issuer: "test" }),
  };

  return { executor, subscriptions, auth };
}

function createHandler(mocks = createMocks()) {
  const handler = new SyncProtocolHandler({
    executor: mocks.executor,
    subscriptions: mocks.subscriptions,
    auth: mocks.auth,
  });
  return { handler, ...mocks };
}

/**
 * Decode a base64-encoded LE u64 back to a number.
 * Inverse of `numberToEncodedU64` in protocol.ts.
 */
function decodeU64(base64: string): number {
  const binary = atob(base64);
  let val = 0;
  for (let i = binary.length - 1; i >= 0; i--) {
    val = val * 256 + binary.charCodeAt(i);
  }
  return val;
}

// ---------------------------------------------------------------------------
// SyncProtocolHandler
// ---------------------------------------------------------------------------

describe("SyncProtocolHandler", () => {
  // -----------------------------------------------------------------------
  // Connect
  // -----------------------------------------------------------------------

  describe("Connect", () => {
    it("returns a Transition with matching start and end version", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("session1", {
        type: "Connect",
        sessionId: "session1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(msg.startVersion).toEqual(msg.endVersion);
      expect(msg.modifications).toEqual([]);
    });

    it("returns version with SDK-correct field names", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);

      const msg = messages[0] as any;
      // Must have: querySet, ts (base64 string), identity
      expect(msg.startVersion).toHaveProperty("querySet", 0);
      expect(msg.startVersion).toHaveProperty("identity", 0);
      // ts is a base64-encoded LE u64 string, not a plain number
      expect(typeof msg.startVersion.ts).toBe("string");
      expect(decodeU64(msg.startVersion.ts)).toBe(0);
    });

    it("does not use old field names (querySetVersion)", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);

      const msg = messages[0] as any;
      // Old format used "querySetVersion" — must NOT be present
      expect(msg.startVersion).not.toHaveProperty("querySetVersion");
    });
  });

  // -----------------------------------------------------------------------
  // ModifyQuerySet — Add (uses queryId, not queryToken)
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet Add", () => {
    it("runs the query and returns result in modifications array", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockResolvedValue([{ id: 1, name: "Alice" }]);

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          {
            type: "Add",
            queryId: 0,
            udfPath: "users:list",
            args: [],
          },
        ],
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      // modifications is an ARRAY, not a Record
      expect(Array.isArray(msg.modifications)).toBe(true);
      expect(msg.modifications).toHaveLength(1);

      const mod = msg.modifications[0];
      expect(mod.type).toBe("QueryUpdated");
      expect(mod.queryId).toBe(0);
      expect(mod.value).toEqual([{ id: 1, name: "Alice" }]);
      expect(mod.logLines).toEqual([]);

      expect(executor.runQuery).toHaveBeenCalledWith("users:list");
    });

    it("passes args to the query executor", async () => {
      const { handler, executor } = createHandler();

      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          {
            type: "Add",
            queryId: 0,
            udfPath: "users:get",
            args: [{ id: "123" }],
          },
        ],
      } as ClientMessage);

      expect(executor.runQuery).toHaveBeenCalledWith("users:get", {
        id: "123",
      });
    });

    it("sets endVersion.querySet to newVersion from message", async () => {
      const { handler } = createHandler();

      // Connect to initialize session
      await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 3,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.endVersion.querySet).toBe(3);
    });

    it("advances the ts in endVersion", async () => {
      const { handler } = createHandler();

      await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      const startTs = decodeU64(msg.startVersion.ts);
      const endTs = decodeU64(msg.endVersion.ts);
      expect(endTs).toBeGreaterThan(startTs);
    });
  });

  // -----------------------------------------------------------------------
  // ModifyQuerySet — Add with error
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet Add with error", () => {
    it("returns QueryFailed modification with error message", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue(
        new Error("Query failed: table not found"),
      );

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "bad:query", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(Array.isArray(msg.modifications)).toBe(true);
      expect(msg.modifications).toHaveLength(1);

      const mod = msg.modifications[0];
      expect(mod.type).toBe("QueryFailed");
      expect(mod.queryId).toBe(0);
      expect(mod.errorMessage).toBe("Query failed: table not found");
      expect(mod.logLines).toContain("Query failed: table not found");
    });

    it("handles non-Error thrown values", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue("string error");

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "bad:query", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      const mod = msg.modifications[0];
      expect(mod.type).toBe("QueryFailed");
      expect(mod.errorMessage).toBe("string error");
      expect(mod.logLines).toContain("string error");
    });
  });

  // -----------------------------------------------------------------------
  // ModifyQuerySet — Remove
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet Remove", () => {
    it("is acknowledged without error and no modification entry", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [{ type: "Remove", queryId: 0 }],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      // Remove should not produce a modification entry
      expect(msg.modifications).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Mutation — success
  // -----------------------------------------------------------------------

  describe("Mutation success", () => {
    it("returns MutationResponse with success=true, result, and ts", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockResolvedValue({ inserted: true });

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 42,
        udfPath: "users:create",
        args: [{ name: "Alice" }],
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("MutationResponse");
      expect(msg.requestId).toBe(42);
      expect(msg.success).toBe(true);
      expect(msg.result).toEqual({ inserted: true });
      expect(msg.logLines).toEqual([]);
      // ts must be a base64 string on success
      expect(typeof msg.ts).toBe("string");
      expect(decodeU64(msg.ts)).toBeGreaterThan(0);
    });

    it("passes args to the mutation executor", async () => {
      const { handler, executor } = createHandler();

      await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 1,
        udfPath: "users:create",
        args: [{ name: "Bob" }],
      } as ClientMessage);

      expect(executor.runMutation).toHaveBeenCalledWith("users:create", {
        name: "Bob",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Mutation — failure
  // -----------------------------------------------------------------------

  describe("Mutation failure", () => {
    it("returns MutationResponse with success=false and error in result", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockRejectedValue(new Error("Validation failed"));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 7,
        udfPath: "users:create",
        args: [{}],
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("MutationResponse");
      expect(msg.requestId).toBe(7);
      expect(msg.success).toBe(false);
      // In SDK wire format, failure puts the error string in `result`, not `errorMessage`
      expect(msg.result).toBe("Validation failed");
      expect(msg.logLines).toEqual([]);
      // No ts on failure
      expect(msg.ts).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Action — success
  // -----------------------------------------------------------------------

  describe("Action success", () => {
    it("returns ActionResponse with success=true and result", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockResolvedValue({ sent: true });

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 10,
        udfPath: "emails:send",
        args: [{ to: "alice@example.com" }],
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("ActionResponse");
      expect(msg.requestId).toBe(10);
      expect(msg.success).toBe(true);
      expect(msg.result).toEqual({ sent: true });
      expect(msg.logLines).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Action — failure
  // -----------------------------------------------------------------------

  describe("Action failure", () => {
    it("returns ActionResponse with success=false and error in result", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockRejectedValue(new Error("Network timeout"));

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 11,
        udfPath: "emails:send",
        args: [],
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("ActionResponse");
      expect(msg.requestId).toBe(11);
      expect(msg.success).toBe(false);
      // Error string in `result`, not `errorMessage`
      expect(msg.result).toBe("Network timeout");
      expect(msg.logLines).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Authenticate — success (uses tokenType/value, not token)
  // -----------------------------------------------------------------------

  describe("Authenticate success", () => {
    it("returns Transition with incremented identity version", async () => {
      const { handler } = createHandler();

      // Connect first to establish session
      const connectMsgs = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);
      const initialVersion = (connectMsgs[0] as any).endVersion;

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "valid-jwt-token",
        baseVersion: 0,
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(msg.endVersion.identity).toBe(initialVersion.identity + 1);
      expect(msg.modifications).toEqual([]);
    });

    it("calls auth.verifyToken with the provided value", async () => {
      const { handler, auth } = createHandler();

      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "my-secret-token",
        baseVersion: 0,
      } as ClientMessage);

      expect(auth.verifyToken).toHaveBeenCalledWith("my-secret-token");
    });
  });

  // -----------------------------------------------------------------------
  // Authenticate — failure
  // -----------------------------------------------------------------------

  describe("Authenticate failure", () => {
    it("returns AuthError with error field (not errorMessage)", async () => {
      const { handler, auth } = createHandler();
      auth.verifyToken.mockRejectedValue(new Error("Token expired"));

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "expired-token",
        baseVersion: 5,
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("AuthError");
      // SDK wire format uses `error`, not `errorMessage`
      expect(msg.error).toBe("Token expired");
      expect(msg.baseVersion).toBe(5);
      expect(msg.authUpdateAttempted).toBe(true);
    });

    it("does not increment identity version on failure", async () => {
      const { handler, auth } = createHandler();

      // Connect first
      const connectMsgs = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);
      const initialIdentity = (connectMsgs[0] as any).endVersion.identity;

      // Fail auth
      auth.verifyToken.mockRejectedValue(new Error("bad token"));
      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "bad",
        baseVersion: 0,
      } as ClientMessage);

      // Connect again to check version
      const reconnectMsgs = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 1,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);
      const currentIdentity = (reconnectMsgs[0] as any).endVersion.identity;

      expect(currentIdentity).toBe(initialIdentity);
    });
  });

  // -----------------------------------------------------------------------
  // Authenticate — None (clear auth)
  // -----------------------------------------------------------------------

  describe("Authenticate None", () => {
    it("clears auth and returns Transition with incremented identity", async () => {
      const { handler } = createHandler();

      // Connect
      await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
        connectionCount: 0,
        lastCloseReason: null,
        clientTs: Date.now(),
      } as ClientMessage);

      // Set auth first
      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "token",
        baseVersion: 0,
      } as ClientMessage);

      // Clear auth
      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "None",
        baseVersion: 0,
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      // Identity should have been incremented (once for set, once for clear)
      expect(msg.endVersion.identity).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Event — silently acknowledged
  // -----------------------------------------------------------------------

  describe("Event", () => {
    it("returns empty array (silent ack)", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "Event",
        eventType: "ClientConnect",
        event: { some: "data" },
      } as ClientMessage);

      expect(messages).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple queries in single ModifyQuerySet
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet multiple modifications", () => {
    it("processes multiple Add queries and returns all in modifications array", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery
        .mockResolvedValueOnce([{ name: "Alice" }])
        .mockResolvedValueOnce([{ name: "Bob" }]);

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 2,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
          {
            type: "Add",
            queryId: 1,
            udfPath: "users:active",
            args: [],
          },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.modifications).toHaveLength(2);

      expect(msg.modifications[0].queryId).toBe(0);
      expect(msg.modifications[0].value).toEqual([{ name: "Alice" }]);

      expect(msg.modifications[1].queryId).toBe(1);
      expect(msg.modifications[1].value).toEqual([{ name: "Bob" }]);
    });
  });

  // -----------------------------------------------------------------------
  // ConvexError propagation
  // -----------------------------------------------------------------------

  describe("ConvexError propagation", () => {
    it("query failure includes errorData when UDF throws ConvexError", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue(
        new ConvexError({ code: "NOT_FOUND", id: "abc123" }),
      );

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "items:get", args: [] },
        ],
      } as ClientMessage);

      const mod = (messages[0] as any).modifications[0];
      expect(mod.type).toBe("QueryFailed");
      expect(mod.errorData).toEqual({ code: "NOT_FOUND", id: "abc123" });
    });

    it("query failure has null errorData for plain Error", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue(new Error("plain error"));

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "items:get", args: [] },
        ],
      } as ClientMessage);

      const mod = (messages[0] as any).modifications[0];
      expect(mod.type).toBe("QueryFailed");
      expect(mod.errorData).toBeNull();
    });

    it("mutation failure includes errorData when UDF throws ConvexError", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockRejectedValue(new ConvexError("access denied"));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 1,
        udfPath: "items:delete",
        args: [{}],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("MutationResponse");
      expect(msg.success).toBe(false);
      expect(msg.errorData).toBe("access denied");
    });

    it("mutation failure omits errorData for plain Error", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockRejectedValue(new Error("internal"));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 2,
        udfPath: "items:delete",
        args: [{}],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("MutationResponse");
      expect(msg.success).toBe(false);
      expect(msg.errorData).toBeUndefined();
    });

    it("action failure includes errorData when UDF throws ConvexError", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockRejectedValue(
        new ConvexError({ reason: "rate_limited", retryAfter: 30 }),
      );

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 5,
        udfPath: "api:call",
        args: [],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("ActionResponse");
      expect(msg.success).toBe(false);
      expect(msg.errorData).toEqual({ reason: "rate_limited", retryAfter: 30 });
    });

    it("action failure omits errorData for plain Error", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockRejectedValue(new Error("timeout"));

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 6,
        udfPath: "api:call",
        args: [],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("ActionResponse");
      expect(msg.success).toBe(false);
      expect(msg.errorData).toBeUndefined();
    });

    it("ConvexError with nested object data round-trips correctly", async () => {
      const { handler, executor } = createHandler();
      const nestedData = {
        errors: [
          { field: "email", message: "invalid format" },
          { field: "age", message: "must be positive" },
        ],
        code: 422,
      };
      executor.runMutation.mockRejectedValue(new ConvexError(nestedData));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 10,
        udfPath: "users:create",
        args: [{}],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.errorData).toEqual(nestedData);
    });
  });
});
