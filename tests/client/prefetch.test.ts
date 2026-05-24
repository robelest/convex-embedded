import { beforeEach, describe, expect, it } from "@tests/testkit";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";

interface RecordedQuery {
  name: string;
  args: Record<string, unknown>;
}

const mocks = vi.hoisted(() => ({
  recordedRefs: [] as Array<{
    query: FunctionReference<"query">;
    args: Record<string, unknown>;
  }>,
  consistentQuery: vi.fn(),
  constructorCalls: [] as Array<{
    url: string;
    options?: Record<string, unknown>;
  }>,
}));

const { recordedRefs, consistentQuery, constructorCalls } = mocks;

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class MockConvexHttpClient {
    constructor(url: string, options?: Record<string, unknown>) {
      mocks.constructorCalls.push({ url, options });
    }

    consistentQuery(
      query: FunctionReference<"query">,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      mocks.recordedRefs.push({ query, args });
      return mocks.consistentQuery(query, args);
    }
  },
}));

import { createEmbeddedPrefetch } from "@resolve/client/index";
import { EmbeddedRuntime } from "@resolve/index";

function query<TResult>(name: string) {
  return makeFunctionReference<"query", Record<string, never>, TResult>(name);
}

function recordedQueries(): RecordedQuery[] {
  return recordedRefs.map(({ query: ref, args }) => ({
    name: getFunctionName(ref),
    args,
  }));
}

const api = {
  workspace: { get: query<{ name: string }>("workspace:get") },
  tasks: {
    list: query<Array<Record<string, unknown>>>("tasks:list"),
    listMine: query<Array<Record<string, unknown>>>("tasks:listMine"),
  },
  profiles: { list: query<Array<Record<string, unknown>>>("profiles:list") },
} as const;

describe("createEmbeddedPrefetch", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    recordedRefs.length = 0;
    consistentQuery.mockReset();
  });

  it("builds embedded bootstrap data and raw SSR results from explicit queries", async () => {
    consistentQuery.mockImplementation(
      async (ref: FunctionReference<"query">) => {
        const name = getFunctionName(ref);
        if (name === "workspace:get") {
          return { name: "Acme" };
        }
        if (name === "tasks:list") {
          return [{ _id: "task-1", _creationTime: 1, title: "Write tests" }];
        }
        if (name === "profiles:list") {
          return [{ _id: "profile-1", _creationTime: 2, name: "Taylor" }];
        }
        throw new Error(`Unexpected query ${name}`);
      },
    );

    const prefetched = await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      token: "jwt-token",
      identityKey: "user-1",
      queries: {
        workspace: {
          query: api.workspace.get,
          args: {},
        },
        tasks: {
          query: api.tasks.list,
          args: {},
          collection: "tasks",
        },
        profiles: {
          query: api.profiles.list,
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
    expect(recordedQueries()).toEqual([
      { name: "workspace:get", args: {} },
      { name: "tasks:list", args: {} },
      { name: "profiles:list", args: {} },
    ]);
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
    consistentQuery.mockImplementation(
      async (ref: FunctionReference<"query">) => {
        if (getFunctionName(ref) === "workspace:get") {
          return { name: "Acme" };
        }
        return [{ _id: "task-1", _creationTime: 1, title: "Write tests" }];
      },
    );

    const prefetched = await createEmbeddedPrefetch({
      url: "https://remote.example.convex.cloud",
      queries: {
        workspace: {
          query: api.workspace.get,
          args: {},
        },
        tasks: {
          query: api.tasks.list,
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
          query: api.tasks.list,
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
          query: api.tasks.listMine,
          args: { owner: "alice" },
          collection: "tasks",
        },
      },
    });

    expect(recordedQueries()).toContainEqual({
      name: "tasks:listMine",
      args: { owner: "alice" },
    });
  });

  it("requires selectDocuments for non-array embedded query results", async () => {
    consistentQuery.mockResolvedValue({ tasks: [] });

    await expect(
      createEmbeddedPrefetch({
        url: "https://remote.example.convex.cloud",
        queries: {
          tasks: {
            query: api.tasks.list,
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
      tables: { tasks: query("tasks:bind") },
    });

    expect(recordedQueries()).toContainEqual({
      name: "tasks:bind",
      args: {
        collectionSeq: null,
        documents: [],
        scopeArgs: undefined,
      },
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
      tables: { tasks: query("tasks:bind") },
      scopeArgs: { tasks: { workspaceId: "ws-1" } },
    });

    expect(recordedQueries()).toContainEqual({
      name: "tasks:bind",
      args: {
        collectionSeq: null,
        documents: [],
        scopeArgs: { workspaceId: "ws-1" },
      },
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
        tables: { tasks: query("tasks:bind") },
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
        tables: { tasks: query("tasks:bind") },
      }),
    ).rejects.toThrow(/"document" payload/);
  });
});
