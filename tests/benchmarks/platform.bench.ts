import { UdfExecutor } from "@embedded/kernel/udf";
import { Database } from "@embedded/runtime/db/database";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { SchedulerExecutor } from "@embedded/scheduler/executor";
import { SubscriptionManager } from "@embedded/sync/subscriptions";
import { bench, describe } from "vite-plus/test";

const STUB_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  "./convex/_generated/api.ts": async () => ({}),
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
    }) as never,
    runUdf: async () => null,
  });
}

async function seedSystemRuntime(): Promise<EmbeddedRuntime> {
  const runtime = new EmbeddedRuntime({ modules: STUB_MODULES });
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
  const manager = new SubscriptionManager();
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

const executor = createExecutor();
const runtimePromise = seedSystemRuntime();
const scheduler = new SchedulerExecutor({
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
    const runtime = await runtimePromise;
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
    const runtime = await runtimePromise;
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
    const runtime = await runtimePromise;
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
        before: { _id: "a" as any, _creationTime: 1, status: "queued" },
        after: { _id: "a" as any, _creationTime: 1, status: "active" },
      },
    ]);
  });

  bench("runtime executeLocal query authStateGetActive", async () => {
    const runtime = await runtimePromise;
    await runtime.executeLocal({
      kind: "query",
      path: "_system:authStateGetActive",
      args: {},
    });
  });
});
