import type { ConvexClient } from "convex/browser";

import type { UserIdentity } from "@/auth/resolver";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { SessionBroadcast } from "@/runtime/platform";

export type AuthTokenFetcher = Parameters<ConvexClient["setAuth"]>[0];
export type UserIdentitySource = () => Promise<UserIdentity | null>;

export interface AuthOptions {
  fetchToken?: AuthTokenFetcher;
  getUserIdentity?: UserIdentitySource;
  getIdentityKey?: (identity: UserIdentity | null) => string | null;
  verifyToken?: (token: string) => Promise<UserIdentity | null>;
}

export type AuthState =
  | { status: "idle" }
  | { status: "refreshing" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; identity?: UserIdentity; identityKey?: string }
  | { status: "offlineStale"; identity?: UserIdentity; identityKey?: string }
  | { status: "reauthRequired"; identity?: UserIdentity; identityKey?: string }
  | {
      status: "identityMismatch";
      identity?: UserIdentity;
      identityKey?: string;
    }
  | { status: "error"; error: Error };

export interface AuthEntry {
  runtime: EmbeddedRuntime;
  getIdentityKey?: (identity: UserIdentity | null) => string | null;
  getUserIdentitySource?: UserIdentitySource;
  currentAuthFetcher?: AuthTokenFetcher;
  getPendingCount: () => number;
  refreshSync?: () => Promise<void>;
  activeIdentityKey: string | null;
  sessionBroadcast?: SessionBroadcast;
  state: AuthState;
  listeners: Set<(state: AuthState) => void>;
}

interface AuthSnapshot {
  identity?: UserIdentity;
  identityKey?: string;
}

export function setOfflineStaleIfNeeded(entry: AuthEntry): void {
  if (entry.state.status !== "authenticated") {
    return;
  }

  notifyAuthListeners(entry, {
    status: "offlineStale",
    identity: entry.state.identity,
    identityKey: entry.state.identityKey,
  });
}

export function restoreAuthenticatedIfNeeded(entry: AuthEntry): void {
  if (entry.state.status !== "offlineStale") {
    return;
  }

  notifyAuthListeners(entry, {
    status: "authenticated",
    identity: entry.state.identity,
    identityKey: entry.state.identityKey,
  });
}

export function getAuthSnapshot(state: AuthState): AuthSnapshot {
  switch (state.status) {
    case "authenticated":
    case "offlineStale":
    case "reauthRequired":
    case "identityMismatch":
      return {
        identity: state.identity,
        identityKey: state.identityKey,
      };
    default:
      return {};
  }
}

export function notifyAuthListeners(entry: AuthEntry, state: AuthState): void {
  entry.state = state;
  for (const listener of entry.listeners) {
    try {
      listener(state);
    } catch {
      // Listener failures should not break auth propagation.
    }
  }
}

export function toAuthenticatedState(
  identity: UserIdentity | null,
  identityKey: string | null,
): AuthState {
  return identity
    ? {
        status: "authenticated",
        identity,
        identityKey: identityKey ?? undefined,
      }
    : { status: "authenticated" };
}
