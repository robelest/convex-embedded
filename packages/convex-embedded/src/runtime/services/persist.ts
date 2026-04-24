import type { Prefetch } from "@/client/prefetch";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { EmbeddedPlatformAdapter } from "@/runtime/platform";
import type { EncryptionOptions } from "@/storage/encrypted";

export interface PersistenceInput {
  readonly runtime: EmbeddedRuntime;
  readonly platform: EmbeddedPlatformAdapter;
  readonly name: string;
  readonly encryption?: Omit<EncryptionOptions, "getIdentityKey">;
  readonly prefetch?: Prefetch;
}
