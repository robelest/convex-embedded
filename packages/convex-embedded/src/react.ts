import type { ConvexClient } from "convex/browser";
import type { ConvexReactClient } from "convex/react";

import {
  compileWasmModule,
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
  type ConvexModuleRegistry,
  type EncryptionOptions,
  type RemoteOptions,
  type RemoteState,
} from "@/browser/index";
import {
  unwrapEmbeddedBrowserClient,
  wrapConvexClientForReact,
} from "@/react/client";

export type {
  AuthOptions,
  AuthState,
  ClientOptions,
  ConvexModuleRegistry,
  EncryptionOptions,
  RemoteOptions,
  RemoteState,
};

export { compileWasmModule, createBrowserPlatformAdapter };

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

export function getRemoteState(client: ConvexClient | ConvexReactClient) {
  return getBrowserRemoteState(resolveEmbeddedBrowserClient(client));
}

export function subscribeRemoteState(
  client: ConvexClient | ConvexReactClient,
  callback: (state: RemoteState) => void,
) {
  return subscribeBrowserRemoteState(
    resolveEmbeddedBrowserClient(client),
    callback,
  );
}

export function getAuthState(client: ConvexClient | ConvexReactClient) {
  return getBrowserAuthState(resolveEmbeddedBrowserClient(client));
}

export function subscribeAuthState(
  client: ConvexClient | ConvexReactClient,
  callback: (state: AuthState) => void,
) {
  return subscribeBrowserAuthState(
    resolveEmbeddedBrowserClient(client),
    callback,
  );
}

export function getAuthIdentity(client: ConvexClient | ConvexReactClient) {
  return getBrowserAuthIdentity(resolveEmbeddedBrowserClient(client));
}

export function reauthenticate(client: ConvexClient | ConvexReactClient) {
  return reauthenticateBrowserClient(resolveEmbeddedBrowserClient(client));
}

export function setAuthIdentity(
  client: ConvexClient | ConvexReactClient,
  identity: Parameters<typeof setBrowserAuthIdentity>[1],
) {
  return setBrowserAuthIdentity(resolveEmbeddedBrowserClient(client), identity);
}

export function logout(client: ConvexClient | ConvexReactClient) {
  return logoutBrowserClient(resolveEmbeddedBrowserClient(client));
}

export function switchIdentity(
  client: ConvexClient | ConvexReactClient,
  identity: Parameters<typeof switchBrowserIdentity>[1],
) {
  return switchBrowserIdentity(resolveEmbeddedBrowserClient(client), identity);
}
