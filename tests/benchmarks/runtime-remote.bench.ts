import { engine } from "@resolve/client/engine";
import { bench, describe } from "@tests/testkit";

function createMockRemoteClient() {
  return {
    query: async () => [],
    mutation: async () => null,
    onUpdate: () => () => {},
  };
}

function createEmbedded() {
  const localClient = {
    query: async (path: string) => {
      if (path === "_system:idMapGetAll") return [];
      if (path === "_system:pendingGetAll") return [];
      return null;
    },
    mutation: async () => null,
  };

  return {
    client: localClient,
    ingestDocuments: async () => undefined,
    getDocumentsForTable: async () => [],
  };
}

function createStatefulEmbedded(docCount: number) {
  let docs = Array.from({ length: docCount }, (_, index) => ({
    _id: `task-${index}`,
    _creationTime: index + 1,
    title: `Task ${index}`,
    body: "",
  }));

  const localClient = {
    query: async (path: string) => {
      if (path === "_system:idMapGetAll") return [];
      if (path === "_system:pendingGetAll") return [];
      return null;
    },
    mutation: async (path: string, args: Record<string, unknown>) => {
      if (path === "_system:pendingPush") return "pending-1";
      if (path === "tasks:remove") {
        docs = docs.filter((doc) => doc._id !== args.id);
        return args.id;
      }
      return null;
    },
  };

  return {
    client: localClient,
    ingestDocuments: async (
      _table: string,
      nextDocs: Array<Record<string, unknown>>,
    ) => {
      docs = [...nextDocs] as typeof docs;
    },
    getDocumentsForTable: async () => docs,
  };
}

function createMockSchema() {
  return {
    version: 1,
    shape: { title: "string", body: "string" },
    defaults: {},
    getShape: () => ({ title: "string", body: "string" }),
    getCrdtFields: () => new Map(),
    getOmittedFields: () => [],
  } as const;
}

function tableConfig(resolve: string) {
  return {
    query: `${resolve}_list`,
    resolve,
    schema: createMockSchema(),
  };
}

describe("remote engine", () => {
  bench("resolve cycle across 5 tables", async () => {
    const embedded = createEmbedded();
    const remoteClient = createMockRemoteClient();

    const instance = engine.create({
      embedded,
      remoteClient,
      tables: {
        a: tableConfig("a:resolve"),
        b: tableConfig("b:resolve"),
        c: tableConfig("c:resolve"),
        d: tableConfig("d:resolve"),
        e: tableConfig("e:resolve"),
      },
    });

    instance.start();
    await instance.resolveNow();
    instance.stop();
  });

  bench("stale remote snapshot after local delete", async () => {
    const embedded = createStatefulEmbedded(1_000);
    let onUpdateHandler:
      | ((docs: Array<Record<string, unknown>>) => void)
      | null = null;
    const remoteClient = {
      ...createMockRemoteClient(),
      mutation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return null;
      },
      onUpdate: (
        _query: unknown,
        _args: unknown,
        onUpdate: (docs: Array<Record<string, unknown>>) => void,
      ) => {
        onUpdateHandler = onUpdate;
        return () => {};
      },
    };

    const instance = engine.create({
      embedded,
      remoteClient,
      tables: { tasks: tableConfig("tasks:resolve") },
    });

    instance.start();
    await instance.mutation("tasks:remove", { id: "task-10" });
    onUpdateHandler?.(
      Array.from({ length: 1_000 }, (_, index) => ({
        _id: `task-${index}`,
        _creationTime: index + 1,
        title: `Task ${index}`,
        body: "",
      })),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    instance.stop();
  });
});
