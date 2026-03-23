import { engine } from "@resolve/client/engine";
import { bench, describe } from "vite-plus/test";

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

function tableConfig(resolve: string) {
  return {
    query: `${resolve}_list`,
    resolve,
    schema: undefined,
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
});
