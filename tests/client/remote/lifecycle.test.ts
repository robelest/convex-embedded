import { createConvexClient } from "@resolve/browser/index";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

vi.mock("convex/browser", () => {
  class MockConvexClient {
    static instances: MockConvexClient[] = [];

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
      MockConvexClient.instances.push(this);
    }
  }

  return {
    ConvexClient: MockConvexClient,
    __mock: {
      reset: () => {
        MockConvexClient.instances.length = 0;
      },
      instances: () => MockConvexClient.instances,
    },
  };
});

const mockEngineInstances: Array<{
  mutation: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}> = [];

const mockEngineFactory = {
  create: vi.fn(() => {
    const instance = {
      mutation: vi.fn(),
      on: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    mockEngineInstances.push(instance);
    return instance;
  }),
};

vi.mock("@/client/engine", () => ({
  engine: mockEngineFactory,
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

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("remote lifecycle", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { reset: () => void };
    };
    convexBrowser.__mock.reset();
    mockEngineInstances.length = 0;
    mockEngineFactory.create.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops the sync engine and bounds hidden remote client close", async () => {
    const client = createConvexClient({
      convex: { modules: createModules() },
      remote: { url: "https://remote.example.convex.cloud" },
    }) as any;

    await settle();
    expect(mockEngineInstances).toHaveLength(1);

    const convexBrowser = (await vi.importMock("convex/browser")) as {
      __mock: { instances: () => Array<{ close: ReturnType<typeof vi.fn> }> };
    };
    const [_mainClient, hiddenRemoteClient] = convexBrowser.__mock.instances();
    expect(_mainClient).toBeDefined();
    expect(hiddenRemoteClient).toBeDefined();

    hiddenRemoteClient!.close.mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );

    vi.useFakeTimers();
    const closePromise = client.close();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    await closePromise;

    expect(mockEngineInstances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(hiddenRemoteClient!.close).toHaveBeenCalledTimes(1);
  });
});
