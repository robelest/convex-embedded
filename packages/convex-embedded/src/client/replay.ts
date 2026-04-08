/**
 * Replay metadata discovery for queued local mutations.
 *
 * Scans a lazy Convex module registry for exports tagged with
 * `PENDING_REPLAY_META` so the client can version and migrate pending replay
 * payloads before reconnecting to remote sync.
 *
 * @internal
 */
import { Fx } from "@robelest/fx";

import type { ConvexModuleRegistry } from "@/kernel/modules";
import { PENDING_REPLAY_META, type PendingReplayMeta } from "@/shared/symbols";

/**
 * Discover replay metadata embedded in module exports.
 *
 * @param modules - Lazy module registry to inspect.
 * @returns A map from `module:export` to replay metadata.
 */
export async function discoverPendingReplayMetadata(
  modules: ConvexModuleRegistry,
): Promise<Map<string, PendingReplayMeta>> {
  const metadata = new Map<string, PendingReplayMeta>();

  await Fx.run(
    Fx.each(Object.entries(modules), ([moduleId, loadModule]) =>
      Fx.from({
        ok: () => loadModule(),
        err: (error) => error as Error,
      }).pipe(
        Fx.recover(() => Fx.succeed(null)),
        Fx.tap((loaded) =>
          Fx.sync(() => {
            if (!loaded) {
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
        ),
        Fx.map(() => undefined as void),
      ),
    ),
  );

  return metadata;
}
