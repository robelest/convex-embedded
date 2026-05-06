import { BrowserSessionBroadcast } from "@/browser/session";
import { openBrowserStorage } from "@/browser/sqlite/adapter";
import { createBrowserStorageSurface } from "@/browser/storage";
import { createBrowserWorkScheduler } from "@/browser/work";
import { BrowserWriteBroadcast } from "@/browser/write";
import { createAmbientCryptoProvider } from "@/runtime/crypto";
import {
  createAmbientConnectivityAdapter,
  type EmbeddedPlatformAdapter,
} from "@/runtime/platform";
import { createLogger } from "@/shared/logger";

const log = createLogger("browser");

const SQLITE_FILE_SUFFIXES = ["", "-journal", "-wal"] as const;

function isNotFoundError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotFoundError"
  );
}

async function resolveOpfsDirectory(name: string): Promise<{
  directory: FileSystemDirectoryHandle;
  baseName: string;
} | null> {
  const root = await globalThis.navigator?.storage?.getDirectory?.();
  if (!root) {
    return null;
  }

  const pathParts = name.split("/").filter((part) => part.length > 0);
  const baseName = pathParts.pop();
  if (!baseName) {
    return null;
  }

  let directory = root;
  for (const pathPart of pathParts) {
    try {
      directory = await directory.getDirectoryHandle(pathPart);
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  return { directory, baseName };
}

async function clearBrowserSqliteFiles(name: string): Promise<boolean> {
  const resolved = await resolveOpfsDirectory(name);
  if (!resolved) {
    return false;
  }

  for (const suffix of SQLITE_FILE_SUFFIXES) {
    try {
      await resolved.directory.removeEntry(`${resolved.baseName}${suffix}`);
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
  }

  return true;
}

/**
 * Delete all persisted browser-side embedded data for a database name.
 *
 * @param name - Persistent embedded database name.
 * @returns A promise that resolves once sqlite files or fallback storage have
 * been cleared.
 */
export async function clearBrowserLocalData(name: string): Promise<void> {
  if (await clearBrowserSqliteFiles(name)) {
    return;
  }

  const storage = await openBrowserStorage({ name });
  try {
    await storage.clearAll();
  } finally {
    await storage.close?.();
  }
}

/**
 * Create the browser platform adapter used by embedded browser clients.
 *
 * @returns A platform adapter that provides OPFS-backed storage, ambient
 * browser crypto/connectivity, cross-tab broadcasts, and browser storage
 * surfaces.
 */
export function createBrowserPlatformAdapter(): EmbeddedPlatformAdapter {
  const platformCrypto = createAmbientCryptoProvider();
  const createProcessorId = ({ name }: { name: string }) => {
    const suffix = platformCrypto.randomUUID();
    return `${name}:browser:${suffix}`;
  };

  return {
    crypto: platformCrypto,
    async openStorage({
      name,
      runtime,
    }): Promise<import("@/storage/adapter").StorageAdapter | null> {
      log.debug(`starting sqlite storage for ${name}`);
      try {
        const storage = await openBrowserStorage({
          name,
          userTableSpecs: runtime.getUserTableSpecs() ?? undefined,
        });
        log.debug(`sqlite storage ready for ${name}`);
        return storage;
      } catch (error) {
        log.error("sqlite init failed, continuing in-memory", error);
        return null;
      }
    },
    createSessionBroadcast({ name }) {
      return new BrowserSessionBroadcast(`${name}:session`);
    },
    createWriteBroadcast({ name }) {
      return new BrowserWriteBroadcast(`${name}:writes`);
    },
    createStorageSurface({ runtime, crypto }) {
      return createBrowserStorageSurface(runtime, crypto);
    },
    connectivity: createAmbientConnectivityAdapter(),
    processorIdentity: {
      getProcessorId: createProcessorId,
    },
    workScheduler: createBrowserWorkScheduler(),
  };
}
