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
- A **Vite-based bundler** (Vite, SvelteKit, Next.js with Turbopack, etc.) --
  the embedded runtime uses `import.meta.glob` for module discovery.
- **`convex` ^1.32.0** as a peer dependency.

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
Install it with:

```bash
npx convex component add @robelest/convex-embedded
```

This registers the component in your `convex.config.ts` and makes
`components.embedded` available in your generated API.

## Package Exports

`@robelest/convex-embedded` ships multiple entry points so you only import what
you need:

| Export                                    | Environment    | Description                                                                                                                     |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@robelest/convex-embedded/browser`       | Browser        | `createConvexClient` factory, `getRemoteState`, `subscribeRemoteState`, `getAuthState`, `subscribeAuthState`, preload utilities |
| `@robelest/convex-embedded/server`        | Convex backend | `embeddedTable`, `setup`, `remoteOnly`                                                                                          |
| `@robelest/convex-embedded/crdt`          | Convex backend | `schema` namespace (`register`, `prose`, `counter`, `set`, `omit`)                                                              |
| `@robelest/convex-embedded/worker`        | Web Worker     | wa-sqlite worker entry point                                                                                                    |
| `@robelest/convex-embedded/client`        | Browser        | Internal resolve engine (not part of the public API)                                                                            |
| `@robelest/convex-embedded/convex.config` | Convex         | Component configuration                                                                                                         |
| `@robelest/convex-embedded/test`          | Test           | Testing utilities                                                                                                               |

Most applications only need `browser`, `server`, and `crdt`.

## Next Steps

Continue to the [Quick Start](/getting-started/quick-start) to define your first
embedded table, set up server bindings, and create a client.
