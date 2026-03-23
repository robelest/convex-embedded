---
title: Configuration
description:
  Complete reference of all configuration options for convex-embedded.
---

<svelte:head>

  <title>Configuration - convex-embedded</title>
</svelte:head>

# Configuration

This page documents every option accepted by `createConvexClient`.

## ClientOptions

```ts
import { createConvexClient } from "@robelest/convex-embedded/browser";

const client = createConvexClient(options: ClientOptions);
```

| Option          | Type                                     | Default             | Description                                      |
| --------------- | ---------------------------------------- | ------------------- | ------------------------------------------------ |
| `modules`       | `Record<string, () => Promise<unknown>>` | _required_          | From `import.meta.glob()`. No `{ eager: true }`. |
| `schema`        | `unknown`                                | `undefined`         | Default export from `convex/schema.ts`.          |
| `clientOptions` | `Partial<BaseConvexClientOptions>`       | `undefined`         | Forwarded to `ConvexClient`.                     |
| `workerUrl`     | `URL \| string`                          | auto-resolved       | wa-sqlite worker URL. Rarely needed.             |
| `name`          | `string`                                 | `"convex-embedded"` | IndexedDB database name. Shared across tabs.     |
| `remote`        | `RemoteOptions`                          | `undefined`         | Enable remote. Omit for local-only.              |
| `auth`          | `AuthOptions`                            | `undefined`         | Auth and identity configuration.                 |

## RemoteOptions

Passed as the `remote` field of `ClientOptions`.

```ts
const client = createConvexClient({
  modules,
  remote: {
    url: "https://happy-otter-123.convex.cloud",
    maxRetries: 5,
    retryDelayMs: 2000,
  },
});
```

| Option         | Type     | Default    | Description                                 |
| -------------- | -------- | ---------- | ------------------------------------------- |
| `url`          | `string` | _required_ | Remote Convex deployment URL.               |
| `maxRetries`   | `number` | `3`        | Max retries for CRDT resolve on reconnect.  |
| `retryDelayMs` | `number` | `1000`     | Base retry delay (ms). Exponential backoff. |

## AuthOptions

Passed as the `auth` field of `ClientOptions`.

```ts
const client = createConvexClient({
  modules,
  auth: {
    fetchToken: async ({ forceRefreshToken }) => {
      return await getToken({ skipCache: forceRefreshToken });
    },
    getUserIdentity: async () => currentUserIdentity,
  },
});
```

| Option            | Type                                                 | Default                      | Description                          |
| ----------------- | ---------------------------------------------------- | ---------------------------- | ------------------------------------ |
| `fetchToken`      | `AuthTokenFetcher`                                   | `undefined`                  | Passed to `client.setAuth(...)`.     |
| `getUserIdentity` | `() => Promise<UserIdentity \| null>`                | `undefined`                  | Returns the local embedded identity. |
| `getIdentityKey`  | `(identity: UserIdentity \| null) => string \| null` | `tokenIdentifier ?? subject` | Groups identities for local state.   |
| `verifyToken`     | `(token: string) => Promise<UserIdentity \| null>`   | `undefined`                  | Verifies embedded protocol tokens.   |

## RemoteState

The `RemoteState` type describes the current remote state. Read it with
`getRemoteState(client)` or subscribe with
`subscribeRemoteState(client, callback)`.

```ts
type RemoteState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "resolving"; progress?: { completed: number; total: number } }
  | { status: "ready" }
  | { status: "offline" }
  | { status: "error"; error?: Error };
```

## AuthState

The `AuthState` type describes the current embedded auth state. Read it with
`getAuthState(client)` or subscribe with `subscribeAuthState(client, callback)`.

```ts
type AuthState =
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
```

## Minimal examples

### Local-only

```ts
const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
});
```

### Local-first with remote

```ts
const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  remote: { url: import.meta.env.CONVEX_URL },
});
```

### Full configuration

```ts
const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  schema,
  name: "my-app-production",
  remote: {
    url: import.meta.env.CONVEX_URL,
    maxRetries: 5,
    retryDelayMs: 2000,
  },
  auth: {
    fetchToken: myTokenFetcher,
    getUserIdentity: myIdentityProvider,
    getIdentityKey: (identity) => identity?.email ?? null,
    verifyToken: myTokenVerifier,
  },
});
```
