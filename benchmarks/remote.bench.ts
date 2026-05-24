import { engine } from "@resolve/client/engine";
import { bench, describe } from "@tests/testkit";

type CreateArgs = Parameters<typeof engine.create>[0];
type EmbeddedArg = CreateArgs["embedded"];
type RemoteClientArg = CreateArgs["remoteClient"];
type TablesArg = CreateArgs["tables"];
type TableConfigArg = TablesArg extends Record<string, infer T> ? T : never;

function createMockRemoteClient(): RemoteClientArg {
  return {
    query: async () => [],
    mutation: async () => null,
    onUpdate: () => () => {},
  } as unknown as RemoteClientArg;
}

function createEmbedded(): EmbeddedArg {
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
  } as unknown as EmbeddedArg;
}

interface StatefulDoc {
  _id: string;
  _creationTime: number;
  title: string;
  body: string;
}

function createStatefulEmbedded(docCount: number): EmbeddedArg {
  let docs: StatefulDoc[] = Array.from({ length: docCount }, (_, index) => ({
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
      docs = nextDocs.map((doc) => doc as unknown as StatefulDoc);
    },
    getDocumentsForTable: async () => docs,
  } as unknown as EmbeddedArg;
}

function tableConfig(resolve: string): TableConfigArg {
  return {
    query: `${resolve}_list`,
    resolve,
    schema: {
      version: 1,
      shape: { title: "string", body: "string" },
      defaults: {},
      getShape: () => ({ title: "string", body: "string" }),
      getCrdtFields: () => new Map(),
      getOmittedFields: () => [],
    },
  } as unknown as TableConfigArg;
}

describe("remote engine", () => {
  bench("resolve cycle across 5 tables", async () => {
    const instance = engine.create({
      embedded: createEmbedded(),
      remoteClient: createMockRemoteClient(),
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
    const handlerRef: {
      current: ((docs: Array<Record<string, unknown>>) => void) | null;
    } = { current: null };
    const remoteClient = {
      query: async () => [],
      mutation: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return null;
      },
      onUpdate: (
        _query: unknown,
        _args: unknown,
        onUpdate: (docs: Array<Record<string, unknown>>) => void,
      ) => {
        handlerRef.current = onUpdate;
        return () => {};
      },
    } as unknown as RemoteClientArg;

    const instance = engine.create({
      embedded: createStatefulEmbedded(1_000),
      remoteClient,
      tables: { tasks: tableConfig("tasks:resolve") },
    });

    instance.start();
    await instance.mutation("tasks:remove", { id: "task-10" });
    handlerRef.current?.(
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
