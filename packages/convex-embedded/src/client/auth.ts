import type { ConvexClient } from "convex/browser";

import type { UserIdentity } from "@/auth";
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

/**
 * Embedded auth entry and configuration types re-exported for advanced
 * integrations.
 */
export type {
  AuthEntry,
  AuthOptions,
  AuthState,
  AuthTokenFetcher,
  UserIdentitySource,
} from "@/client/auth/entry";
/**
 * Advanced auth controller helpers re-exported for integration code.
 * @internal
 */
export {
  AUTH_STATE_STORE_MIGRATIONS,
  initializeActiveIdentityKey,
  refreshAuthFromSource,
  restoreAuthenticatedIfNeeded,
  setOfflineStaleIfNeeded,
};

const AUTH_ENTRIES = Symbol.for("convex-embedded:client/auth:authEntries");

type AuthGlobal = typeof globalThis & {
  [AUTH_ENTRIES]?: WeakMap<ConvexClient, AuthEntry>;
};

function getAuthEntriesStore() {
  const globalState = globalThis as AuthGlobal;
  globalState[AUTH_ENTRIES] ??= new WeakMap<ConvexClient, AuthEntry>();
  return globalState[AUTH_ENTRIES];
}

/**
 * Register the auth state container associated with an embedded browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @param entry - Internal auth entry backing that client.
 * @internal
 */
export function registerAuthEntry(
  client: ConvexClient,
  entry: AuthEntry,
): void {
  getAuthEntriesStore().set(client, entry);
}

/**
 * Remove any auth state container associated with a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @internal
 */
export function deleteAuthEntry(client: ConvexClient): void {
  getAuthEntriesStore().delete(client);
}

/**
 * Look up the internal auth entry for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns The registered auth entry, or `undefined` when auth has not been
 * installed for the client.
 * @internal
 */
export function getAuthEntry(client: ConvexClient): AuthEntry | undefined {
  return getAuthEntriesStore().get(client);
}

/**
 * Read the current embedded auth state for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns The current auth state snapshot.
 */
export function getAuthState(client: ConvexClient): AuthState {
  return getAuthEntriesStore().get(client)?.state ?? { status: "idle" };
}

/**
 * Subscribe to embedded auth state transitions.
 *
 * @param client - Browser `ConvexClient` instance.
 * @param callback - Listener invoked whenever auth state changes.
 * @returns An unsubscribe function.
 */
export function subscribeAuthState(
  client: ConvexClient,
  callback: (state: AuthState) => void,
): () => void {
  const entry = getAuthEntriesStore().get(client);
  if (!entry) return () => {};

  return entry.stateHub.subscribe((state) => {
    try {
      callback(state);
    } catch (err) {
      console.warn("[convex-embedded] auth state callback error", err);
    }
  });
}

/**
 * Force token refresh and rerun embedded auth reconciliation.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns A promise that resolves once the refresh flow completes.
 */
export async function reauthenticate(client: ConvexClient): Promise<void> {
  const entry = getAuthEntriesStore().get(client);
  if (!entry?.currentAuthFetcher) {
    return;
  }

  await entry.currentAuthFetcher({ forceRefreshToken: true });
  await refreshAuthFromSource(entry);
}

/**
 * Read the current embedded user identity for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns The current embedded identity, or `null` when unauthenticated.
 */
export function getAuthIdentity(client: ConvexClient): UserIdentity | null {
  return getAuthEntriesStore().get(client)?.runtime.getIdentity() ?? null;
}

/**
 * Set the embedded identity explicitly.
 *
 * @param client - Browser `ConvexClient` instance.
 * @param identity - Identity to install, or `null` to clear auth state.
 * @returns A promise that resolves once the local auth state is updated.
 */
export async function setAuthIdentity(
  client: ConvexClient,
  identity: UserIdentity | null,
): Promise<void> {
  const entry = getAuthEntriesStore().get(client);
  if (!entry) {
    return;
  }

  await applyAuthIdentity(entry, identity, true);
}

/**
 * Clear the embedded identity for a browser client.
 *
 * @param client - Browser `ConvexClient` instance.
 * @returns A promise that resolves once auth state is cleared.
 */
export function logout(client: ConvexClient): Promise<void> {
  return setAuthIdentity(client, null);
}

/**
 * Switch the embedded client to a new identity.
 *
 * @param client - Browser `ConvexClient` instance.
 * @param identity - Identity to activate.
 * @returns A promise that resolves once auth state is updated.
 */
export function switchIdentity(
  client: ConvexClient,
  identity: UserIdentity,
): Promise<void> {
  return setAuthIdentity(client, identity);
}

/**
 * Install the embedded auth controller on top of a browser `ConvexClient`.
 *
 * @param client - Browser `ConvexClient` instance to patch.
 * @param runtime - Embedded runtime backing the client.
 * @param entry - Internal auth state container for the client.
 * @param options - Auth controller wiring, including optional remote auth
 * forwarding hooks.
 * @internal
 */
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
