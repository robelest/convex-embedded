/**
 * Expo entry point for `@robelest/convex-embedded/expo`.
 *
 * This surface mirrors the browser embedded client while wiring in Expo-native
 * storage, crypto, connectivity, and blob storage adapters.
 *
 * @packageDocumentation
 */
import type { BaseConvexClientOptions } from "convex/browser";

import type { AuthOptions, AuthState } from "@/client/auth";
import type { RemoteOptions, RemoteState } from "@/client/remote";
import type { ConvexInput } from "@/kernel/modules";

export type { AuthOptions, AuthState, RemoteOptions, RemoteState };
export type { ConvexInput } from "@/kernel/modules";

/**
 * Options for {@link createConvexClient} in Expo environments.
 *
 * This mirrors the browser client configuration while adding Expo-specific
 * storage directories and returning a React-compatible client wrapper for
 * `convex/react` hooks.
 *
 * @see createConvexClient
 * @category Configuration
 */
export interface ClientOptions {
  /** Generated Convex input containing modules and manifest metadata. */
  convex: ConvexInput;

  /** Optional Convex schema definition used for local validation. */
  schema?: unknown;

  /**
   * Options forwarded to the underlying `ConvexClient` constructor.
   *
   * `webSocketConstructor` is always supplied by the embedded transport.
   */
  clientOptions?: Omit<
    Partial<BaseConvexClientOptions>,
    "webSocketConstructor"
  >;

  /** Persistent database name shared across matching local clients. */
  name?: string;

  /** Enable local-first remote sync against a hosted Convex deployment. */
  remote?: RemoteOptions;

  /** Optional auth configuration for embedded identity + remote tokens. */
  auth?: AuthOptions;

  /** Optional custom directory for the Expo SQLite database files. */
  databaseDirectory?: string;

  /** Optional custom directory for persisted file/blob storage. */
  filesDirectory?: string;
}

ensureConvexAllowFunctionsInBrowser();

/**
 * Create an Expo embedded client.
 *
 * The Expo entry keeps the same embedded runtime and remote sync core as the
 * browser entry, but wires in Expo-native storage adapters and returns a
 * React-compatible client wrapper for use with `convex/react` hooks.
 *
 * @param options - Expo client configuration.
 * @returns A React-compatible embedded Convex client for Expo apps.
 *
 * @example
 * ```ts
 * const client = createConvexClient({
 *   convex,
 *   schema,
 *   remote: { url: process.env.EXPO_PUBLIC_CONVEX_URL! },
 * });
 * ```
 *
 * @see ClientOptions
 * @category Factory
 */
export function createConvexClient(options: ClientOptions) {
  const { createExpoPlatformAdapter } =
    require("@/expo/platform") as typeof import("@/expo/platform");
  const { wrapConvexClientForReact } =
    require("@/react/client") as typeof import("@/react/client");
  const { createEmbeddedClient } =
    require("@/client/factory") as typeof import("@/client/factory");

  const platform = createExpoPlatformAdapter({
    databaseDirectory: options.databaseDirectory,
    filesDirectory: options.filesDirectory,
  });
  return wrapConvexClientForReact(
    createEmbeddedClient({
      options: {
        convex: options.convex,
        schema: options.schema,
        clientOptions: options.clientOptions,
        name: options.name,
        remote: options.remote,
        auth: options.auth,
      },
      platform,
    }),
  );
}

export {
  getAuthState,
  subscribeAuthState,
  reauthenticate,
  getAuthIdentity,
  setAuthIdentity,
  logout,
  switchIdentity,
} from "@/client/auth";

export { createExpoWorkScheduler } from "@/expo/work";

/**
 * Read the current remote sync state for an Expo embedded client.
 *
 * @see subscribeRemoteState
 */
export { getRemoteState, subscribeRemoteState } from "@/client/remote";

function ensureConvexAllowFunctionsInBrowser(): void {
  try {
    const target =
      typeof globalThis.window === "object" && globalThis.window !== null
        ? (globalThis.window as unknown as Record<string, unknown>)
        : (globalThis as Record<string, unknown>);
    const descriptor = Object.getOwnPropertyDescriptor(
      target,
      "__convexAllowFunctionsInBrowser",
    );

    if (descriptor?.writable === false && descriptor.set === undefined) {
      return;
    }

    Object.defineProperty(target, "__convexAllowFunctionsInBrowser", {
      value: true,
      writable: true,
      configurable: true,
    });
  } catch {}
}
