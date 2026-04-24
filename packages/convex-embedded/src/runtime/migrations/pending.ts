import type { PendingReplayMeta } from "@/shared/symbols";

import type { StoreMigrationManifest } from "./types";

export const PENDING_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "pendingQueue",
  scope: "identity",
  version: 1,
};

export interface PendingEntryStoreAdapter {
  transaction<T>(work: () => Promise<T> | T): Promise<T>;
  list(identityKey: string | null): Promise<Array<Record<string, unknown>>>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
}

export async function migratePendingEntries(
  adapter: PendingEntryStoreAdapter,
  identityKey: string | null,
  replayMetadata: ReadonlyMap<string, PendingReplayMeta>,
): Promise<void> {
  await adapter.transaction(async () => {
    const entries = await adapter.list(identityKey);
    for (const entry of entries) {
      const ref = typeof entry.ref === "string" ? entry.ref : null;
      const argsJson = typeof entry.args === "string" ? entry.args : null;
      const localResultJson =
        typeof entry.localResult === "string" ? entry.localResult : null;
      if (!ref || !argsJson || !localResultJson) {
        continue;
      }

      const meta = replayMetadata.get(ref);
      const targetVersion = meta?.version ?? 1;
      let currentVersion =
        typeof entry.payloadVersion === "number" ? entry.payloadVersion : 1;

      if (currentVersion > targetVersion) {
        throw new Error(
          `Pending queue entry for "${ref}" is at payload version ${currentVersion}, but this app only supports ${targetVersion}.`,
        );
      }

      let args = JSON.parse(argsJson) as Record<string, unknown>;
      let localResult = JSON.parse(localResultJson) as unknown;

      for (
        let version = currentVersion + 1;
        version <= targetVersion;
        version++
      ) {
        const step = meta?.migrate[version];
        if (!step) {
          currentVersion = version;
          continue;
        }

        const next = await step({
          ref,
          fromVersion: version - 1,
          toVersion: version,
          args,
          localResult,
        });
        args = next.args;
        localResult = next.localResult;
        currentVersion = version;
      }

      const nextArgs = JSON.stringify(args);
      const nextLocalResult = JSON.stringify(localResult);
      if (
        currentVersion !== entry.payloadVersion ||
        nextArgs !== argsJson ||
        nextLocalResult !== localResultJson
      ) {
        await adapter.patch(String(entry._id), {
          args: nextArgs,
          localResult: nextLocalResult,
          payloadVersion: currentVersion,
        });
      }
    }
  });
}
