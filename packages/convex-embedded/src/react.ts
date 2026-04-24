/**
 * React entry point for `@robelest/convex-embedded/react`.
 *
 * This surface layers React-friendly helpers on top of the browser entry so
 * callers can use `ConvexProvider`, `useQuery`, and related hooks without
 * manually wrapping a generic browser client.
 *
 * @packageDocumentation
 */
import type { ConvexClient } from "convex/browser";
import type { ConvexReactClient } from "convex/react";

import {
  createBrowserPlatformAdapter,
  createConvexClient,
  getAuthIdentity as getBrowserAuthIdentity,
  getAuthState as getBrowserAuthState,
  getRemoteState as getBrowserRemoteState,
  logout as logoutBrowserClient,
  reauthenticate as reauthenticateBrowserClient,
  setAuthIdentity as setBrowserAuthIdentity,
  subscribeAuthState as subscribeBrowserAuthState,
  subscribeRemoteState as subscribeBrowserRemoteState,
  switchIdentity as switchBrowserIdentity,
  type AuthOptions,
  type AuthState,
  type ClientOptions,
  type ConvexInput,
  type EncryptionOptions,
  type RemoteOptions,
  type RemoteState,
} from "@/browser/index";
import {
  unwrapEmbeddedBrowserClient,
  wrapConvexClientForReact,
} from "@/react/client";

/**
 * Browser-compatible config and state types re-exported for React consumers.
 */
export type {
  AuthOptions,
  AuthState,
  ClientOptions,
  ConvexInput,
  EncryptionOptions,
  RemoteOptions,
  RemoteState,
};

/**
 * Re-export the browser platform adapter for advanced React integrations.
 */
export { createBrowserPlatformAdapter };

/**
 * React entry point for `@robelest/convex-embedded/react`.
 *
 * Use this entry when you want React hook compatibility (`ConvexProvider`,
 * `useQuery`, `useMutation`, `usePaginatedQuery`) while keeping the generic
 * browser client surface framework-agnostic.
 *
 * @see createConvexClient
 * @see wrapConvexClientForReact
 * @category Factory
 */
export function createConvexReactClient(options: ClientOptions) {
  return wrapConvexClientForReact(createConvexClient(options));
}

/**
 * Wrap a generic embedded browser `ConvexClient` in a
 * `ConvexReactClient`-compatible adapter.
 *
 * @param client - Embedded browser client created by `createConvexClient(...)`.
 * @returns A React-compatible client for `ConvexProvider`.
 *
 * @category Factory
 */
export function wrapConvexBrowserClientForReact(client: ConvexClient) {
  return wrapConvexClientForReact(client);
}

function resolveEmbeddedBrowserClient(
  client: ConvexClient | ConvexReactClient,
): ConvexClient {
  return unwrapEmbeddedBrowserClient(client);
}

/**
 * Read the current remote sync state from a React-compatible client.
 *
 * @param client - Embedded browser or React client instance.
 * @returns The current remote sync state snapshot.
 *
 * @see subscribeRemoteState
 */
export function getRemoteState(client: ConvexClient | ConvexReactClient) {
  return getBrowserRemoteState(resolveEmbeddedBrowserClient(client));
}

/**
 * Subscribe to remote sync state transitions from a React-compatible client.
 *
 * @param client - Embedded browser or React client instance.
 * @param callback - Listener invoked whenever the remote sync state changes.
 * @returns An unsubscribe function.
 *
 * @see getRemoteState
 */
export function subscribeRemoteState(
  client: ConvexClient | ConvexReactClient,
  callback: (state: RemoteState) => void,
) {
  return subscribeBrowserRemoteState(
    resolveEmbeddedBrowserClient(client),
    callback,
  );
}

/**
 * Read the current embedded auth state from a React-compatible client.
 *
 * @param client - Embedded browser or React client instance.
 * @returns The current auth state snapshot.
 *
 * @see subscribeAuthState
 */
export function getAuthState(client: ConvexClient | ConvexReactClient) {
  return getBrowserAuthState(resolveEmbeddedBrowserClient(client));
}

/**
 * Subscribe to embedded auth state changes from a React-compatible client.
 *
 * @param client - Embedded browser or React client instance.
 * @param callback - Listener invoked whenever the auth state changes.
 * @returns An unsubscribe function.
 *
 * @see getAuthState
 */
export function subscribeAuthState(
  client: ConvexClient | ConvexReactClient,
  callback: (state: AuthState) => void,
) {
  return subscribeBrowserAuthState(
    resolveEmbeddedBrowserClient(client),
    callback,
  );
}

/**
 * Read the current embedded user identity from a React-compatible client.
 *
 * @param client - Embedded browser or React client instance.
 * @returns The current embedded identity, or `null` when unauthenticated.
 */
export function getAuthIdentity(client: ConvexClient | ConvexReactClient) {
  return getBrowserAuthIdentity(resolveEmbeddedBrowserClient(client));
}

/**
 * Force token refresh and re-run embedded auth reconciliation.
 *
 * @param client - Embedded browser or React client instance.
 * @returns A promise that resolves once auth reconciliation completes.
 */
export function reauthenticate(client: ConvexClient | ConvexReactClient) {
  return reauthenticateBrowserClient(resolveEmbeddedBrowserClient(client));
}

/**
 * Set the embedded identity explicitly for the current client.
 *
 * @param client - Embedded browser or React client instance.
 * @param identity - Identity to install, or `null` to clear auth state.
 * @returns A promise that resolves once the local auth state is updated.
 */
export function setAuthIdentity(
  client: ConvexClient | ConvexReactClient,
  identity: Parameters<typeof setBrowserAuthIdentity>[1],
) {
  return setBrowserAuthIdentity(resolveEmbeddedBrowserClient(client), identity);
}

/**
 * Clear the embedded auth identity for a React-compatible client.
 *
 * @param client - Embedded browser or React client instance.
 * @returns A promise that resolves once auth state is cleared.
 */
export function logout(client: ConvexClient | ConvexReactClient) {
  return logoutBrowserClient(resolveEmbeddedBrowserClient(client));
}

/**
 * Switch the embedded client to a new identity.
 *
 * @param client - Embedded browser or React client instance.
 * @param identity - Identity to activate.
 * @returns A promise that resolves once auth state is updated.
 */
export function switchIdentity(
  client: ConvexClient | ConvexReactClient,
  identity: Parameters<typeof switchBrowserIdentity>[1],
) {
  return switchBrowserIdentity(resolveEmbeddedBrowserClient(client), identity);
}
