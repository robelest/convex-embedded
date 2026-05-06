import "react-native-get-random-values";
import { createExpoConnectivityAdapter } from "@/expo/connectivity";
import { createExpoCryptoProvider } from "@/expo/crypto";
import { openOpSqliteStorage } from "@/expo/sqlite";
import { createExpoStorageSurface } from "@/expo/storage";
import { createExpoWorkScheduler } from "@/expo/work";
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
    async openStorage({ name, runtime }) {
      try {
        return await openOpSqliteStorage({
          name,
          directory: options.databaseDirectory,
          userTableSpecs: runtime.getUserTableSpecs() ?? undefined,
        });
      } catch (error) {
        console.error(
          "[convex-embedded] op-sqlite storage init failed, continuing in-memory",
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
    workScheduler: createExpoWorkScheduler(),
  };
}
