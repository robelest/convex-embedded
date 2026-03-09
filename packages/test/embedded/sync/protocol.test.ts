import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncProtocolHandler } from "#embedded/sync/protocol.js";
import type { ClientMessage, ServerMessage, StateVersion } from "#embedded/sync/protocol.js";
import { SubscriptionManager } from "#embedded/sync/subscriptions.js";

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
    verifyToken: vi.fn().mockResolvedValue({ subject: "user1", issuer: "test" }),
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
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(msg.startVersion).toEqual(msg.endVersion);
      expect(msg.modifications).toEqual({});
    });

    it("returns version with initial zeroed-out values", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.startVersion).toEqual({
        querySetVersion: 0,
        ts: 0,
        identity: 0,
      });
    });
  });

  // -----------------------------------------------------------------------
  // ModifyQuerySet — Add
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet Add", () => {
    it("runs the query and returns result in modifications", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockResolvedValue([{ id: 1, name: "Alice" }]);

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        modifications: [
          {
            type: "Add",
            queryToken: "qt1",
            udfPath: "users:list",
            args: [],
          },
        ],
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(msg.modifications["qt1"]).toBeDefined();
      expect(msg.modifications["qt1"].result).toEqual([{ id: 1, name: "Alice" }]);
      expect(msg.modifications["qt1"].logLines).toEqual([]);

      expect(executor.runQuery).toHaveBeenCalledWith("users:list");
    });

    it("passes args to the query executor", async () => {
      const { handler, executor } = createHandler();

      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        modifications: [
          {
            type: "Add",
            queryToken: "qt1",
            udfPath: "users:get",
            args: [{ id: "123" }],
          },
        ],
      } as ClientMessage);

      expect(executor.runQuery).toHaveBeenCalledWith("users:get", { id: "123" });
    });

    it("increments querySetVersion in endVersion", async () => {
      const { handler } = createHandler();

      // First, connect to initialize the session
      await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
      } as ClientMessage);

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        modifications: [
          { type: "Add", queryToken: "qt1", udfPath: "users:list", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.endVersion.querySetVersion).toBe(
        msg.startVersion.querySetVersion + 1,
      );
    });
  });

  // -----------------------------------------------------------------------
  // ModifyQuerySet — Add with error
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet Add with error", () => {
    it("catches the error and puts message in logLines", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue(new Error("Query failed: table not found"));

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        modifications: [
          { type: "Add", queryToken: "qt1", udfPath: "bad:query", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(msg.modifications["qt1"].result).toBeUndefined();
      expect(msg.modifications["qt1"].logLines).toContain(
        "Query failed: table not found",
      );
    });

    it("handles non-Error thrown values", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue("string error");

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        modifications: [
          { type: "Add", queryToken: "qt1", udfPath: "bad:query", args: [] },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.modifications["qt1"].logLines).toContain("string error");
    });
  });

  // -----------------------------------------------------------------------
  // ModifyQuerySet — Remove
  // -----------------------------------------------------------------------

  describe("ModifyQuerySet Remove", () => {
    it("is acknowledged without error and no result in modifications", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        modifications: [
          { type: "Remove", queryToken: "qt1" },
        ],
      } as ClientMessage);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      // Remove should not produce a modification entry
      expect(msg.modifications["qt1"]).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Mutation — success
  // -----------------------------------------------------------------------

  describe("Mutation success", () => {
    it("returns MutationResponse with success=true and result", async () => {
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
    it("returns MutationResponse with success=false and errorMessage", async () => {
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
      expect(msg.errorMessage).toBe("Validation failed");
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
    });
  });

  // -----------------------------------------------------------------------
  // Action — failure
  // -----------------------------------------------------------------------

  describe("Action failure", () => {
    it("returns ActionResponse with success=false and errorMessage", async () => {
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
      expect(msg.errorMessage).toBe("Network timeout");
    });
  });

  // -----------------------------------------------------------------------
  // Authenticate — success
  // -----------------------------------------------------------------------

  describe("Authenticate success", () => {
    it("returns Transition with incremented identity version", async () => {
      const { handler } = createHandler();

      // Connect first to establish session
      const connectMsgs = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
      } as ClientMessage);
      const initialVersion = (connectMsgs[0] as any).endVersion;

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        token: "valid-jwt-token",
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("Transition");
      expect(msg.endVersion.identity).toBe(initialVersion.identity + 1);
      expect(msg.modifications).toEqual({});
    });

    it("calls auth.verifyToken with the provided token", async () => {
      const { handler, auth } = createHandler();

      await handler.handleMessage("s1", {
        type: "Authenticate",
        token: "my-secret-token",
      } as ClientMessage);

      expect(auth.verifyToken).toHaveBeenCalledWith("my-secret-token");
    });
  });

  // -----------------------------------------------------------------------
  // Authenticate — failure
  // -----------------------------------------------------------------------

  describe("Authenticate failure", () => {
    it("returns AuthError when verifyToken rejects", async () => {
      const { handler, auth } = createHandler();
      auth.verifyToken.mockRejectedValue(new Error("Token expired"));

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        token: "expired-token",
      } as ClientMessage);

      expect(messages).toHaveLength(1);

      const msg = messages[0] as any;
      expect(msg.type).toBe("AuthError");
      expect(msg.errorMessage).toBe("Token expired");
    });

    it("does not increment identity version on failure", async () => {
      const { handler, auth } = createHandler();

      // Connect first
      const connectMsgs = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
      } as ClientMessage);
      const initialIdentity = (connectMsgs[0] as any).endVersion.identity;

      // Fail auth
      auth.verifyToken.mockRejectedValue(new Error("bad token"));
      await handler.handleMessage("s1", {
        type: "Authenticate",
        token: "bad",
      } as ClientMessage);

      // Connect again to check version
      const reconnectMsgs = await handler.handleMessage("s1", {
        type: "Connect",
        sessionId: "s1",
      } as ClientMessage);
      const currentIdentity = (reconnectMsgs[0] as any).endVersion.identity;

      expect(currentIdentity).toBe(initialIdentity);
    });
  });
});
