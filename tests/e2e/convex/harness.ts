import { ConvexHttpClient } from "convex/browser";

import schema from "../../../convex/schema";
import { getEmbeddedClientEntry } from "../../../packages/convex-embedded/src/client/entry";
import {
  getRemoteState,
  subscribeRemoteState,
} from "../../../packages/convex-embedded/src/client/remote";
import type { ConvexModuleRegistry } from "../../../packages/convex-embedded/src/kernel/modules";
import { createConvexClient } from "../../../packages/convex-embedded/src/node/index";
import type { ConnectivityAdapter } from "../../../packages/convex-embedded/src/runtime/platform";
import { temporaryDatabasePath, uniqueSuffix } from "../../helpers/storage";

export { temporaryDatabasePath, uniqueSuffix } from "../../helpers/storage";

type OnlineCallback = () => void;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, entry) => {
        if (entry instanceof Error) {
          return {
            name: entry.name,
            message: entry.message,
            stack: entry.stack,
          };
        }
        if (typeof entry === "bigint") {
          return entry.toString();
        }
        return entry;
      },
      2,
    );
  } catch (error) {
    return `[unserializable: ${String(error)}]`;
  }
}

async function withDiagnosticTimeout<T>(
  label: string,
  operation: () => Promise<T>,
  timeoutMs = 1_000,
): Promise<T | { timedOut: true; label: string } | { error: string }> {
  try {
    return await Promise.race([
      operation(),
      new Promise<{ timedOut: true; label: string }>((resolve) => {
        setTimeout(() => resolve({ timedOut: true, label }), timeoutMs);
      }),
    ]);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readSystemQuery<T>(
  client: Awaited<ReturnType<typeof createLiveClient>>["client"],
  path: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  const entry = getEmbeddedClientEntry(client);
  if (!entry) {
    return null;
  }
  return (await withDiagnosticTimeout(path, async () => {
    return (await entry.runtime.executeLocal({
      kind: "query",
      path,
      args,
    })) as T;
  })) as T;
}

export async function describeLiveClientState(
  client: Awaited<ReturnType<typeof createLiveClient>>["client"],
): Promise<Record<string, unknown>> {
  const entry = getEmbeddedClientEntry(client);
  const tableNames = ["projects", "issues", "comments"];
  const tables = entry
    ? Object.fromEntries(
        await Promise.all(
          tableNames.map(async (tableName) => {
            const docs = await withDiagnosticTimeout(
              `getDocumentsForTable(${tableName})`,
              () => entry.runtime.getDocumentsForTable(tableName),
            );
            if (!Array.isArray(docs)) {
              return [tableName, docs];
            }
            return [
              tableName,
              {
                count: docs.length,
                ids: docs.flatMap((doc) =>
                  typeof doc._id === "string" ? [doc._id] : [],
                ),
                docs: docs.slice(0, 5),
              },
            ];
          }),
        ),
      )
    : null;

  const [idMap, pending, pendingUploads] = await Promise.all([
    readSystemQuery<Array<Record<string, unknown>>>(
      client,
      "_system:idMapGetAll",
      {
        identityKey: null,
      },
    ),
    readSystemQuery<Array<Record<string, unknown>>>(
      client,
      "_system:pendingGetAll",
      { identityKey: null },
    ),
    readSystemQuery<Array<Record<string, unknown>>>(
      client,
      "_system:pendingUploadGetAll",
      { identityKey: null },
    ),
  ]);

  return {
    remoteState: getRemoteState(client),
    hasRuntimeEntry: Boolean(entry),
    tables,
    idMap,
    pending,
    pendingUploads,
  };
}

export async function logLiveClientState(
  label: string,
  client: Awaited<ReturnType<typeof createLiveClient>>["client"],
): Promise<void> {
  console.error(
    `[live-debug] ${label}: ${safeJson(await describeLiveClientState(client))}`,
  );
}

export function createLiveModules(): ConvexModuleRegistry {
  return {
    "_generated/api": () => import("../../../convex/_generated/api.js"),
    "_generated/server": () => import("../../../convex/_generated/server.js"),
    schema: () => import("../../../convex/schema"),
    projects: () => import("../../../convex/projects"),
    issues: () => import("../../../convex/issues"),
    comments: () => import("../../../convex/comments"),
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

export function createLiveClient(input: {
  name: string;
  remoteUrl: string;
  connectivity?: TestConnectivityController;
  databasePath?: string;
}) {
  Object.defineProperty(globalThis, "__convexAllowFunctionsInBrowser", {
    value: true,
    writable: true,
    configurable: true,
  });

  const connectivity =
    input.connectivity ?? new TestConnectivityController(true);
  const client = createConvexClient({
    convex: { modules: createLiveModules() },
    schema,
    name: input.name,
    remote: { url: input.remoteUrl },
    connectivity,
    processorIdentity: {
      getProcessorId() {
        return `live-${input.name}`;
      },
    },
    databasePath: input.databasePath ?? temporaryDatabasePath(input.name),
  });

  return { client, connectivity };
}

export function createDirectRemoteClient(remoteUrl: string) {
  return new ConvexHttpClient(remoteUrl);
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
  description?: string;
  diagnostics?: () => unknown;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<T> {
  const timeoutMs = input.timeoutMs ?? 20_000;
  const intervalMs = input.intervalMs ?? 150;
  const startedAt = Date.now();
  let lastError: unknown = null;
  let lastValue: unknown = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await input.read();
      lastValue = value;
      if (input.accept(value)) {
        return value;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const diagnostics = input.diagnostics
    ? await withDiagnosticTimeout("poll diagnostics", async () =>
        input.diagnostics?.(),
      )
    : null;
  const message = [
    `[convex-embedded] Timed out waiting for live condition${input.description ? `: ${input.description}` : ""}.`,
    `Last value: ${safeJson(lastValue)}`,
    `Last error: ${safeJson(lastError)}`,
    diagnostics ? `Diagnostics: ${safeJson(diagnostics)}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  if (lastError instanceof Error) {
    lastError.message = `${lastError.message}\n${message}`;
    throw lastError;
  }

  throw new Error(message);
}

export async function waitForMappedRemoteId<T extends string>(
  client: Awaited<ReturnType<typeof createLiveClient>>["client"],
  localId: string,
): Promise<T> {
  const remoteId = await pollUntil({
    description: `remote ID mapping for local ${localId}`,
    read: async () => {
      const entry = getEmbeddedClientEntry(client);
      if (!entry) {
        return null;
      }

      const mappings = (await entry.runtime.executeLocal({
        kind: "query",
        path: "_system:idMapGetAll",
        args: { identityKey: null },
      })) as Array<{ localId: string; remoteId: string }>;

      return (
        mappings.find((mapping) => mapping.localId === localId)?.remoteId ??
        null
      );
    },
    accept: (value) => typeof value === "string",
    diagnostics: () => describeLiveClientState(client),
  });
  return remoteId as T;
}
