---
title: React Integration
description: Using convex-embedded with React and ConvexProvider.
---

<svelte:head>

  <title>React Integration - convex-embedded</title>
</svelte:head>

# React Integration

convex-embedded returns a standard `ConvexClient` from the Convex SDK. This
means you can use it with `ConvexProvider`, `useQuery`, `useMutation`, and every
other React hook from `convex/react` without any wrapper or adapter.

## Quick start

### 1. Create the client

Create the embedded client at module scope (outside any component) so it is
instantiated once:

```ts
// src/convex-client.ts
import { createConvexClient } from "@robelest/convex-embedded/browser";

export const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
  remote: { url: import.meta.env.CONVEX_URL },
});
```

If you only need a local-only database with no remote, omit the `remote` option:

```ts
export const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
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
configured, they are also replayed to the remote Convex deployment in the
background.

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
import { createConvexClient } from "@robelest/convex-embedded/browser";

function EmbeddedProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() =>
    createConvexClient({
      modules: import.meta.glob("./convex/*.ts"),
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
} from "@robelest/convex-embedded/browser";
import type { ConvexClient } from "convex/browser";

function useRemoteStatus(client: ConvexClient) {
  const [status, setStatus] = useState<RemoteState["status"]>("idle");

  useEffect(() => {
    return subscribeRemoteState(client, (s) => setStatus(s.status));
  }, [client]);

  return status;
}
```

## SSR considerations

convex-embedded requires browser APIs (IndexedDB, WebAssembly, Worker). If you
are using a framework with server-side rendering (Next.js, Remix, etc.), you
must ensure the client is only created in the browser:

```ts
const client =
  typeof window !== "undefined"
    ? createConvexClient({
        modules: import.meta.glob("./convex/*.ts"),
        remote: { url: import.meta.env.CONVEX_URL },
      })
    : null;
```

Or use dynamic imports / lazy initialization in a `useEffect` to avoid importing
the module on the server at all.

## Complete example

```tsx
// src/App.tsx
import { ConvexProvider } from "convex/react";
import { useQuery, useMutation } from "convex/react";
import {
  createConvexClient,
  subscribeRemoteState,
} from "@robelest/convex-embedded/browser";
import type { RemoteState } from "@robelest/convex-embedded/browser";
import { api } from "./convex/_generated/api";
import { useEffect, useState } from "react";

const client = createConvexClient({
  modules: import.meta.glob("./convex/*.ts"),
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
    ready: "Ready",
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
