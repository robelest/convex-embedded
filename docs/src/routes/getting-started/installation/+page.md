---
title: Installation
description: Install and configure @robelest/convex-embedded in your project.
---

<script>
  import Tabs from '$lib/components/docs/Tabs.svelte';
  import TabItem from '$lib/components/docs/TabItem.svelte';
</script>

<svelte:head>

  <title>Installation - convex-embedded</title>
</svelte:head>

# Installation

## Prerequisites

Before installing, make sure you have:

- An existing **Convex project** (run `npx convex init` if you do not have one).
- **`convex` ^1.34.1** as a peer dependency.

## 1. Install the Package

`@robelest/convex-embedded` depends on the standalone `@robelest/fx` package
internally. You do not need to install `@robelest/fx` separately unless you are
also using its lower-level APIs directly in your own code.

<Tabs>
  <TabItem label="npm">

```bash
npm install @robelest/convex-embedded
```

  </TabItem>
  <TabItem label="pnpm">

```bash
pnpm add @robelest/convex-embedded
```

  </TabItem>
  <TabItem label="bun">

```bash
bun add @robelest/convex-embedded
```

  </TabItem>
</Tabs>

## 2. Install the Convex Component

The CRDT remote engine uses a Convex component for server-side delta storage.
Register it in `convex/convex.config.ts`:

```ts
// convex/convex.config.ts
import embedded from "@robelest/convex-embedded/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(embedded);

export default app;
```

After running `npx convex dev` or `npx convex codegen`, this makes
`components.embedded` available in your generated API.

## Package Exports

`@robelest/convex-embedded` ships multiple entry points so you only import what
you need:

| Export                                    | Environment     | Description                                                                                                                     |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@robelest/convex-embedded/browser`       | Browser         | `createConvexClient` factory, `getRemoteState`, `subscribeRemoteState`, `getAuthState`, `subscribeAuthState`, preload utilities |
| `@robelest/convex-embedded/react`         | React           | `createConvexReactClient` and React-compatible wrapping for `ConvexProvider`, `useQuery`, and `usePaginatedQuery`               |
| `@robelest/convex-embedded/server`        | Convex backend  | `embeddedTable`, `setup`, `localOnly`, `remoteOnly`                                                                             |
| `@robelest/convex-embedded/crdt`          | Convex backend  | `schema` namespace (`register`, `prose`, `counter`, `set`, `omit`)                                                              |
| `@robelest/convex-embedded/client`        | Advanced client | Replica/bootstrap helpers such as `createReplica`                                                                               |
| `@robelest/convex-embedded/convex.config` | Convex          | Component configuration                                                                                                         |
| `@robelest/convex-embedded/test`          | Test            | Testing utilities                                                                                                               |

Most applications only need `browser`, `server`, and `crdt`. Use `react` for
React hook compatibility, and reach for `client` when you need SSR/bootstrap
helpers such as `createReplica`.

## Next Steps

Continue to the [Quick Start](/getting-started/quick-start) to define your first
embedded table, set up server bindings, and create a client.
