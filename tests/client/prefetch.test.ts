import { beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

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

import { createEmbeddedPrefetch } from "@resolve/client/index";
import { EmbeddedRuntime } from "@resolve/index";

const api = {
  workspace: { get: "workspace:get" },
  tasks: { list: "tasks:list", listMine: "tasks:listMine" },
  profiles: { list: "profiles:list" },
} as const;

describe("createEmbeddedPrefetch", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    consistentQuery.mockReset();
  });

  it("builds embedded bootstrap data and raw SSR results from explicit queries", async () => {
    consistentQuery.mockImplementation(async (query: string) => {
      if (query === "workspace:get") {
        return { name: "Acme" };
      }
      if (query === "tasks:list") {
        return [{ _id: "task-1", _creationTime: 1, title: "Write tests" }];
      }
      if (query === "profiles:list") {
        return [{ _id: "profile-1", _creationTime: 2, name: "Taylor" }];
      }
      throw new Error(`Unexpected query ${query}`);
    });

    const prefetched = await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      token: "jwt-token",
      identityKey: "user-1",
      queries: {
        workspace: {
          query: api.workspace.get as any,
          args: {},
        },
        tasks: {
          query: api.tasks.list as any,
          args: {},
          collection: "tasks",
        },
        profiles: {
          query: api.profiles.list as any,
          args: {},
          collection: "profiles",
        },
      },
    });

    expect(constructorCalls).toEqual([
      {
        url: "https://remote.example.convex.cloud",
        options: { auth: "jwt-token", logger: false },
      },
    ]);
    expect(consistentQuery).toHaveBeenNthCalledWith(1, "workspace:get", {});
    expect(consistentQuery).toHaveBeenNthCalledWith(2, "tasks:list", {});
    expect(consistentQuery).toHaveBeenNthCalledWith(3, "profiles:list", {});
    expect(prefetched).toEqual({
      embedded: {
        identityKey: "user-1",
        tables: {
          tasks: [{ _id: "task-1", _creationTime: 1, title: "Write tests" }],
          profiles: [{ _id: "profile-1", _creationTime: 2, name: "Taylor" }],
        },
        metadata: {
          tasks: { collectionSeq: -1, documents: [] },
          profiles: { collectionSeq: -1, documents: [] },
        },
      },
      results: {
        workspace: { name: "Acme" },
        tasks: [{ _id: "task-1", _creationTime: 1, title: "Write tests" }],
        profiles: [{ _id: "profile-1", _creationTime: 2, name: "Taylor" }],
      },
      snapshots: {},
    });
  });

  it("only embeds collections that are explicitly marked", async () => {
    consistentQuery.mockImplementation(async (query: string) => {
      if (query === "workspace:get") {
        return { name: "Acme" };
      }
      return [{ _id: "task-1", _creationTime: 1, title: "Write tests" }];
    });

    const prefetched = await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      queries: {
        workspace: {
          query: api.workspace.get as any,
          args: {},
        },
        tasks: {
          query: api.tasks.list as any,
          args: {},
          collection: "tasks",
        },
      },
    });

    expect(prefetched.embedded.tables).toEqual({
      tasks: [{ _id: "task-1", _creationTime: 1, title: "Write tests" }],
    });
    expect(prefetched.results.workspace).toEqual({ name: "Acme" });
  });

  it("returns JSON-safe embedded data that can seed runtime reads", async () => {
    consistentQuery.mockResolvedValue([
      {
        _id: "task-1",
        _creationTime: 1,
        count: 42n,
        payload: Uint8Array.from([1, 2, 3]).buffer,
      },
    ]);

    const prefetched = await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      queries: {
        tasks: {
          query: api.tasks.list as any,
          args: {},
          collection: "tasks",
        },
      },
    });
    const serialized = JSON.stringify(prefetched.embedded);

    const runtime = new EmbeddedRuntime({
      convex: { modules: { "_generated/api": async () => ({}) } },
      prefetch: JSON.parse(serialized),
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

  it("passes explicit query args through to the remote call", async () => {
    consistentQuery.mockResolvedValue([]);

    await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      queries: {
        tasks: {
          query: api.tasks.listMine as any,
          args: { owner: "alice" },
          collection: "tasks",
        },
      },
    });

    expect(consistentQuery).toHaveBeenCalledWith("tasks:listMine", {
      owner: "alice",
    });
  });

  it("requires selectDocuments for non-array embedded query results", async () => {
    consistentQuery.mockResolvedValue({ tasks: [] });

    await expect(
      createEmbeddedPrefetch({
        url: "https://remote.example.convex.cloud",
        queries: {
          tasks: {
            query: api.tasks.list as any,
            args: {},
            collection: "tasks",
          },
        },
      }),
    ).rejects.toThrow(/selectDocuments/);
  });

  it("hydrates a collection via the tables: option using the resolve endpoint", async () => {
    consistentQuery.mockImplementation(async () => ({
      mode: "full",
      collectionSeq: 7,
      documents: [
        {
          docId: "task-1",
          seq: 3,
          document: { _id: "task-1", _creationTime: 1, title: "Alpha" },
        },
        {
          docId: "task-2",
          seq: 4,
          document: { _id: "task-2", _creationTime: 2, title: "Beta" },
        },
      ],
    }));

    const prefetched = await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      identityKey: "user-1",
      tables: { tasks: "tasks:bind" as any },
    });

    expect(consistentQuery).toHaveBeenCalledWith("tasks:bind", {
      collectionSeq: null,
      documents: [],
      scopeArgs: undefined,
    });
    expect(prefetched.embedded.tables.tasks).toEqual([
      { _id: "task-1", _creationTime: 1, title: "Alpha" },
      { _id: "task-2", _creationTime: 2, title: "Beta" },
    ]);
    expect(prefetched.embedded.metadata.tasks).toEqual({
      collectionSeq: 7,
      documents: [
        { docId: "task-1", seq: 3 },
        { docId: "task-2", seq: 4 },
      ],
    });
    expect(prefetched.snapshots.tasks).toEqual(
      prefetched.embedded.tables.tasks,
    );
  });

  it("forwards scopeArgs to the resolve endpoint", async () => {
    consistentQuery.mockImplementation(async () => ({
      mode: "full",
      collectionSeq: 0,
      documents: [],
    }));

    await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      tables: { tasks: "tasks:bind" as any },
      scopeArgs: { tasks: { workspaceId: "ws-1" } },
    });

    expect(consistentQuery).toHaveBeenCalledWith("tasks:bind", {
      collectionSeq: null,
      documents: [],
      scopeArgs: { workspaceId: "ws-1" },
    });
  });

  it("rejects a resolve response that is not in full mode", async () => {
    consistentQuery.mockImplementation(async () => ({
      mode: "incremental",
      collectionSeq: 5,
      documents: [],
    }));

    await expect(
      createEmbeddedPrefetch({
        url: "https://remote.example.convex.cloud",
        tables: { tasks: "tasks:bind" as any },
      }),
    ).rejects.toThrow(/"full" mode/);
  });

  it("rejects a resolve row missing its document payload", async () => {
    consistentQuery.mockImplementation(async () => ({
      mode: "full",
      collectionSeq: 0,
      documents: [{ docId: "task-1", seq: 0 }],
    }));

    await expect(
      createEmbeddedPrefetch({
        url: "https://remote.example.convex.cloud",
        tables: { tasks: "tasks:bind" as any },
      }),
    ).rejects.toThrow(/"document" payload/);
  });
});
