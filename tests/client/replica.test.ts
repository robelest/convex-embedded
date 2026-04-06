import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const consistentQuery = vi.fn();
const constructorCalls: Array<{
  url: string;
  options?: Record<string, unknown>;
}> = [];

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    constructor(url: string, options?: Record<string, unknown>) {
      constructorCalls.push({ url, options });
    }

    consistentQuery = consistentQuery;
  },
}));

import { createReplica } from "@resolve/client/index";
import { EmbeddedRuntime } from "@resolve/index";

function createReplicaModules() {
  const tasksResolve = () => {};
  const profilesResolve = () => {};

  Object.defineProperty(
    tasksResolve,
    Symbol.for("convex-embedded:remoteMeta"),
    {
      value: {
        __brand: "convex-embedded:remoteMeta",
        table: "tasks",
        resolveExport: "resolve",
        listExport: "list",
        schema: undefined,
      },
    },
  );
  Object.defineProperty(
    profilesResolve,
    Symbol.for("convex-embedded:remoteMeta"),
    {
      value: {
        __brand: "convex-embedded:remoteMeta",
        table: "profiles",
        resolveExport: "resolve",
        listExport: "list",
        schema: undefined,
      },
    },
  );

  return {
    "./convex/_generated/api.ts": async () => ({}),
    "./convex/tasks.ts": async () => ({
      resolve: tasksResolve,
      list: () => [],
    }),
    "./convex/profiles.ts": async () => ({
      resolve: profilesResolve,
      list: () => [],
    }),
  };
}

describe("createReplica", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    consistentQuery.mockReset();
  });

  it("builds a consistent remote replica from discovered embedded tables", async () => {
    consistentQuery.mockImplementation(async (query: string) => {
      if (query === "tasks:list") {
        return [{ _id: "task-1", _creationTime: 1, title: "Write tests" }];
      }
      if (query === "profiles:list") {
        return [{ _id: "profile-1", _creationTime: 2, name: "Taylor" }];
      }
      throw new Error(`Unexpected query ${query}`);
    });

    const replica = await createReplica({
      modules: createReplicaModules(),
      url: "https://remote.example.convex.cloud",
      token: "jwt-token",
      identityKey: "user-1",
    });

    expect(constructorCalls).toEqual([
      {
        url: "https://remote.example.convex.cloud",
        options: {
          auth: "jwt-token",
          logger: false,
        },
      },
    ]);
    expect(consistentQuery).toHaveBeenCalledTimes(2);
    expect(replica).toEqual({
      version: 1,
      identityKey: "user-1",
      tables: {
        tasks: [{ _id: "task-1", _creationTime: 1, title: "Write tests" }],
        profiles: [{ _id: "profile-1", _creationTime: 2, name: "Taylor" }],
      },
    });
  });

  it("filters to requested tables and fails on unknown table names", async () => {
    consistentQuery.mockResolvedValue([
      { _id: "task-1", _creationTime: 1, title: "Write tests" },
    ]);

    const replica = await createReplica({
      modules: createReplicaModules(),
      url: "https://remote.example.convex.cloud",
      tables: ["tasks"],
    });

    expect(Object.keys(replica.tables)).toEqual(["tasks"]);
    expect(consistentQuery).toHaveBeenCalledTimes(1);

    await expect(
      createReplica({
        modules: createReplicaModules(),
        url: "https://remote.example.convex.cloud",
        tables: ["missing"],
      }),
    ).rejects.toThrow(/missing/);
  });

  it("returns a JSON-safe replica that can seed runtime reads", async () => {
    consistentQuery.mockResolvedValue([
      {
        _id: "task-1",
        _creationTime: 1,
        count: 42n,
        payload: Uint8Array.from([1, 2, 3]).buffer,
      },
    ]);

    const replica = await createReplica({
      modules: createReplicaModules(),
      url: "https://remote.example.convex.cloud",
      tables: ["tasks"],
    });
    const serialized = JSON.stringify(replica);

    const runtime = new EmbeddedRuntime({
      modules: { "./convex/_generated/api.ts": async () => ({}) },
      replica: JSON.parse(serialized),
    });

    try {
      await runtime.hydrate();
      const [document] = await runtime.getDocumentsForTable("tasks");

      expect(document).toMatchObject({
        _id: "task-1",
        _creationTime: 1,
        count: 42n,
      });
      expect(
        Array.from(new Uint8Array(document?.payload as ArrayBuffer)),
      ).toEqual([1, 2, 3]);
    } finally {
      runtime.shutdown();
    }
  });
});
