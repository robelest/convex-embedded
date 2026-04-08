/**
 * Persistence bootstrap for embedded runtimes.
 *
 * Opens the platform storage adapter, optionally wraps it in encrypted storage,
 * installs it on the runtime database, and hydrates local documents before the
 * runtime starts serving reads.
 *
 * @internal
 */
import { Fx } from "@robelest/fx";

import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import {
  createEncryptedStorage,
  type EncryptionOptions,
} from "@/storage/encrypted";

/**
 * Attach platform persistence to an embedded runtime.
 *
 * @param input - Runtime, platform, and storage configuration.
 * @returns A promise that resolves once the storage adapter is installed and hydrated.
 */
export async function attachPlatformPersistence(input: {
  runtime: EmbeddedRuntime;
  platform: EmbeddedPlatformAdapter;
  name: string;
  encryption?: Omit<EncryptionOptions, "getIdentityKey">;
}): Promise<void> {
  await Fx.run(
    Fx.from({
      ok: () =>
        input.platform.openPersistence({
          name: input.name,
          runtime: input.runtime,
          encryption: input.encryption,
        }),
      err: (error) => error as Error,
    }).pipe(
      Fx.tap((storage) =>
        Fx.sync(() => {
          if (!storage) {
            return;
          }
          input.runtime.db.setStorage(
            input.encryption
              ? createEncryptedStorage(storage, {
                  ...input.encryption,
                  crypto: input.runtime.crypto,
                  getIdentityKey: () => input.runtime.getIdentityKey(),
                })
              : storage,
          );
        }),
      ),
      Fx.chain((storage) =>
        storage
          ? Fx.from({
              ok: () => input.runtime.db.hydrate(),
              err: (error) => error as Error,
            })
          : Fx.unit,
      ),
      Fx.map(() => undefined as void),
    ),
  );
}
