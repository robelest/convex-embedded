import type { ProtocolExecutor } from "@embedded/replication/protocol";
import { ReplicationProtocolHandler } from "@embedded/replication/protocol";
import { createSubscriptionManager, type SubscriptionManager } from "@embedded/replication/subscriptions";
import type { DocumentId } from "@embedded/runtime/db/types";
import { RuntimeProtocolQueryRegistry } from "@embedded/runtime/registry";
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
          before: {
            _id: "a" as DocumentId,
            _creationTime: 1,
            status: "queued",
          },
          after: { _id: "a" as DocumentId, _creationTime: 1, status: "active" },
        },
      ],
    }),
    runAction: async () => null,
  };
}

async function seedProtocol(
  queryCount: number,
): Promise<ReplicationProtocolHandler> {
  const subscriptions = createSubscriptionManager();
  const protocol = new ReplicationProtocolHandler({
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

const TARGETED_CHANGE = [
  {
    tableName: "tasks",
    before: { _id: "a" as DocumentId, _creationTime: 1, status: "queued" },
    after: { _id: "a" as DocumentId, _creationTime: 1, status: "active" },
  },
];

const protocol10k = await seedProtocol(10_000);

function buildSubscriptionManager(count: number): SubscriptionManager {
  const manager = createSubscriptionManager();
  for (let index = 0; index < count; index += 1) {
    const tableName = index % 2 === 0 ? "tasks" : "messages";
    manager.subscribe(
      `query-${index}`,
      new Set([tableName]),
      [
        {
          type: "IndexRange",
          tableName,
          indexName: "by_status",
          range: [{ type: "Eq", fieldPath: "status", value: "active" }],
          order: "asc",
        },
      ],
      () => {},
    );
  }
  return manager;
}

const subscriptions10k = buildSubscriptionManager(10_000);

describe("reactivity", () => {
  bench("subscription manager invalidate 10k by table", () => {
    subscriptions10k.invalidate(new Set(["tasks"]));
  });

  bench("subscription manager invalidate 10k dependency-aware", () => {
    subscriptions10k.invalidate(TARGETED_CHANGE);
  });

  bench("protocol reEvaluateQueries 10k held subscriptions", async () => {
    await protocol10k.reEvaluateQueries(TARGETED_CHANGE);
  });

  bench("protocol mutation handling 10k active queries", async () => {
    await protocol10k.handleMessage("session-a", {
      type: "Mutation",
      requestId: 1,
      udfPath: "tasks:mutate",
      args: [],
    });
  });
});
