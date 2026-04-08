import schema from "../../convex/schema";
import {
  getRemoteState,
  subscribeRemoteState,
} from "../../packages/convex-embedded/src/client/remote";
import {
  createEmbeddedClient,
  createNoopWriteBroadcast,
} from "../../packages/convex-embedded/src/index";
import type { ConvexModuleRegistry } from "../../packages/convex-embedded/src/kernel/modules";
import type {
  ConnectivityAdapter,
  EmbeddedPlatformAdapter,
} from "../../packages/convex-embedded/src/runtime/platform";
import { ephemeralStorage } from "../../packages/convex-embedded/src/storage/memory";

type OnlineCallback = () => void;

export function createLiveModules(): ConvexModuleRegistry {
  return {
    "_generated/api": () => import("../../convex/_generated/api.js"),
    "_generated/server": () => import("../../convex/_generated/server.js"),
    schema: () => import("../../convex/schema"),
    projects: () => import("../../convex/projects"),
    issues: () => import("../../convex/issues"),
    comments: () => import("../../convex/comments"),
  } satisfies ConvexModuleRegistry;
}

export class TestConnectivityController implements ConnectivityAdapter {
  private online: boolean;
  private readonly onlineListeners = new Set<OnlineCallback>();
  private readonly offlineListeners = new Set<OnlineCallback>();

  constructor(initiallyOnline = true) {
    this.online = initiallyOnline;
  }

  isOnline(): boolean {
    return this.online;
  }

  onOnline(callback: OnlineCallback): () => void {
    this.onlineListeners.add(callback);
    return () => this.onlineListeners.delete(callback);
  }

  onOffline(callback: OnlineCallback): () => void {
    this.offlineListeners.add(callback);
    return () => this.offlineListeners.delete(callback);
  }

  setOnline(nextOnline: boolean): void {
    if (this.online === nextOnline) {
      return;
    }

    this.online = nextOnline;
    const listeners = nextOnline ? this.onlineListeners : this.offlineListeners;
    listeners.forEach((callback) => callback());
  }

  close(): void {
    this.onlineListeners.clear();
    this.offlineListeners.clear();
  }
}

export function createNodeTestPlatform(input: {
  name: string;
  connectivity: TestConnectivityController;
}): EmbeddedPlatformAdapter {
  return {
    async openPersistence() {
      return ephemeralStorage();
    },
    createWriteBroadcast() {
      return createNoopWriteBroadcast();
    },
    connectivity: input.connectivity,
    processorIdentity: {
      getProcessorId() {
        return `live-${input.name}`;
      },
    },
  };
}

export function createLiveClient(input: {
  name: string;
  remoteUrl: string;
  connectivity?: TestConnectivityController;
}) {
  Object.defineProperty(globalThis, "__convexAllowFunctionsInBrowser", {
    value: true,
    writable: true,
    configurable: true,
  });

  const connectivity =
    input.connectivity ?? new TestConnectivityController(true);
  const client = createEmbeddedClient({
    options: {
      modules: createLiveModules(),
      schema,
      name: input.name,
      remote: { url: input.remoteUrl },
    },
    platform: createNodeTestPlatform({ name: input.name, connectivity }),
  });

  return { client, connectivity };
}

export async function waitForRemoteStatus(
  client: Parameters<typeof getRemoteState>[0],
  predicate: (status: ReturnType<typeof getRemoteState>) => boolean,
  timeoutMs = 20_000,
): Promise<ReturnType<typeof getRemoteState>> {
  const current = getRemoteState(client);
  if (predicate(current)) {
    return current;
  }

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `[convex-embedded] Timed out waiting for remote status. Last status: ${getRemoteState(client).status}`,
        ),
      );
    }, timeoutMs);

    const unsubscribe = subscribeRemoteState(client, (status) => {
      if (!predicate(status)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(status);
    });
  });
}

export async function waitForResolved(
  client: Parameters<typeof getRemoteState>[0],
  timeoutMs?: number,
): Promise<void> {
  await waitForRemoteStatus(
    client,
    (status) => status.status === "resolved",
    timeoutMs,
  );
}

export async function waitForOffline(
  client: Parameters<typeof getRemoteState>[0],
  timeoutMs?: number,
): Promise<void> {
  await waitForRemoteStatus(
    client,
    (status) => status.status === "offline",
    timeoutMs,
  );
}

export async function pollUntil<T>(input: {
  read: () => Promise<T>;
  accept: (value: T) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const intervalMs = input.intervalMs ?? 150;
  const startedAt = Date.now();
  let lastError: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await input.read();
      if (input.accept(value)) {
        return value;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error("[convex-embedded] Timed out waiting for live condition.");
}

export function uniqueSuffix(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
