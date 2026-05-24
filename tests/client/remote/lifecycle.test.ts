import { createConvexClient } from "@resolve/browser/index";
import type { EngineConfig, EngineInstance } from "@resolve/client/engine";
import { withFakeTimers } from "@tests/helpers/time";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";

interface MockRemoteClient {
  close: ReturnType<typeof vi.fn>;
}

interface MockEngine {
  mutation: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => {
  const clientInstances: MockRemoteClient[] = [];
  const engineInstances: MockEngine[] = [];
  return { clientInstances, engineInstances };
});

vi.mock("convex/browser", () => {
  class MockConvexClient {
    mutation = vi.fn(async () => undefined);
    query = vi.fn(async () => undefined);
    action = vi.fn(async () => undefined);
    onUpdate = vi.fn(() => {
      const unsubscribe = (() => {}) as (() => void) & {
        unsubscribe: () => void;
      };
      unsubscribe.unsubscribe = unsubscribe;
      return unsubscribe;
    });
    onPaginatedUpdate_experimental = vi.fn(() => {
      const unsubscribe = (() => {}) as (() => void) & {
        unsubscribe: () => void;
      };
      unsubscribe.unsubscribe = unsubscribe;
      return unsubscribe;
    });
    close = vi.fn(async () => undefined);
    setAuth = vi.fn();
    clearAuth = vi.fn();

    constructor(readonly url: string) {
      mocks.clientInstances.push(this);
    }
  }

  return { ConvexClient: MockConvexClient };
});

vi.mock("@/client/engine", () => ({
  engine: {
    create: vi.fn((_config: EngineConfig): EngineInstance => {
      const instance: MockEngine = {
        mutation: vi.fn(),
        on: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      mocks.engineInstances.push(instance);
      return instance as unknown as EngineInstance;
    }),
  },
}));

function createModules() {
  const resolve = () => {};
  Object.defineProperty(resolve, Symbol.for("convex-embedded:remoteMeta"), {
    value: {
      __brand: "convex-embedded:remoteMeta",
      table: "tasks",
      resolveExport: "resolve",
      schema: undefined,
    },
  });

  return {
    "_generated/api": async () => ({}),
    tasks: async () => ({ resolve }),
  };
}

describe("remote lifecycle", () => {
  beforeEach(() => {
    mocks.clientInstances.length = 0;
    mocks.engineInstances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the sync engine and bounds hidden remote client close", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: "https://remote.example.convex.cloud" },
    });

    await vi.waitFor(() => expect(mocks.engineInstances).toHaveLength(1));

    const [mainClient, hiddenRemoteClient] = mocks.clientInstances;
    expect(mainClient).toBeDefined();
    expect(hiddenRemoteClient).toBeDefined();

    hiddenRemoteClient!.close.mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );

    await withFakeTimers(async () => {
      const closePromise = client.close();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      await closePromise;
    });

    expect(mocks.engineInstances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(hiddenRemoteClient!.close).toHaveBeenCalledTimes(1);
  });
});
