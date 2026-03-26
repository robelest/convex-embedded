---
title: Introduction
description:
  An overview of convex-embedded — an in-browser Convex runtime with
  offline-first remote for local-first applications.
---

<script>
  import Card from '$lib/components/docs/Card.svelte';
  import CardGrid from '$lib/components/docs/CardGrid.svelte';
</script>

<svelte:head>

  <title>Introduction - convex-embedded</title>
</svelte:head>

# Introduction

`@robelest/convex-embedded` is an embedded Convex runtime that runs entirely in
the browser. It executes your existing Convex query and mutation functions
locally against an in-browser SQLite database, giving your app instant reads,
instant writes, and full offline support -- all without changing a single line
of your Convex function code.

When remote is enabled, the embedded runtime becomes a **local-first** engine:
mutations write locally first and replay to the remote Convex deployment in the
background. A Yjs CRDT resolve pass automatically merges any state that diverged
while offline.

`convex-embedded` builds on
[`@robelest/fx`](https://www.npmjs.com/package/@robelest/fx) for its internal
effect system. `@robelest/fx` now lives in its own repository, so
`convex-embedded` consumes it as a normal published dependency rather than as an
in-repo workspace package.

## Key Features

<CardGrid>
  <Card title="Zero Code Changes">
    Your existing Convex queries and mutations run unmodified in the browser. The returned ConvexClient works with ConvexProvider, convex-svelte, and every Convex framework integration.
  </Card>
  <Card title="Offline-First">
    Reads and writes work instantly with no network. Mutations queue locally and replay to the remote deployment when connectivity returns. The CRDT resolve engine merges divergent state automatically.
  </Card>
  <Card title="CRDT Fields">
    Declarative field types -- register, prose, counter, set, and omit -- map to Yjs data structures for fine-grained conflict resolution. Rich text fields merge at the character level.
  </Card>
  <Card title="Cross-Tab Sync">
    Tabs sharing the same IndexedDB database name receive instant updates via BroadcastChannel. Write in one tab, see the result in all others -- no server round-trip required.
  </Card>
  <Card title="Persistent Storage">
    Documents persist to IndexedDB via wa-sqlite running in a Dedicated Worker. Data survives page refreshes and browser restarts.
  </Card>
  <Card title="Framework Agnostic">
    Works with React, Svelte, Vue, or any framework that integrates with the standard Convex ConvexClient. No framework-specific wrapper needed.
  </Card>
</CardGrid>

## When to Use It

`convex-embedded` is a good fit when you need:

- **Local-first applications** -- users expect instant interactions with no
  loading spinners, even on slow or unreliable networks.
- **Offline support** -- the app must remain fully functional without a network
  connection (field workers, mobile apps, airplane mode).
- **Collaborative editing** -- multiple users (or multiple tabs) edit the same
  data concurrently and expect automatic conflict resolution.
- **Reduced latency** -- reads and writes resolve in microseconds against the
  local database instead of a network round-trip.

It is **not** the right choice when:

- You need server-authoritative validation that cannot be replicated client-side
  (e.g., payment processing, access control that must be enforced server-side).
- Your dataset is too large to fit in the browser's IndexedDB quota.
- You do not use a Vite-based bundler (the module discovery relies on
  `import.meta.glob`).

## Next Steps

Head to the [Installation](/getting-started/installation) page to add
`@robelest/convex-embedded` to your project, or jump straight to the
[Quick Start](/getting-started/quick-start) for a step-by-step walkthrough.
