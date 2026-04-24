/**
 * Persistence attach flow for embedded runtimes.
 *
 * Opens the platform storage adapter, optionally wraps it in encrypted storage,
 * installs it on the runtime database, and hydrates local documents before the
 * runtime starts serving reads.
 *
 * @internal
 */
import { hasAuthoritativeCommit } from "@/persistence/probe";
import type { PersistenceInput } from "@/runtime/services/persist";
import { createEncryptedStorage } from "@/storage/encrypted";

const now = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * Attach platform persistence to an embedded runtime.
 *
 * @param input - Runtime, platform, and storage configuration.
 * @returns A promise that resolves once the storage adapter is installed and hydrated.
 */
export async function attachPlatformPersistence(
  input: PersistenceInput,
): Promise<void> {
  const started = now();

  const storage = await input.platform.openPersistence({
    name: input.name,
    runtime: input.runtime,
    encryption: input.encryption,
  });

  if (storage) {
    const authoritative = hasAuthoritativeCommit(storage);
    if (input.encryption && authoritative) {
      throw new Error(
        "[convex-embedded] encryption wrapper is only supported for non-authoritative persistence adapters. Use platform-native encryption on your SQLite driver or disable local encryption.",
      );
    }
    input.runtime.setPersistenceAdapter(storage);
    input.runtime.db.setStorage(
      input.encryption
        ? createEncryptedStorage(storage, {
            ...input.encryption,
            crypto: input.runtime.crypto,
            getIdentityKey: () => input.runtime.getIdentityKey(),
          })
        : storage,
    );
  }

  if (storage) {
    const prefetchTableNames = input.prefetch
      ? Object.keys(input.prefetch.tables)
      : [];
    const hydrationStarted = now();
    await input.runtime.db.hydrate();
    const hasPersistedRows =
      prefetchTableNames.length > 0 &&
      prefetchTableNames.some((tableName) =>
        input.runtime.db.hasDocumentsForTable(tableName),
      );
    if (input.prefetch && !hasPersistedRows) {
      await input.runtime.ingestPrefetchUngated(input.prefetch);
    }
    await input.runtime.resumePersistedState();
    const ended = now();
    console.info(
      `[convex-embedded] persistence attach for ${input.name}: open=${(hydrationStarted - started).toFixed(1)}ms hydrate=${(ended - hydrationStarted).toFixed(1)}ms total=${(ended - started).toFixed(1)}ms`,
    );
  } else {
    if (input.prefetch) {
      await input.runtime.ingestPrefetchUngated(input.prefetch);
    }
    console.info(
      `[convex-embedded] persistence attach for ${input.name}: unavailable after ${(now() - started).toFixed(1)}ms`,
    );
  }
}
