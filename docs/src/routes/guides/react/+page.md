---
title: React Integration
description: Using convex-embedded with React and ConvexProvider.
---

<svelte:head>

  <title>React Integration - convex-embedded</title>
</svelte:head>

# React Integration

For React, use `@robelest/convex-embedded/react`. It creates a
`ConvexReactClient`-compatible wrapper on top of the embedded browser client, so
you can use `ConvexProvider`, `useQuery`, `useMutation`, and `usePaginatedQuery`
normally.

## Quick start

### 1. Create the client

Create the embedded React client at module scope (outside any component) so it
is instantiated once:

```ts
// src/convex-client.ts
import { createConvexReactClient } from "@robelest/convex-embedded/react";
import { modules } from "./convex-modules";

export const client = createConvexReactClient({
  modules,
  name: "my-app",
  remote: { url: import.meta.env.CONVEX_URL },
});
```

If you only need a local-only database with no remote, omit the `remote` option:

```ts
export const client = createConvexReactClient({
  modules,
});
```

### 2. Provide the client

Wrap your application with `ConvexProvider` from `convex/react`, passing the
embedded client directly:

```tsx
// src/App.tsx
import { ConvexProvider } from "convex/react";
import { client } from "./convex-client";

function App() {
  return (
    <ConvexProvider client={client}>
      <MyApp />
    </ConvexProvider>
  );
}

export default App;
```

### 3. Use hooks as normal

Inside any component under the provider, `useQuery` and `useMutation` work
exactly the same as with a regular Convex deployment:

```tsx
// src/components/TaskList.tsx
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

export function TaskList() {
  const tasks = useQuery(api.tasks.list);
  const createTask = useMutation(api.tasks.create);

  return (
    <div>
      <button onClick={() => createTask({ title: "New task" })}>
        Add Task
      </button>
      <ul>
        {tasks?.map((task) => (
          <li key={task._id}>{task.title}</li>
        ))}
      </ul>
    </div>
  );
}
```

Mutations write to the local embedded database instantly. When `remote` is
configured, replay / resolve / subscriptions happen behind the same standard
client.

## Recommended module registry shape

Use canonical module ids, not shorthand names:

```ts
// src/convex-modules.ts
import type { ConvexModuleRegistry } from "@robelest/convex-embedded/browser";

export const modules = {
  "./convex/tasks.ts": () => import("../convex/tasks"),
  "./convex/schema.ts": () => import("../convex/schema"),
  "./convex/_generated/api.ts": () => import("../convex/_generated/api"),
  "./convex/_generated/server.ts": () => import("../convex/_generated/server"),
} satisfies ConvexModuleRegistry;
```

## Common options

```ts
const client = createConvexReactClient({
  modules,
  schema,
  name: "my-app",
  remote: { url: import.meta.env.CONVEX_URL },
  auth: {
    fetchToken: myTokenFetcher,
    getUserIdentity: myIdentitySource,
  },
  encryption: myEncryptionHooks,
});
```

## Lifecycle and cleanup

The embedded client spawns a wa-sqlite worker and (when remote is enabled) opens
a WebSocket connection. Always clean up by calling `client.close()` when the
client is no longer needed.

If the client is created at module scope, you typically do not need explicit
cleanup since it lives for the lifetime of the page. If you create the client
inside a component, use `useEffect`:

```tsx
import { useEffect, useState } from "react";
import { ConvexProvider } from "convex/react";
import { createConvexReactClient } from "@robelest/convex-embedded/react";
import { modules } from "./convex-modules";

function EmbeddedProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() =>
    createConvexReactClient({
      modules,
      remote: { url: import.meta.env.CONVEX_URL },
    }),
  );

  useEffect(() => {
    return () => {
      client.close();
    };
  }, [client]);

  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
```

## Sync status hook

You can subscribe to the remote engine state using `subscribeRemoteState`:

```tsx
import { useEffect, useState } from "react";
import {
  subscribeRemoteState,
  type RemoteState,
} from "@robelest/convex-embedded/react";
import type { ConvexReactClient } from "convex/react";

function useRemoteStatus(client: ConvexReactClient) {
  const [status, setStatus] = useState<RemoteState["status"]>("idle");

  useEffect(() => {
    return subscribeRemoteState(client, (s) => setStatus(s.status));
  }, [client]);

  return status;
}
```

## SSR considerations

The generic browser entry remains framework agnostic and returns a plain
`ConvexClient`. For React hooks, use `@robelest/convex-embedded/react`.

convex-embedded requires browser APIs (IndexedDB, WebAssembly, Worker). If you
are using a framework with server-side rendering (Next.js, Remix, etc.), you
must ensure the client is only created in the browser:

```ts
const client =
  typeof window !== "undefined"
    ? createConvexReactClient({
        modules,
        remote: { url: import.meta.env.CONVEX_URL },
      })
    : null;
```

Imports are now SSR-safe, so the React entry can be imported on the server. Only
`createConvexReactClient(...)` remains browser-only. For server-rendered
startup, run the query in your loader with `preloadQuery(...)` from
`@robelest/convex-embedded/client`, pass the `Preloaded` payload to a client
component, and render it through a small `usePreloadedQuery` hook you build from
`preloadedQueryResult` + `preloadedQueryRef`, `whenPreloaded` (from
`@robelest/convex-embedded/browser`), and React's `useQuery`.

## What happens after setup

After the client is created:

- local queries read from the embedded runtime
- local mutations commit instantly
- cross-tab updates flow through the browser write/session broadcasts
- when remote is enabled, replay ownership and resolve stay in the shared core
  engine rather than React-specific code

## Complete example

```tsx
// src/App.tsx
import { ConvexProvider } from "convex/react";
import { useQuery, useMutation } from "convex/react";
import {
  createConvexReactClient,
  subscribeRemoteState,
} from "@robelest/convex-embedded/react";
import type { RemoteState } from "@robelest/convex-embedded/react";
import { api } from "./convex/_generated/api";
import { modules } from "./convex-modules";
import { useEffect, useState } from "react";

const client = createConvexReactClient({
  modules,
  remote: { url: import.meta.env.CONVEX_URL },
});

function SyncBadge() {
  const [state, setState] = useState<RemoteState>({ status: "idle" });

  useEffect(() => {
    return subscribeRemoteState(client, setState);
  }, []);

  const labels: Record<string, string> = {
    idle: "Local only",
    connecting: "Connecting...",
    resolving: "Resolving...",
    resolved: "Resolved",
    offline: "Offline",
    error: "Sync error",
  };

  return <span>{labels[state.status] ?? state.status}</span>;
}

function TaskList() {
  const tasks = useQuery(api.tasks.list);
  const createTask = useMutation(api.tasks.create);
  const removeTask = useMutation(api.tasks.remove);

  return (
    <div>
      <SyncBadge />
      <button onClick={() => createTask({ title: "New task" })}>Add</button>
      <ul>
        {tasks?.map((task) => (
          <li key={task._id}>
            {task.title}
            <button onClick={() => removeTask({ id: task._id })}>Remove</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function App() {
  return (
    <ConvexProvider client={client}>
      <TaskList />
    </ConvexProvider>
  );
}
```
