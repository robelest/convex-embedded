import { clearBrowserLocalData } from "@/browser/platform";

const DEBUG_NAMESPACE = "__convexEmbedded";

type ClearOptions = {
  name?: string;
  reload?: boolean;
};

type RegisteredClient = {
  name: string;
  clear: () => Promise<void>;
};

type BrowserDebugApi = {
  clearLocalData(options?: ClearOptions): Promise<void>;
  listClientNames(): string[];
};

const REGISTERED_CLIENTS = Symbol.for(
  "convex-embedded:browser/debug:registeredClients",
);

type DebugGlobal = typeof globalThis & {
  [REGISTERED_CLIENTS]?: Map<string, RegisteredClient>;
};

function getRegisteredClients() {
  const target = globalThis as DebugGlobal;
  target[REGISTERED_CLIENTS] ??= new Map<string, RegisteredClient>();
  return target[REGISTERED_CLIENTS];
}

function getDebugTarget(): Record<string, unknown> | null {
  if (typeof globalThis !== "object" || globalThis === null) {
    return null;
  }
  return globalThis as Record<string, unknown>;
}

function getOrCreateDebugApi(): BrowserDebugApi | null {
  const target = getDebugTarget();
  if (!target) {
    return null;
  }

  const existing = target[DEBUG_NAMESPACE] as BrowserDebugApi | undefined;
  if (existing) {
    return existing;
  }

  const api: BrowserDebugApi = {
    async clearLocalData(options = {}) {
      const requestedName = options.name;
      const selectedName =
        requestedName ?? Array.from(getRegisteredClients().keys()).at(-1);
      if (!selectedName) {
        throw new Error(
          "[convex-embedded] No browser client is registered for local data clearing.",
        );
      }

      const registered = getRegisteredClients().get(selectedName);
      if (registered) {
        await registered.clear();
      } else {
        await clearBrowserLocalData(selectedName);
      }

      if (options.reload && typeof globalThis.location?.reload === "function") {
        globalThis.location.reload();
      }
    },
    listClientNames() {
      return Array.from(getRegisteredClients().keys());
    },
  };

  target[DEBUG_NAMESPACE] = api;
  return api;
}

export function registerBrowserDebugClient(input: RegisteredClient): void {
  getOrCreateDebugApi();
  getRegisteredClients().set(input.name, input);
}

export function unregisterBrowserDebugClient(name: string): void {
  getRegisteredClients().delete(name);
}

export function getBrowserDebugApi(): BrowserDebugApi | null {
  return getOrCreateDebugApi();
}
