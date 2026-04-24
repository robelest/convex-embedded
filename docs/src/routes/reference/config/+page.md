---
title: Configuration
description:
  Complete reference of all configuration options for convex-embedded.
---

<svelte:head>

  <title>Configuration - convex-embedded</title>
</svelte:head>

# Configuration

This page documents the current browser-facing configuration surface exposed by
`createConvexClient`.

## ClientOptions

```ts
import { createConvexClient } from "@robelest/convex-embedded/browser";

const client = createConvexClient(options: ClientOptions);
```

| Option          | Type                                     | Default             | Description                                                                             |
| --------------- | ---------------------------------------- | ------------------- | --------------------------------------------------------------------------------------- |
| `modules`       | `Record<string, () => Promise<unknown>>` | _required_          | Lazy ESM registry keyed by canonical module id.                                         |
| `schema`        | `unknown`                                | `undefined`         | Default export from `convex/schema.ts`.                                                 |
| `clientOptions` | `Partial<BaseConvexClientOptions>`       | `undefined`         | Forwarded to `ConvexClient`.                                                            |
| `name`          | `string`                                 | `"convex-embedded"` | Persistent browser database name. Shared across tabs.                                   |
| `remote`        | `RemoteOptions`                          | `undefined`         | Enable remote. Omit for local-only.                                                     |
| `auth`          | `AuthOptions`                            | `undefined`         | Auth and identity configuration.                                                        |
| `prefetch`      | `Prefetch`                               | `undefined`         | Initial embedded table data created by `createEmbeddedPrefetch(...)` for SSR/bootstrap. |
| `encryption`    | `EncryptionOptions`                      | `undefined`         | Encrypt persisted local state at rest.                                                  |

## Prefetch bootstrap

To render on the server and start the browser client warm, build prefetch data
from `@robelest/convex-embedded/client` and pass it into both the runtime and
the browser client:

```ts
import { createEmbeddedRuntime } from "@robelest/convex-embedded";
import { createEmbeddedPrefetch } from "@robelest/convex-embedded/client";
import { createConvexClient } from "@robelest/convex-embedded/browser";

const { embedded: prefetched } = await createEmbeddedPrefetch({
  url: process.env.CONVEX_URL!,
  token,
  queries: {
    tasks: {
      query: api.tasks.list,
      args: {},
      collection: "tasks",
    },
  },
});

const runtime = createEmbeddedRuntime({
  modules,
  schema,
  prefetch: prefetched,
});
const client = createConvexClient({
  modules,
  schema,
  remote: { url },
  prefetch: prefetched,
});
```

The browser import is SSR-safe, but `createConvexClient(...)` is still a
browser-only step.

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

## EncryptionOptions

Pass `encryption` when you want persisted local state to be encrypted at rest.

```ts
const client = createConvexClient({
  modules,
  encryption: {
    getActiveKey: async ({ identityKey }) => ({
      keyId: identityKey ?? "anon",
      key: await loadKey(identityKey),
    }),
    getKey: async ({ keyId }) => await loadStoredKey(keyId),
    getIdentityKey: async () => currentIdentityKey(),
  },
});
```

Current shape:

<table>
  <thead>
    <tr>
      <th>Option</th>
      <th>Type</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>getActiveKey</code></td>
      <td><code>(identityKey) =&gt; Promise&lt;active key&gt;</code></td>
      <td>Returns the active encryption key for new writes.</td>
    </tr>
    <tr>
      <td><code>getKey</code></td>
      <td><code>(keyId, identityKey) =&gt; Promise&lt;stored key&gt;</code></td>
      <td>Returns a previously-used key for reads.</td>
    </tr>
    <tr>
      <td><code>getIdentityKey</code></td>
      <td><code>() =&gt; Promise&lt;string | null&gt; | string | null</code></td>
      <td>Identity-aware key partitioning hook.</td>
    </tr>
  </tbody>
</table>

Exact signatures:

```ts
getActiveKey: ({ identityKey }) =>
  Promise<{ keyId: string; key: CryptoKey | Uint8Array }>;

getKey: ({ keyId, identityKey }) => Promise<CryptoKey | Uint8Array>;

getIdentityKey: () => Promise<string | null> | string | null;
```

## RemoteState

The `RemoteState` type describes the current remote state. Read it with
`getRemoteState(client)` or subscribe with
`subscribeRemoteState(client, callback)`.

```ts
type RemoteState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "resolving"; progress?: { completed: number; total: number } }
  | { status: "resolved" }
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
  modules,
});
```

### Local-first with remote

```ts
const client = createConvexClient({
  modules,
  remote: { url: import.meta.env.CONVEX_URL },
});
```

### Full configuration

```ts
const client = createConvexClient({
  modules,
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
  encryption: myEncryptionHooks,
});
```
