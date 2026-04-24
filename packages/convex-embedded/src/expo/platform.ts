import { createExpoConnectivityAdapter } from "@/expo/connectivity";
import { createExpoCryptoProvider } from "@/expo/crypto";
import { openExpoSqlitePersistence } from "@/expo/sqlite";
import { createExpoStorageSurface } from "@/expo/storage";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";

export interface ExpoPlatformOptions {
  databaseDirectory?: string;
  filesDirectory?: string;
}

export function createExpoPlatformAdapter(
  options: ExpoPlatformOptions = {},
): EmbeddedPlatformAdapter {
  const crypto = createExpoCryptoProvider();
  const connectivity = createExpoConnectivityAdapter();

  return {
    crypto,
    async openPersistence({ name }) {
      try {
        return await openExpoSqlitePersistence({
          name,
          directory: options.databaseDirectory,
        });
      } catch (error) {
        console.error(
          "[convex-embedded] expo-sqlite storage init failed, continuing in-memory",
          error,
        );
        return null;
      }
    },
    createStorageSurface({ runtime, crypto: runtimeCrypto }) {
      return createExpoStorageSurface(runtime, runtimeCrypto, {
        directory: options.filesDirectory,
      });
    },
    connectivity,
    processorIdentity: {
      getProcessorId({ name }) {
        return `${name}:expo:${crypto.randomUUID()}`;
      },
    },
  };
}
