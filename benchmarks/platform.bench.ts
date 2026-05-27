import { UdfExecutor } from "@embedded/kernel/udf";
import { createSubscriptionManager, type SubscriptionManager } from "@embedded/replication/subscriptions";
import { createAmbientCryptoProvider } from "@embedded/runtime/crypto";
import { Database } from "@embedded/runtime/db/database";
import type { DocumentId } from "@embedded/runtime/db/types";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { createSchedulerExecutor } from "@embedded/scheduler/executor";
import { bench, describe } from "@tests/testkit";

const STUB_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  "_generated/api": async () => ({}),
};

function createMockModuleLoader(
  modules: Record<string, Record<string, unknown>>,
) {
  return {
    load: async (path: string) => modules[path] ?? {},
  };
}

function createExecutor() {
  return new UdfExecutor({
    db: new Database(null),
    crypto: createAmbientCryptoProvider(),
    moduleLoader: createMockModuleLoader({
      messages: {
        list: {
          isQuery: true,
          handler: async (_ctx: unknown, args: Record<string, unknown>) =>
            args.value,
        },
        send: {
          isMutation: true,
          handler: async (_ctx: unknown, args: Record<string, unknown>) =>
            args.value,
        },
      },
      api: {
        fetch: {
          isAction: true,
          handler: async (_ctx: unknown, args: Record<string, unknown>) =>
            args.value,
        },
      },
    }) as unknown as ConstructorParameters<
      typeof UdfExecutor
    >[0]["moduleLoader"],
    runUdf: async () => null,
  });
}

async function seedSystemRuntime(): Promise<EmbeddedRuntime> {
  const runtime = new EmbeddedRuntime({ convex: { modules: STUB_MODULES } });
  await runtime.hydrate();

  for (let index = 0; index < 1_000; index += 1) {
    await runtime.executeLocal({
      kind: "mutation",
      path: "_system:idMapSet",
      args: {
        localId: `local-${index}`,
        remoteId: `remote-${index}`,
        table: "tasks",
        identityKey: index % 2 === 0 ? "alpha" : "beta",
      },
      applyLocalEffects: false,
    });
    await runtime.executeLocal({
      kind: "mutation",
      path: "_system:pendingPush",
      args: {
        ref: `mutation:${index}`,
        args: JSON.stringify({ index }),
        localResult: JSON.stringify({ ok: true }),
        table: "tasks",
        identityKey: index % 2 === 0 ? "alpha" : "beta",
      },
      applyLocalEffects: false,
    });
  }

  return runtime;
}

function buildSubscriptionManager(
  subscriptionCount: number,
): SubscriptionManager {
  const manager = createSubscriptionManager();
  for (let index = 0; index < subscriptionCount; index += 1) {
    manager.subscribe(
      `query-${index}`,
      new Set([index % 2 === 0 ? "tasks" : "messages"]),
      [
        {
          type: "IndexRange",
          tableName: index % 2 === 0 ? "tasks" : "messages",
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

const runtime = await seedSystemRuntime();
const executor = createExecutor();
const scheduler = createSchedulerExecutor({
  db: new Database(null),
  runFunction: async () => {},
});
const subscriptions = buildSubscriptionManager(5_000);

describe("platform", () => {
  bench("udf executor query invocation", async () => {
    await executor.executeQuery(
      { componentPath: "", udfPath: "messages:list" },
      { value: 1 },
    );
  });

  bench("udf executor mutation invocation", async () => {
    await executor.executeMutation(
      { componentPath: "", udfPath: "messages:send" },
      { value: 1 },
    );
  });

  bench("udf executor action invocation", async () => {
    await executor.executeAction(
      { componentPath: "", udfPath: "api:fetch" },
      { value: 1 },
    );
  });

  bench("system function executeLocal query idMapGet", async () => {
    await runtime.executeLocal({
      kind: "query",
      path: "_system:idMapGet",
      args: {
        localId: "local-200",
        identityKey: "alpha",
      },
    });
  });

  bench("system function executeLocal mutation idMapSet update", async () => {
    await runtime.executeLocal({
      kind: "mutation",
      path: "_system:idMapSet",
      args: {
        localId: "local-200",
        remoteId: "remote-200-updated",
        table: "tasks",
        identityKey: "alpha",
      },
      applyLocalEffects: false,
    });
  });

  bench("system function executeLocal query pendingGetAll", async () => {
    await runtime.executeLocal({
      kind: "query",
      path: "_system:pendingGetAll",
      args: {
        identityKey: "alpha",
      },
    });
  });

  bench("scheduler schedule + cancel", () => {
    const jobId = scheduler.schedule("messages:send", { value: 1 }, 60_000);
    scheduler.cancelJob(jobId);
  });

  bench("subscription invalidate 5k table-indexed", () => {
    subscriptions.invalidate(new Set(["tasks"]));
  });

  bench("subscription invalidate 5k dependency-aware", () => {
    subscriptions.invalidate([
      {
        tableName: "tasks",
        before: { _id: "a" as DocumentId, _creationTime: 1, status: "queued" },
        after: { _id: "a" as DocumentId, _creationTime: 1, status: "active" },
      },
    ]);
  });

  bench("runtime executeLocal query authStateGetActive", async () => {
    await runtime.executeLocal({
      kind: "query",
      path: "_system:authStateGetActive",
      args: {},
    });
  });
});
