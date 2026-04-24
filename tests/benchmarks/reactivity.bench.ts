import { RuntimeProtocolQueryRegistry } from "@embedded/runtime/registry";
import type { ProtocolExecutor } from "@embedded/sync/protocol";
import { SyncProtocolHandler } from "@embedded/sync/protocol";
import { SubscriptionManager } from "@embedded/sync/subscriptions";
import { bench, describe } from "@tests/testkit";

function createExecutor(): ProtocolExecutor {
  return {
    runQuery: async (_context, udfPath) => {
      const tableName = udfPath.startsWith("tasks:") ? "tasks" : "messages";
      return {
        result: { tableName },
        tablesRead: new Set([tableName]),
        dependencies: [
          {
            type: "IndexRange",
            tableName,
            indexName: "by_status",
            range: [{ type: "Eq", fieldPath: "status", value: "active" }],
            order: "asc",
          },
        ],
      };
    },
    runMutation: async () => ({
      result: null,
      tablesWritten: new Set(["tasks"]),
      changes: [
        {
          tableName: "tasks",
          before: { _id: "a" as any, _creationTime: 1, status: "queued" },
          after: { _id: "a" as any, _creationTime: 1, status: "active" },
        },
      ],
    }),
    runAction: async () => null,
  };
}

async function seedProtocol(queryCount: number): Promise<SyncProtocolHandler> {
  const subscriptions = new SubscriptionManager();
  const protocol = new SyncProtocolHandler({
    executor: createExecutor(),
    queryStore: new RuntimeProtocolQueryRegistry(subscriptions),
    auth: { verifyToken: async () => ({ identity: null, identityKey: null }) },
  });

  await protocol.handleMessage("session-a", {
    type: "Connect",
    sessionId: "session-a",
    connectionCount: 1,
    lastCloseReason: null,
    clientTs: 0,
  });

  await protocol.handleMessage("session-a", {
    type: "ModifyQuerySet",
    baseVersion: 0,
    newVersion: 1,
    modifications: Array.from({ length: queryCount }, (_, index) => ({
      type: "Add" as const,
      queryId: index,
      udfPath: index % 2 === 0 ? `tasks:list${index}` : `messages:list${index}`,
      args: [],
    })),
  });

  return protocol;
}

const protocolPromise = seedProtocol(5_000);

async function seedMultiSessionProtocol(
  sessions: number,
  queriesPerSession: number,
): Promise<SyncProtocolHandler> {
  const subscriptions = new SubscriptionManager();
  const protocol = new SyncProtocolHandler({
    executor: createExecutor(),
    queryStore: new RuntimeProtocolQueryRegistry(subscriptions),
    auth: { verifyToken: async () => ({ identity: null, identityKey: null }) },
  });

  for (let sessionIndex = 0; sessionIndex < sessions; sessionIndex += 1) {
    const sessionId = `session-${sessionIndex}`;
    await protocol.handleMessage(sessionId, {
      type: "Connect",
      sessionId,
      connectionCount: 1,
      lastCloseReason: null,
      clientTs: 0,
    });

    await protocol.handleMessage(sessionId, {
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: Array.from(
        { length: queriesPerSession },
        (_, queryIndex) => ({
          type: "Add" as const,
          queryId: queryIndex,
          udfPath:
            (queryIndex + sessionIndex) % 2 === 0
              ? `tasks:list${sessionIndex}-${queryIndex}`
              : `messages:list${sessionIndex}-${queryIndex}`,
          args: [],
        }),
      ),
    });
  }

  return protocol;
}

const multiSessionProtocolPromise = seedMultiSessionProtocol(5, 1_000);

describe("reactivity", () => {
  bench("protocol reEvaluateQueries 5k targeted change", async () => {
    const protocol = await protocolPromise;
    await protocol.reEvaluateQueries([
      {
        tableName: "tasks",
        before: { _id: "a" as any, _creationTime: 1, status: "queued" },
        after: { _id: "a" as any, _creationTime: 1, status: "active" },
      },
    ]);
  });

  bench("protocol mutation handling 5k active queries", async () => {
    const protocol = await protocolPromise;
    await protocol.handleMessage("session-a", {
      type: "Mutation",
      requestId: 1,
      udfPath: "tasks:mutate",
      args: [],
    });
  });

  bench("protocol reEvaluateQueries 5 sessions x 1k queries", async () => {
    const protocol = await multiSessionProtocolPromise;
    await protocol.reEvaluateQueries([
      {
        tableName: "tasks",
        before: { _id: "a" as any, _creationTime: 1, status: "queued" },
        after: { _id: "a" as any, _creationTime: 1, status: "active" },
      },
    ]);
  });
});
