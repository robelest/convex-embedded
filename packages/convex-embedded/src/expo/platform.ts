import { Fx } from "@robelest/fx";

import { createExpoConnectivityAdapter } from "@/expo/connectivity";
import { createExpoCryptoProvider } from "@/expo/crypto";
import { openExpoSqliteStorage } from "@/expo/sqlite";
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
      return Fx.run(
        Fx.from({
          ok: () =>
            openExpoSqliteStorage({
              name,
              directory: options.databaseDirectory,
            }),
          err: (error) => error as Error,
        }).pipe(
          Fx.recover((error) =>
            Fx.sync(() => {
              console.error(
                "[convex-embedded] expo-sqlite storage init failed, continuing in-memory",
                error,
              );
              return null;
            }),
          ),
        ),
      );
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
