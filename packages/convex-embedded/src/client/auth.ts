import { Fx } from "@robelest/fx";
import type { ConvexClient } from "convex/browser";

import type { UserIdentity } from "@/auth/resolver";
import {
  AUTH_STATE_STORE_MIGRATIONS,
  applyAuthIdentity,
  initializeActiveIdentityKey,
  installIdentityBridge,
  refreshAuthFromSource,
  wrapFetchToken,
} from "@/client/auth/controllers";
import {
  restoreAuthenticatedIfNeeded,
  setOfflineStaleIfNeeded,
} from "@/client/auth/entry";
import type {
  AuthEntry,
  AuthOptions,
  AuthState,
  AuthTokenFetcher,
} from "@/client/auth/entry";
import type { EmbeddedRuntime } from "@/runtime/embedded";

export type {
  AuthEntry,
  AuthOptions,
  AuthState,
  AuthTokenFetcher,
  UserIdentitySource,
} from "@/client/auth/entry";
export {
  AUTH_STATE_STORE_MIGRATIONS,
  initializeActiveIdentityKey,
  refreshAuthFromSource,
  restoreAuthenticatedIfNeeded,
  setOfflineStaleIfNeeded,
};

const authEntries = new WeakMap<ConvexClient, AuthEntry>();

export function registerAuthEntry(
  client: ConvexClient,
  entry: AuthEntry,
): void {
  authEntries.set(client, entry);
}

export function deleteAuthEntry(client: ConvexClient): void {
  authEntries.delete(client);
}

export function getAuthEntry(client: ConvexClient): AuthEntry | undefined {
  return authEntries.get(client);
}

export function getAuthState(client: ConvexClient): AuthState {
  return authEntries.get(client)?.state ?? { status: "idle" };
}

export function subscribeAuthState(
  client: ConvexClient,
  callback: (state: AuthState) => void,
): () => void {
  const entry = authEntries.get(client);
  if (!entry) return () => {};
  entry.listeners.add(callback);
  return () => entry.listeners.delete(callback);
}

export async function reauthenticate(client: ConvexClient): Promise<void> {
  const entry = authEntries.get(client);
  if (!entry?.currentAuthFetcher) {
    return;
  }

  await Fx.run(
    Fx.from({
      ok: () => entry.currentAuthFetcher!({ forceRefreshToken: true }),
      err: (error) => error as Error,
    }).pipe(
      Fx.chain(() =>
        Fx.from({
          ok: () => refreshAuthFromSource(entry),
          err: (error) => error as Error,
        }),
      ),
      Fx.map(() => undefined as void),
    ),
  );
}

export function getAuthIdentity(client: ConvexClient): UserIdentity | null {
  return authEntries.get(client)?.runtime.getIdentity() ?? null;
}

export function setAuthIdentity(
  client: ConvexClient,
  identity: UserIdentity | null,
): Promise<void> {
  const entry = authEntries.get(client);
  if (!entry) {
    return Promise.resolve();
  }

  return Fx.run(
    Fx.from({
      ok: () => applyAuthIdentity(entry, identity, true),
      err: (error) => error as Error,
    }),
  );
}

export function logout(client: ConvexClient): Promise<void> {
  return setAuthIdentity(client, null);
}

export function switchIdentity(
  client: ConvexClient,
  identity: UserIdentity,
): Promise<void> {
  return setAuthIdentity(client, identity);
}

export function installAuthController(
  client: ConvexClient,
  runtime: EmbeddedRuntime,
  entry: AuthEntry,
  options: {
    authOptions?: AuthOptions;
    forwardSetAuth?: (...args: Parameters<ConvexClient["setAuth"]>) => void;
    forwardClearAuth?: () => void;
    forwardSetAdminAuth?: (...args: any[]) => void;
  },
): void {
  const originalSetAuth = client.setAuth.bind(client);
  const originalClearAuth = (client as any).clearAuth?.bind(client);
  const originalSetAdminAuth = (client as any).setAdminAuth?.bind(client);

  (client as any).setAuth = (...args: Parameters<typeof client.setAuth>) => {
    const [fetchToken, onChange] = args;
    const wrappedFetchToken = wrapFetchToken(
      entry,
      runtime,
      fetchToken,
      options.authOptions?.getUserIdentity,
      options.authOptions?.getIdentityKey,
    );
    entry.currentAuthFetcher = wrappedFetchToken;

    originalSetAuth(wrappedFetchToken, onChange);
    options.forwardSetAuth?.(wrappedFetchToken, onChange);
  };

  (client as any).clearAuth = () => {
    entry.currentAuthFetcher = undefined;
    originalClearAuth?.();
    options.forwardClearAuth?.();
    void applyAuthIdentity(entry, null, true);
  };

  if (typeof originalSetAdminAuth === "function") {
    (client as any).setAdminAuth = (...args: any[]) => {
      entry.currentAuthFetcher = undefined;
      originalSetAdminAuth(...args);
      options.forwardSetAdminAuth?.(...args);
    };
  }

  if (options.authOptions?.fetchToken) {
    (client as any).setAuth(options.authOptions.fetchToken);
    return;
  }

  installIdentityBridge({
    entry,
    runtime,
    getUserIdentity: options.authOptions?.getUserIdentity,
    resolveIdentityKey: options.authOptions?.getIdentityKey,
  });
}
