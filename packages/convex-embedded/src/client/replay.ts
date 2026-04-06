import type { ConvexModuleRegistry } from "@/kernel/modules";
import { PENDING_REPLAY_META, type PendingReplayMeta } from "@/shared/symbols";

export async function discoverPendingReplayMetadata(
  modules: ConvexModuleRegistry,
): Promise<Map<string, PendingReplayMeta>> {
  const metadata = new Map<string, PendingReplayMeta>();

  await Promise.all(
    Object.entries(modules).map(async ([moduleId, loadModule]) => {
      let loaded: Awaited<ReturnType<typeof loadModule>>;
      try {
        loaded = await loadModule();
      } catch {
        return;
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
    }),
  );

  return metadata;
}
