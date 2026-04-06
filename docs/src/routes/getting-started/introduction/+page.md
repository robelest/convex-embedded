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

`@robelest/convex-embedded` is an embedded Convex runtime for browser and Expo
clients. It executes Convex queries, mutations, and actions locally against an
embedded SQLite-backed database, giving your app instant reads, instant writes,
and offline-capable behavior.

When remote is enabled, the embedded runtime becomes a **local-first** engine:
mutations write locally first and replay to the remote Convex deployment in the
background. A Yjs CRDT resolve pass automatically merges any state that diverged
while offline.

The current architecture is explicitly layered:

- core replay / resolve correctness lives in shared runtime code
- browser-only concerns like worker bootstrapping and `BroadcastChannel`
  transport stay behind platform adapters
- route overrides (`localOnly()` / `remoteOnly()`) define alpha-safe execution
  boundaries

`convex-embedded` builds on
[`@robelest/fx`](https://www.npmjs.com/package/@robelest/fx) for its internal
effect system. `@robelest/fx` now lives in its own repository, so
`convex-embedded` consumes it as a normal published dependency rather than as an
in-repo workspace package.

## Key Features

<CardGrid>
  <Card title="Standard Convex Client">
    The browser entry returns a standard ConvexClient. Use it directly or through framework adapters such as convex-svelte. For React hooks, use `@robelest/convex-embedded/react`.
  </Card>
  <Card title="Offline-First">
    Reads and writes work instantly with no network. Mutations queue locally and replay to the remote deployment when connectivity returns. The CRDT resolve engine merges divergent state automatically.
  </Card>
  <Card title="CRDT Fields">
    Declarative field types -- register, prose, counter, set, and omit -- map to Yjs data structures for fine-grained conflict resolution. Rich text fields merge at the character level.
  </Card>
  <Card title="Cross-Tab Sync">
    Tabs sharing the same database name receive write and session notifications across contexts, while replay ownership stays in core via processor-scoped leases.
  </Card>
  <Card title="Persistent Storage">
    Documents persist to IndexedDB via wa-sqlite running in a Dedicated Worker. Data survives page refreshes and browser restarts.
  </Card>
  <Card title="Framework Agnostic">
    The browser entry stays framework agnostic. The core SSR/bootstrap flow is driven by `createReplica`, `createEmbeddedRuntime`, and `createConvexClient` rather than a framework-specific wrapper.
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

## Next Steps

Head to the [Installation](/getting-started/installation) page to add
`@robelest/convex-embedded` to your project, or jump straight to the
[Quick Start](/getting-started/quick-start) for a step-by-step walkthrough.
