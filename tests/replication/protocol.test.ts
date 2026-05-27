import type {
  ClientMessage,
  ProtocolAuth,
  ProtocolExecutor,
  ProtocolSessionContext,
  ServerMessage,
} from "@embedded/replication/protocol";
import { ReplicationProtocolHandler } from "@embedded/replication/protocol";
import {
  createSubscriptionManager,
  type SubscriptionManager,
} from "@embedded/replication/subscriptions";
import { RuntimeProtocolQueryRegistry } from "@embedded/runtime/registry";
import { flushMicrotasks } from "@tests/helpers/time";
import { describe, expect, it, vi, type Mock } from "@tests/testkit";
import { ConvexError } from "convex/values";

type Transition = Extract<ServerMessage, { type: "Transition" }>;
type MutationResponse = Extract<ServerMessage, { type: "MutationResponse" }>;
type ActionResponse = Extract<ServerMessage, { type: "ActionResponse" }>;
type Modification = Transition["modifications"][number];

type ExecutorMock = {
  runQuery: Mock<
    (
      context: ProtocolSessionContext,
      udfPath: string,
      ...args: unknown[]
    ) => Promise<unknown>
  >;
  runMutation: Mock<
    (
      context: ProtocolSessionContext,
      udfPath: string,
      ...args: unknown[]
    ) => Promise<unknown>
  >;
  runAction: Mock<
    (
      context: ProtocolSessionContext,
      udfPath: string,
      ...args: unknown[]
    ) => Promise<unknown>
  >;
};

type AuthMock = { verifyToken: Mock<ProtocolAuth["verifyToken"]> };

interface Mocks {
  executor: ExecutorMock;
  subscriptions: SubscriptionManager;
  queryStore: RuntimeProtocolQueryRegistry;
  auth: AuthMock;
}

function createMocks(): Mocks {
  const executor: ExecutorMock = {
    runQuery: vi.fn().mockResolvedValue({ items: [] }),
    runMutation: vi.fn().mockResolvedValue("mutationResult"),
    runAction: vi.fn().mockResolvedValue("actionResult"),
  };
  const subscriptions = createSubscriptionManager();
  const queryStore = new RuntimeProtocolQueryRegistry(subscriptions);
  const auth: AuthMock = {
    verifyToken: vi.fn<ProtocolAuth["verifyToken"]>().mockResolvedValue({
      identity: { subject: "user1", issuer: "test" },
      identityKey: null,
    }),
  };
  return { executor, subscriptions, queryStore, auth };
}

function createHandler(
  mocks: Mocks = createMocks(),
): { handler: ReplicationProtocolHandler } & Mocks {
  const handler = new ReplicationProtocolHandler({
    executor: mocks.executor as unknown as ProtocolExecutor,
    queryStore: mocks.queryStore,
    auth: mocks.auth as unknown as ProtocolAuth,
  });
  return { handler, ...mocks };
}

/** Decode a base64-encoded LE u64 back to a number (inverse of the wire encoder). */
function decodeU64(base64: string): number {
  const binary = atob(base64);
  let val = 0;
  for (let i = binary.length - 1; i >= 0; i--) {
    val = val * 256 + binary.charCodeAt(i);
  }
  return val;
}

function transitionAt(messages: ServerMessage[], index = 0): Transition {
  const msg = messages[index];
  if (msg?.type !== "Transition") {
    throw new Error(`expected Transition at ${index}, got ${msg?.type}`);
  }
  return msg;
}

function mutationResponseAt(
  messages: ServerMessage[],
  index = 0,
): MutationResponse {
  const msg = messages[index];
  if (msg?.type !== "MutationResponse") {
    throw new Error(`expected MutationResponse at ${index}, got ${msg?.type}`);
  }
  return msg;
}

function actionResponseAt(
  messages: ServerMessage[],
  index = 0,
): ActionResponse {
  const msg = messages[index];
  if (msg?.type !== "ActionResponse") {
    throw new Error(`expected ActionResponse at ${index}, got ${msg?.type}`);
  }
  return msg;
}

function modificationAt(transition: Transition, index = 0): Modification {
  const mod = transition.modifications[index];
  if (mod === undefined) {
    throw new Error(`expected a modification at ${index}`);
  }
  return mod;
}

function connect(sessionId: string, connectionCount = 0): ClientMessage {
  return {
    type: "Connect",
    sessionId,
    connectionCount,
    lastCloseReason: null,
    clientTs: Date.now(),
  };
}

describe("ReplicationProtocolHandler", () => {
  describe("Connect", () => {
    it("returns a single Transition with matching start and end version", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage(
        "session1",
        connect("session1"),
      );

      expect(messages).toHaveLength(1);
      const msg = transitionAt(messages);
      expect(msg.startVersion).toEqual(msg.endVersion);
      expect(msg.modifications).toEqual([]);
    });

    it("returns version with SDK-correct field names", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", connect("s1"));

      const msg = transitionAt(messages);
      expect(msg.startVersion).toHaveProperty("querySet", 0);
      expect(msg.startVersion).toHaveProperty("identity", 0);
      expect(typeof msg.startVersion.ts).toBe("string");
      expect(decodeU64(msg.startVersion.ts)).toBe(0);
    });

    it("does not use old field names (querySetVersion)", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", connect("s1"));

      expect(transitionAt(messages).startVersion).not.toHaveProperty(
        "querySetVersion",
      );
    });
  });

  describe("ModifyQuerySet Add", () => {
    it("runs the query and returns its result in the modifications array", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockResolvedValue({
        result: [{ id: 1, name: "Alice" }],
        tablesRead: new Set<string>(),
      });

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      });

      expect(messages).toHaveLength(1);
      const transition = transitionAt(messages);
      expect(Array.isArray(transition.modifications)).toBe(true);
      expect(transition.modifications).toHaveLength(1);

      const mod = modificationAt(transition);
      expect(mod.type).toBe("QueryUpdated");
      expect(mod.queryId).toBe(0);
      if (mod.type === "QueryUpdated") {
        expect(mod.value).toEqual([{ id: 1, name: "Alice" }]);
        expect(mod.logLines).toEqual([]);
      }
      expect(executor.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1" }),
        "users:list",
      );
    });

    it("serializes query re-evaluation with later query-set changes", async () => {
      const { handler, executor } = createHandler();

      await handler.handleMessage("s1", connect("s1"));
      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      });

      let release!: () => void;
      executor.runQuery.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ items: ["stale"] });
          }),
      );

      const reevaluatePromise = handler.reEvaluateQueries();

      let modifyResolved = false;
      const modifyPromise = handler
        .handleMessage("s1", {
          type: "ModifyQuerySet",
          baseVersion: 1,
          newVersion: 2,
          modifications: [
            {
              type: "Add",
              queryId: 1,
              udfPath: "users:detail",
              args: [{ id: "123" }],
            },
          ],
        })
        .then((value) => {
          modifyResolved = true;
          return value;
        });

      await flushMicrotasks(10);
      expect(modifyResolved).toBe(false);

      release();

      const reevaluated = await reevaluatePromise;
      const reevalTransition = transitionAt(reevaluated.get("s1") ?? []);
      const modifyTransition = transitionAt(await modifyPromise);

      expect(modifyTransition.startVersion.querySet).toBe(1);
      expect(modifyTransition.endVersion.querySet).toBe(2);
      expect(decodeU64(modifyTransition.endVersion.ts)).toBeGreaterThan(
        decodeU64(reevalTransition.endVersion.ts),
      );
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
      });

      expect(executor.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1" }),
        "users:get",
        { id: "123" },
      );
    });

    it("sets endVersion.querySet to newVersion from the message", async () => {
      const { handler } = createHandler();
      await handler.handleMessage("s1", connect("s1"));

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 3,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      });

      expect(transitionAt(messages).endVersion.querySet).toBe(3);
    });

    it("advances the ts in endVersion", async () => {
      const { handler } = createHandler();
      await handler.handleMessage("s1", connect("s1"));

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      });

      const msg = transitionAt(messages);
      expect(decodeU64(msg.endVersion.ts)).toBeGreaterThan(
        decodeU64(msg.startVersion.ts),
      );
    });

    it("rejects a stale baseVersion with a FatalError and runs no query", async () => {
      const { handler, executor } = createHandler();
      await handler.handleMessage("s1", connect("s1"));
      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      });
      executor.runQuery.mockClear();

      const staleMessages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 2,
        modifications: [
          { type: "Add", queryId: 1, udfPath: "users:detail", args: [] },
        ],
      });

      expect(staleMessages).toEqual([
        {
          type: "FatalError",
          error: "ModifyQuerySet baseVersion mismatch: expected 1, received 0",
        },
      ]);
      expect(executor.runQuery).not.toHaveBeenCalled();
    });

    it("leaves the previously active query intact after a stale baseVersion", async () => {
      const { handler } = createHandler();
      await handler.handleMessage("s1", connect("s1"));
      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
        ],
      });
      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 2,
        modifications: [
          { type: "Add", queryId: 1, udfPath: "users:detail", args: [] },
        ],
      });

      const mutationMessages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 1,
        udfPath: "users:create",
        args: [{}],
      });

      const transition = transitionAt(mutationMessages, 1);
      expect(transition.modifications).toHaveLength(1);
      expect(modificationAt(transition).queryId).toBe(0);
    });
  });

  describe("ModifyQuerySet Add with error", () => {
    it("returns a QueryFailed modification with the error message", async () => {
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
      });

      const transition = transitionAt(messages);
      expect(transition.modifications).toHaveLength(1);
      const mod = modificationAt(transition);
      expect(mod.type).toBe("QueryFailed");
      expect(mod.queryId).toBe(0);
      if (mod.type === "QueryFailed") {
        expect(mod.errorMessage).toBe("Query failed: table not found");
        expect(mod.logLines).toContain("Query failed: table not found");
      }
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
      });

      const mod = modificationAt(transitionAt(messages));
      expect(mod.type).toBe("QueryFailed");
      if (mod.type === "QueryFailed") {
        expect(mod.errorMessage).toBe("string error");
        expect(mod.logLines).toContain("string error");
      }
    });
  });

  describe("ModifyQuerySet Remove", () => {
    it("is acknowledged with a Transition and no modification entry", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [{ type: "Remove", queryId: 0 }],
      });

      expect(transitionAt(messages).modifications).toHaveLength(0);
    });
  });

  describe("Mutation success", () => {
    it("returns a MutationResponse with success, result, and a ts", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockResolvedValue({
        result: { inserted: true },
        tablesWritten: null,
      });

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 42,
        udfPath: "users:create",
        args: [{ name: "Alice" }],
      });

      expect(messages).toHaveLength(1);
      const msg = mutationResponseAt(messages);
      expect(msg.requestId).toBe(42);
      expect(msg.success).toBe(true);
      expect(msg.result).toEqual({ inserted: true });
      expect(msg.logLines).toEqual([]);
      expect(typeof msg.ts).toBe("string");
      expect(decodeU64(msg.ts ?? "")).toBeGreaterThan(0);
    });

    it("passes args to the mutation executor", async () => {
      const { handler, executor } = createHandler();

      await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 1,
        udfPath: "users:create",
        args: [{ name: "Bob" }],
      });

      expect(executor.runMutation).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1" }),
        "users:create",
        { name: "Bob" },
      );
    });

    it("does not re-evaluate queries whose read tables do not overlap the write", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery
        .mockResolvedValueOnce({
          result: { items: ["users"] },
          tablesRead: new Set(["users"]),
          dependencies: [],
        })
        .mockResolvedValueOnce({
          result: { items: ["messages"] },
          tablesRead: new Set(["messages"]),
          dependencies: [],
        });
      await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "users:list", args: [] },
          { type: "Add", queryId: 1, udfPath: "messages:list", args: [] },
        ],
      });
      executor.runQuery.mockClear();
      executor.runMutation.mockResolvedValueOnce({
        result: { ok: true },
        tablesWritten: new Set(["messages"]),
        changes: [
          {
            tableName: "messages",
            before: { _id: "m1", _creationTime: 1, status: "queued" },
            after: { _id: "m1", _creationTime: 1, status: "active" },
          },
        ],
      });
      executor.runQuery.mockResolvedValueOnce({
        result: { items: ["messages-2"] },
        tablesRead: new Set(["messages"]),
        dependencies: [],
      });

      await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 2,
        udfPath: "messages:update",
        args: [],
      });

      expect(executor.runQuery).toHaveBeenCalledTimes(1);
      expect(executor.runQuery).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1" }),
        "messages:list",
      );
    });
  });

  describe("Mutation failure", () => {
    it("returns a MutationResponse with success=false and the error in result", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockRejectedValue(new Error("Validation failed"));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 7,
        udfPath: "users:create",
        args: [{}],
      });

      expect(messages).toHaveLength(1);
      const msg = mutationResponseAt(messages);
      expect(msg.requestId).toBe(7);
      expect(msg.success).toBe(false);
      expect(msg.result).toBe("Validation failed");
      expect(msg.logLines).toEqual([]);
      expect(msg.ts).toBeUndefined();
    });
  });

  describe("Action success", () => {
    it("returns an ActionResponse with success and result", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockResolvedValue({ sent: true });

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 10,
        udfPath: "emails:send",
        args: [{ to: "alice@example.com" }],
      });

      expect(messages).toHaveLength(1);
      const msg = actionResponseAt(messages);
      expect(msg.requestId).toBe(10);
      expect(msg.success).toBe(true);
      expect(msg.result).toEqual({ sent: true });
      expect(msg.logLines).toEqual([]);
    });
  });

  describe("Action failure", () => {
    it("returns an ActionResponse with success=false and the error in result", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockRejectedValue(new Error("Network timeout"));

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 11,
        udfPath: "emails:send",
        args: [],
      });

      expect(messages).toHaveLength(1);
      const msg = actionResponseAt(messages);
      expect(msg.requestId).toBe(11);
      expect(msg.success).toBe(false);
      expect(msg.result).toBe("Network timeout");
      expect(msg.logLines).toEqual([]);
    });
  });

  describe("Authenticate success", () => {
    it("returns a Transition with an incremented identity version", async () => {
      const { handler } = createHandler();
      const connectMsgs = await handler.handleMessage("s1", connect("s1"));
      const initialVersion = transitionAt(connectMsgs).endVersion;

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "valid-jwt-token",
        baseVersion: 0,
      });

      expect(messages).toHaveLength(1);
      const msg = transitionAt(messages);
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
      });

      expect(auth.verifyToken).toHaveBeenCalledWith("my-secret-token");
    });

    it("rejects a stale baseVersion with an AuthError and skips verification", async () => {
      const { handler, auth } = createHandler();
      await handler.handleMessage("s1", connect("s1"));
      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "valid-jwt-token",
        baseVersion: 0,
      });
      auth.verifyToken.mockClear();

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "stale-jwt-token",
        baseVersion: 0,
      });

      expect(messages).toEqual([
        {
          type: "AuthError",
          error: "Authenticate baseVersion mismatch: expected 1, received 0",
          baseVersion: 0,
          authUpdateAttempted: false,
        },
      ]);
      expect(auth.verifyToken).not.toHaveBeenCalled();
    });

    it("still advances identity after a rejected stale baseVersion", async () => {
      const { handler } = createHandler();
      await handler.handleMessage("s1", connect("s1"));
      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "valid-jwt-token",
        baseVersion: 0,
      });
      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "stale-jwt-token",
        baseVersion: 0,
      });

      const clearMessages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "None",
        baseVersion: 1,
      });

      const clearTransition = transitionAt(clearMessages);
      expect(clearTransition.startVersion.identity).toBe(1);
      expect(clearTransition.endVersion.identity).toBe(2);
    });
  });

  describe("Authenticate failure", () => {
    it("returns an AuthError with the error field (not errorMessage)", async () => {
      const { handler, auth } = createHandler();
      auth.verifyToken.mockRejectedValue(new Error("Token expired"));

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "expired-token",
        baseVersion: 0,
      });

      expect(messages).toEqual([
        {
          type: "AuthError",
          error: "Token expired",
          baseVersion: 0,
          authUpdateAttempted: true,
        },
      ]);
    });

    it("does not increment the identity version on failure", async () => {
      const { handler, auth } = createHandler();
      const connectMsgs = await handler.handleMessage("s1", connect("s1"));
      const initialIdentity = transitionAt(connectMsgs).endVersion.identity;
      auth.verifyToken.mockRejectedValue(new Error("bad token"));

      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "bad",
        baseVersion: 0,
      });
      const reconnectMsgs = await handler.handleMessage("s1", connect("s1", 1));

      expect(transitionAt(reconnectMsgs).endVersion.identity).toBe(
        initialIdentity,
      );
    });
  });

  describe("Authenticate None", () => {
    it("clears auth and returns a Transition with incremented identity", async () => {
      const { handler } = createHandler();
      await handler.handleMessage("s1", connect("s1"));
      await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "User",
        value: "token",
        baseVersion: 0,
      });

      const messages = await handler.handleMessage("s1", {
        type: "Authenticate",
        tokenType: "None",
        baseVersion: 1,
      });

      expect(transitionAt(messages).endVersion.identity).toBe(2);
    });
  });

  describe("Event", () => {
    it("returns an empty array (silent ack)", async () => {
      const { handler } = createHandler();

      const messages = await handler.handleMessage("s1", {
        type: "Event",
        eventType: "ClientConnect",
        event: { some: "data" },
      });

      expect(messages).toEqual([]);
    });
  });

  describe("ModifyQuerySet multiple modifications", () => {
    it("processes multiple Add queries and returns all in the modifications array", async () => {
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
          { type: "Add", queryId: 1, udfPath: "users:active", args: [] },
        ],
      });

      const transition = transitionAt(messages);
      expect(transition.modifications).toHaveLength(2);
      const first = modificationAt(transition, 0);
      const second = modificationAt(transition, 1);
      expect(first.queryId).toBe(0);
      expect(second.queryId).toBe(1);
      if (first.type === "QueryUpdated") {
        expect(first.value).toEqual([{ name: "Alice" }]);
      }
      if (second.type === "QueryUpdated") {
        expect(second.value).toEqual([{ name: "Bob" }]);
      }
    });
  });

  describe("ConvexError propagation", () => {
    it("query failure includes errorData when the UDF throws a ConvexError", async () => {
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
      });

      const mod = modificationAt(transitionAt(messages));
      expect(mod.type).toBe("QueryFailed");
      if (mod.type === "QueryFailed") {
        expect(mod.errorData).toEqual({ code: "NOT_FOUND", id: "abc123" });
      }
    });

    it("query failure has null errorData for a plain Error", async () => {
      const { handler, executor } = createHandler();
      executor.runQuery.mockRejectedValue(new Error("plain error"));

      const messages = await handler.handleMessage("s1", {
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
        modifications: [
          { type: "Add", queryId: 0, udfPath: "items:get", args: [] },
        ],
      });

      const mod = modificationAt(transitionAt(messages));
      expect(mod.type).toBe("QueryFailed");
      if (mod.type === "QueryFailed") {
        expect(mod.errorData).toBeNull();
      }
    });

    it("mutation failure includes errorData when the UDF throws a ConvexError", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockRejectedValue(new ConvexError("access denied"));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 1,
        udfPath: "items:delete",
        args: [{}],
      });

      const msg = mutationResponseAt(messages);
      expect(msg.success).toBe(false);
      expect(msg.errorData).toBe("access denied");
    });

    it("mutation failure omits errorData for a plain Error", async () => {
      const { handler, executor } = createHandler();
      executor.runMutation.mockRejectedValue(new Error("internal"));

      const messages = await handler.handleMessage("s1", {
        type: "Mutation",
        requestId: 2,
        udfPath: "items:delete",
        args: [{}],
      });

      const msg = mutationResponseAt(messages);
      expect(msg.success).toBe(false);
      expect(msg.errorData).toBeUndefined();
    });

    it("action failure includes errorData when the UDF throws a ConvexError", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockRejectedValue(
        new ConvexError({ reason: "rate_limited", retryAfter: 30 }),
      );

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 5,
        udfPath: "api:call",
        args: [],
      });

      const msg = actionResponseAt(messages);
      expect(msg.success).toBe(false);
      expect(msg.errorData).toEqual({ reason: "rate_limited", retryAfter: 30 });
    });

    it("action failure omits errorData for a plain Error", async () => {
      const { handler, executor } = createHandler();
      executor.runAction.mockRejectedValue(new Error("timeout"));

      const messages = await handler.handleMessage("s1", {
        type: "Action",
        requestId: 6,
        udfPath: "api:call",
        args: [],
      });

      const msg = actionResponseAt(messages);
      expect(msg.success).toBe(false);
      expect(msg.errorData).toBeUndefined();
    });

    it("a ConvexError with nested object data round-trips correctly", async () => {
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
      });

      expect(mutationResponseAt(messages).errorData).toEqual(nestedData);
    });
  });
});
