import { Fx } from "@robelest/fx";

import { compileWasmModule } from "@/browser/preload";
import { BrowserSessionBroadcast } from "@/browser/session";
import { openWaSqliteStorage } from "@/browser/sqlite";
import { createBrowserStorageSurface } from "@/browser/storage";
import { BrowserWriteBroadcast } from "@/browser/write";
import { createAmbientCryptoProvider } from "@/runtime/crypto";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";

export function createBrowserPlatformAdapter(
  options: {
    workerUrl?: URL | string;
  } = {},
): EmbeddedPlatformAdapter {
  const platformCrypto = createAmbientCryptoProvider();
  const createProcessorId = ({ name }: { name: string }) => {
    const suffix = platformCrypto.randomUUID();
    return `${name}:browser:${suffix}`;
  };

  return {
    crypto: platformCrypto,
    async openPersistence({
      name,
    }): Promise<import("@/storage/adapter").StorageAdapter | null> {
      console.info(
        `[convex-embedded] starting wa-sqlite persistence bootstrap for ${name}`,
      );
      const pipeline = Fx.gen(function* () {
        const wasmModule = yield* Fx.from({
          ok: () => compileWasmModule(),
          err: (err) => err as Error,
        });

        if (!wasmModule) {
          console.debug(
            "[convex-embedded] WASM not available, skipping persistence",
          );
          return null;
        }

        return yield* Fx.from({
          ok: () =>
            openWaSqliteStorage({
              name,
              wasmModule,
              workerUrl: options.workerUrl,
            }),
          err: (err) => err as Error,
        });
      }).pipe(
        Fx.tap(() =>
          Fx.sync(() => {
            console.info(
              `[convex-embedded] wa-sqlite persistence bootstrap finished for ${name}`,
            );
          }),
        ),
        Fx.recover((error) =>
          Fx.sync(() => {
            console.error(
              "[convex-embedded] wa-sqlite storage init failed, continuing in-memory",
              error,
            );
            return null;
          }),
        ),
      );

      return Fx.run(pipeline);
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
    connectivity: {
      isOnline() {
        return typeof navigator === "undefined" || navigator.onLine !== false;
      },
      onOnline(callback) {
        if (typeof globalThis.addEventListener !== "function") {
          return () => {};
        }
        globalThis.addEventListener("online", callback);
        return () => globalThis.removeEventListener("online", callback);
      },
      onOffline(callback) {
        if (typeof globalThis.addEventListener !== "function") {
          return () => {};
        }
        globalThis.addEventListener("offline", callback);
        return () => globalThis.removeEventListener("offline", callback);
      },
    },
    processorIdentity: {
      getProcessorId: createProcessorId,
    },
  };
}
