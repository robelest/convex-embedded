/**
 * Replay metadata discovery for queued local mutations.
 *
 * Scans a lazy Convex module registry for exports tagged with
 * `PENDING_REPLAY_META` so the client can version and migrate pending replay
 * payloads before reconnecting to remote sync.
 *
 * @internal
 */

import type { ConvexModuleRegistry } from "@/kernel/modules";
import { PENDING_REPLAY_META, type PendingReplayMeta } from "@/shared/symbols";

const replayMetadataCache = new WeakMap<
  ConvexModuleRegistry,
  Promise<Map<string, PendingReplayMeta>>
>();

/**
 * Discover replay metadata embedded in module exports.
 *
 * @param modules - Lazy module registry to inspect.
 * @returns A map from `module:export` to replay metadata.
 */
export async function discoverPendingReplayMetadata(
  modules: ConvexModuleRegistry,
): Promise<Map<string, PendingReplayMeta>> {
  const cached = replayMetadataCache.get(modules);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const metadata = new Map<string, PendingReplayMeta>();

    for (const [moduleId, loadModule] of Object.entries(modules)) {
      let loaded: Record<string, unknown> | null = null;
      try {
        loaded = await loadModule();
      } catch {
        loaded = null;
      }

      if (!loaded) {
        continue;
      }
      for (const [exportName, value] of Object.entries(loaded)) {
        const replayMeta =
          value && typeof value === "function"
            ? ((value as unknown as Record<PropertyKey, unknown>)[
                PENDING_REPLAY_META
              ] as PendingReplayMeta | undefined)
            : undefined;
        if (!replayMeta) {
          continue;
        }
        metadata.set(`${moduleId}:${exportName}`, replayMeta);
      }
    }

    return metadata;
  })().catch((error) => {
    replayMetadataCache.delete(modules);
    throw error;
  });

  replayMetadataCache.set(modules, pending);
  return pending;
}
