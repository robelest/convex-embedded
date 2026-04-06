import { Fx } from "@robelest/fx";

import { getIdentityKey, type UserIdentity } from "@/auth/resolver";
import {
  getAuthSnapshot,
  notifyAuthListeners,
  toAuthenticatedState,
  type AuthEntry,
  type AuthTokenFetcher,
  type UserIdentitySource,
} from "@/client/auth/entry";
import { asError } from "@/client/routing/refs";
import { SystemPaths } from "@/kernel/system";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { StoreMigrationManifest } from "@/runtime/migrations/types";

export const AUTH_STATE_STORE_MIGRATIONS: StoreMigrationManifest = {
  store: "authState",
  scope: "global",
  version: 1,
};

export async function initializeActiveIdentityKey(
  runtime: EmbeddedRuntime,
): Promise<string | null> {
  const value = await runtime.executeBootstrapLocal({
    kind: "query",
    path: SystemPaths.authStateGetActive,
    args: {},
  });
  return typeof value === "string" ? value : null;
}

async function writeActiveIdentityKey(
  runtime: EmbeddedRuntime,
  identityKey: string | null,
): Promise<void> {
  await runtime.executeLocal({
    kind: "mutation",
    path: SystemPaths.authStateSetActive,
    args: { activeIdentityKey: identityKey },
    applyLocalEffects: false,
  });
}

async function listPendingIdentityKeys(
  runtime: EmbeddedRuntime,
): Promise<string[]> {
  const value = await runtime.executeLocal({
    kind: "query",
    path: SystemPaths.pendingListIdentityKeys,
    args: {},
  });
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

async function hasPendingWorkForOtherIdentity(
  entry: AuthEntry,
): Promise<boolean> {
  const activeIdentityKey = entry.activeIdentityKey;
  const identityKeys = await listPendingIdentityKeys(entry.runtime);
  return identityKeys.some((identityKey) => identityKey !== activeIdentityKey);
}

async function migrateAnonymousDataIfNeeded(
  entry: AuthEntry,
  previousIdentityKey: string | undefined,
  nextIdentityKey: string | null,
): Promise<void> {
  if (previousIdentityKey !== null && previousIdentityKey !== undefined) {
    return;
  }
  if (nextIdentityKey === null) {
    return;
  }

  await entry.runtime.executeLocal({
    kind: "mutation",
    path: SystemPaths.identityMoveAnonymousToIdentity,
    args: { identityKey: nextIdentityKey },
    applyLocalEffects: false,
  });
  await entry.runtime.migrateAnonymousDataToIdentity(nextIdentityKey);
}

export async function refreshAuthFromSource(entry: AuthEntry): Promise<void> {
  if (!entry.getUserIdentitySource) {
    return;
  }

  const identity = await entry.getUserIdentitySource();
  await applyAuthIdentity(entry, identity, false);
}

export function applyAuthIdentity(
  entry: AuthEntry,
  identity: UserIdentity | null,
  broadcast: boolean,
): Promise<void> {
  const previous = getAuthSnapshot(entry.state);
  const identityKey =
    entry.getIdentityKey?.(identity) ?? getIdentityKey(identity);
  return Fx.run(
    Fx.from({
      ok: async () => {
        entry.runtime.setIdentity(identity);
        entry.runtime.setActiveIdentityKey(identityKey);
        await entry.runtime.refreshLocalQueryWatches();
        await migrateAnonymousDataIfNeeded(
          entry,
          previous.identityKey,
          identityKey,
        );
        entry.activeIdentityKey = identityKey;
        await writeActiveIdentityKey(entry.runtime, identityKey);

        if (identity === null) {
          notifyAuthListeners(entry, { status: "unauthenticated" });
          await entry.refreshSync?.();
          if (broadcast) {
            entry.sessionBroadcast?.notify({ type: "authChanged" });
          }
          return;
        }

        if (
          previous.identityKey &&
          identityKey &&
          previous.identityKey !== identityKey &&
          (await hasPendingWorkForOtherIdentity(entry))
        ) {
          notifyAuthListeners(entry, {
            status: "identityMismatch",
            identity,
            identityKey,
          });
          await entry.refreshSync?.();
          if (broadcast) {
            entry.sessionBroadcast?.notify({ type: "authChanged" });
          }
          return;
        }

        notifyAuthListeners(entry, toAuthenticatedState(identity, identityKey));
        await entry.refreshSync?.();
        if (broadcast) {
          entry.sessionBroadcast?.notify({ type: "authChanged" });
        }
      },
      err: (err) => asError(err),
    }).pipe(
      Fx.inspect((err) =>
        Fx.sync(() => {
          notifyAuthListeners(entry, { status: "error", error: err });
        }),
      ),
      Fx.recover(() => Fx.unit),
    ),
  );
}

export function wrapFetchToken(
  entry: AuthEntry,
  runtime: EmbeddedRuntime,
  fetchToken: AuthTokenFetcher,
  getUserIdentity?: UserIdentitySource,
  resolveIdentityKey?: (identity: UserIdentity | null) => string | null,
): AuthTokenFetcher {
  return async (args) => {
    const previous = getAuthSnapshot(entry.state);
    notifyAuthListeners(entry, { status: "refreshing" });

    try {
      const token = await fetchToken(args);

      if (token === null || token === undefined) {
        runtime.setIdentity(null);
        await runtime.refreshLocalQueryWatches();
        if (previous.identityKey) {
          notifyAuthListeners(entry, {
            status: "reauthRequired",
            identity: previous.identity,
            identityKey: previous.identityKey,
          });
        } else {
          notifyAuthListeners(entry, { status: "unauthenticated" });
        }
        entry.sessionBroadcast?.notify({ type: "authChanged" });
        return token;
      }

      const identity = getUserIdentity ? await getUserIdentity() : null;
      const identityKey =
        resolveIdentityKey?.(identity) ?? getIdentityKey(identity);
      runtime.setIdentity(identity);
      runtime.setActiveIdentityKey(identityKey);
      await runtime.refreshLocalQueryWatches();
      await migrateAnonymousDataIfNeeded(
        entry,
        previous.identityKey,
        identityKey,
      );
      entry.activeIdentityKey = identityKey;
      await writeActiveIdentityKey(runtime, identityKey);

      if (await hasPendingWorkForOtherIdentity(entry)) {
        notifyAuthListeners(entry, {
          status: "identityMismatch",
          identity: identity ?? undefined,
          identityKey: identityKey ?? undefined,
        });
      } else {
        notifyAuthListeners(entry, toAuthenticatedState(identity, identityKey));
      }
      entry.sessionBroadcast?.notify({ type: "authChanged" });
      return token;
    } catch (err) {
      runtime.setIdentity(null);
      await runtime.refreshLocalQueryWatches();
      notifyAuthListeners(entry, { status: "error", error: asError(err) });
      throw err;
    }
  };
}

export function installIdentityBridge(input: {
  entry: AuthEntry;
  runtime: EmbeddedRuntime;
  getUserIdentity?: UserIdentitySource;
  resolveIdentityKey?: (identity: UserIdentity | null) => string | null;
}): void {
  const { entry, runtime, getUserIdentity, resolveIdentityKey } = input;
  if (!getUserIdentity) {
    return;
  }

  notifyAuthListeners(entry, { status: "refreshing" });
  void getUserIdentity()
    .then(async (identity) => {
      const identityKey =
        resolveIdentityKey?.(identity) ?? getIdentityKey(identity);
      entry.activeIdentityKey = identityKey;
      runtime.setIdentity(identity);
      runtime.setActiveIdentityKey(identityKey);
      await runtime.refreshLocalQueryWatches();
      void writeActiveIdentityKey(runtime, identityKey);
      notifyAuthListeners(
        entry,
        identity
          ? toAuthenticatedState(identity, identityKey)
          : { status: "unauthenticated" },
      );
    })
    .catch((err) => {
      runtime.setIdentity(null);
      void runtime.refreshLocalQueryWatches();
      notifyAuthListeners(entry, { status: "error", error: asError(err) });
    });
}
