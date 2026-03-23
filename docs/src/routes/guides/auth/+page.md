---
title: Auth & Identity
description: Authentication and identity scoping in convex-embedded.
---

<svelte:head>

  <title>Auth & Identity - convex-embedded</title>
</svelte:head>

# Auth & Identity

convex-embedded supports authentication through the `auth` option on
`createConvexClient`. Identity information is used to scope local embedded state
per user and to keep `ctx.auth.getUserIdentity()` working inside your Convex
functions running in the browser.

## AuthOptions

Pass an `auth` object to `createConvexClient`:

```ts
import { createConvexClient } from "@robelest/convex-embedded/browser";

const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  remote: { url: import.meta.env.CONVEX_URL },
  auth: {
    fetchToken: myTokenFetcher,
    getUserIdentity: async () => currentUser,
    getIdentityKey: (identity) => identity?.subject ?? null,
  },
});
```

| Option            | Type                                                 | Description                          |
| ----------------- | ---------------------------------------------------- | ------------------------------------ |
| `fetchToken`      | `AuthTokenFetcher`                                   | Passed to `client.setAuth(...)`.     |
| `getUserIdentity` | `() => Promise<UserIdentity \| null>`                | Returns the local embedded identity. |
| `getIdentityKey`  | `(identity: UserIdentity \| null) => string \| null` | Groups identities for local state.   |
| `verifyToken`     | `(token: string) => Promise<UserIdentity \| null>`   | Verifies embedded protocol tokens.   |

## Identity scoping

Local embedded state is automatically isolated per user using an **identity
key**. When a user logs in, their data is stored in a namespace derived from
their identity key. When a different user logs in on the same device, they get
their own isolated namespace.

The default identity key is:

```ts
identity.tokenIdentifier ?? identity.subject;
```

You can override this with the `getIdentityKey` option:

```ts
auth: {
  getIdentityKey: (identity) => identity?.email ?? null,
}
```

## UserIdentity shape

The `UserIdentity` interface matches the shape returned by
`ctx.auth.getUserIdentity()` in the Convex runtime:

```ts
interface UserIdentity {
  subject: string;
  issuer: string;
  tokenIdentifier: string;
  name?: string;
  email?: string;
  pictureUrl?: string;
  nickname?: string;
  givenName?: string;
  familyName?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  updatedAt?: string;
  [key: string]: unknown;
}
```

## AuthState

The embedded auth system exposes a state machine you can subscribe to:

| Status             | Fields                      | Meaning                                                                                   |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------- |
| `idle`             | --                          | Auth has not been configured or has not started yet.                                      |
| `refreshing`       | --                          | A token refresh is in progress.                                                           |
| `unauthenticated`  | --                          | No identity is active.                                                                    |
| `authenticated`    | `identity?`, `identityKey?` | A user identity is active and verified.                                                   |
| `offlineStale`     | `identity?`, `identityKey?` | The device is offline but a previously authenticated identity is still cached.            |
| `reauthRequired`   | `identity?`, `identityKey?` | The cached identity needs re-authentication (token expired, etc.).                        |
| `identityMismatch` | `identity?`, `identityKey?` | A different user is logging in while queued remote work exists for the previous identity. |
| `error`            | `error`                     | An auth operation failed.                                                                 |

### Subscribing to auth state

```ts
import {
  subscribeAuthState,
  getAuthState,
} from "@robelest/convex-embedded/browser";

// One-shot read
const state = getAuthState(client);

// Reactive subscription
const unsub = subscribeAuthState(client, (state) => {
  if (state.status === "authenticated") {
    console.log("Logged in as", state.identity?.name);
  } else if (state.status === "identityMismatch") {
    console.warn("Identity changed while remote work is pending");
  }
});
```

## Programmatic identity control

### setAuthIdentity

Set the embedded identity directly. This updates the local runtime identity and
auth state but does not install or replace the remote token fetcher:

```ts
import { setAuthIdentity } from "@robelest/convex-embedded/browser";

await setAuthIdentity(client, {
  subject: "user-123",
  issuer: "https://my-auth.example.com",
  tokenIdentifier: "https://my-auth.example.com|user-123",
  name: "Alice",
  email: "alice@example.com",
});
```

### getAuthIdentity

Read the current embedded identity:

```ts
import { getAuthIdentity } from "@robelest/convex-embedded/browser";

const identity = getAuthIdentity(client);
// identity is UserIdentity | null
```

### logout

Clear the current identity without deleting local data. Pending remote state
remains persisted and identity-scoped:

```ts
import { logout } from "@robelest/convex-embedded/browser";

await logout(client);
```

### switchIdentity

Switch to a different user identity. If queued remote work exists for a
different identity, the auth state becomes `identityMismatch` instead of
silently replaying under the new identity:

```ts
import { switchIdentity } from "@robelest/convex-embedded/browser";

await switchIdentity(client, newUserIdentity);
```

## Cross-tab session remote

Auth state changes are automatically broadcast to other tabs sharing the same
database name via `SessionFanout` (uses `BroadcastChannel`). When one tab logs
in or out, other tabs refresh their auth state automatically.

## Example: Clerk integration

```ts
import { createConvexClient } from "@robelest/convex-embedded/browser";
import { useAuth } from "@clerk/clerk-react";

const { getToken, isSignedIn } = useAuth();

const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  remote: { url: import.meta.env.CONVEX_URL },
  auth: {
    fetchToken: async ({ forceRefreshToken }) => {
      const token = await getToken({
        template: "convex",
        skipCache: forceRefreshToken,
      });
      return token ?? null;
    },
    getUserIdentity: async () => {
      if (!isSignedIn) return null;
      // Return identity shape matching your Clerk JWT template
      return {
        subject: userId,
        issuer: "https://clerk.example.com",
        tokenIdentifier: `https://clerk.example.com|${userId}`,
        name: user?.fullName ?? undefined,
        email: user?.primaryEmailAddress?.emailAddress ?? undefined,
      };
    },
  },
});
```

## Example: Custom auth

```ts
const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  auth: {
    getUserIdentity: async () => {
      const session = getMyAppSession();
      if (!session) return null;
      return {
        subject: session.userId,
        issuer: "https://my-app.example.com",
        tokenIdentifier: `https://my-app.example.com|${session.userId}`,
        name: session.displayName,
      };
    },
  },
});
```
