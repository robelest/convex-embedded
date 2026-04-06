import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import {
  createEncryptedStorage,
  type EncryptionOptions,
} from "@/storage/encrypted";

export async function attachPlatformPersistence(input: {
  runtime: EmbeddedRuntime;
  platform: EmbeddedPlatformAdapter;
  name: string;
  encryption?: Omit<EncryptionOptions, "getIdentityKey">;
}): Promise<void> {
  const storage = await input.platform.openPersistence({
    name: input.name,
    runtime: input.runtime,
    encryption: input.encryption,
  });

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

  await input.runtime.db.hydrate();
}
