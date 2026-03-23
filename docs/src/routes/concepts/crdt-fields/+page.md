---
title: CRDT Fields
description:
  Declarative CRDT field types that map to Yjs data structures for automatic
  conflict resolution.
---

<svelte:head>

  <title>CRDT Fields - convex-embedded</title>
</svelte:head>

# CRDT Fields

When you declare a table with `embeddedTable()`, each field can be either a
plain Convex validator (last-write-wins) or a CRDT field descriptor from the
`schema` namespace. CRDT fields map to [Yjs](https://yjs.dev/) data structures
under the hood, giving you fine-grained conflict resolution when multiple
clients (or tabs) edit the same document concurrently.

```ts
import { schema } from "@robelest/convex-embedded/crdt";
import { embeddedTable } from "@robelest/convex-embedded/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()), // CRDT register
  body: schema.prose(), // CRDT prose (rich text)
  count: schema.counter(), // CRDT counter
  tags: schema.set(v.string()), // CRDT add-wins set
  done: v.boolean(), // plain field (last-write-wins)
  metadata: schema.omit(v.any()), // remote-only, stripped from local
});
```

## Register

**What it is**: A multi-value register backed by a `Y.Map`. Each concurrent
write is stored with its client ID and timestamp. When conflicts exist, a
resolver picks the winner.

**When to use it**: For scalar fields (strings, numbers, booleans) where you
want automatic conflict resolution instead of silent last-write-wins.

**Yjs structure**: `Y.Map<{ value: T, timestamp: number }>` keyed by client ID.

**Materialized value**: The winning value after conflict resolution. By default,
the value with the highest timestamp wins (LWW). You can provide a custom
resolver.

```ts
import { schema } from "@robelest/convex-embedded/crdt";
import { v } from "convex/values";

// Default: latest-timestamp-wins
title: schema.register(v.string()),

// Custom conflict resolution
priority: schema.register(v.number(), {
  resolve: (conflict) => {
    // Always pick the highest priority value
    return Math.max(...conflict.values);
  },
}),
```

The `conflict` object provides:

| Property       | Type                 | Description                                                   |
| -------------- | -------------------- | ------------------------------------------------------------- |
| `values`       | `T[]`                | All concurrent values, unordered.                             |
| `entries`      | `ConflictEntry<T>[]` | Per-entry metadata with `value`, `clientId`, and `timestamp`. |
| `latest()`     | `T`                  | Returns the value with the highest timestamp.                 |
| `byClient(id)` | `T \| undefined`     | Returns the value written by a specific client.               |

## Prose

**What it is**: A rich text field backed by a `Y.XmlFragment`. Supports
character-level CRDT merging for collaborative text editing.

**When to use it**: For text content that multiple users might edit
simultaneously -- document bodies, comments, notes. Works with ProseMirror,
TipTap, and other editors that support Yjs bindings.

**Yjs structure**: `Y.XmlFragment` on the document, keyed by the field name.

**Materialized value**: A plain `string`. The Convex validator is `v.string()`.
When initializing, the string content is wrapped in a `Y.XmlText` node and
inserted into the fragment.

```ts
import { schema } from "@robelest/convex-embedded/crdt";

body: schema.prose(),
```

Prose fields are serialized as strings for Convex storage. The Yjs XmlFragment
structure is used only for merge computation during the CRDT resolve pass.

## Counter

**What it is**: An append-only counter backed by a `Y.Array` of increment
entries. Each entry records the client ID, delta, and timestamp.

**When to use it**: For values that should be summed across clients rather than
overwritten -- vote counts, view counters, inventory adjustments.

**Yjs structure**:
`Y.Array<{ client: string, delta: number, timestamp: number }>`.

**Materialized value**: A `number` equal to the sum of all deltas. The Convex
validator is `v.number()`.

```ts
import { schema } from "@robelest/convex-embedded/crdt";

votes: schema.counter(),
```

To increment a counter, simply write the new total value in your mutation. The
CRDT layer computes the delta between the old and new values during remote.

## Set

**What it is**: An add-wins set backed by a `Y.Map`. Key presence indicates
membership. Deleting a key removes the element. Yjs add-wins semantics mean that
if one client adds an element while another removes it concurrently, the add
wins.

**When to use it**: For collections of unique values where concurrent adds
should not be lost -- tags, labels, participant lists.

**Yjs structure**: `Y.Map<{ addedBy: string, addedAt: number }>` where each key
is a serialized member.

**Materialized value**: An array. The Convex validator is the validator you pass
to `schema.set()`.

```ts
import { schema } from "@robelest/convex-embedded/crdt";
import { v } from "convex/values";

tags: schema.set(v.string()),
```

Members are serialized as strings for use as Y.Map keys. Objects are
JSON-stringified.

## Omit

**What it is**: A marker that a field exists only on the remote Convex backend.
The field is stripped from every payload sent to the local embedded runtime.

**When to use it**: For fields that should not be ready to the client -- large
blobs, server-computed values, sensitive data, or fields only needed for
server-side queries.

**Yjs structure**: None. Omitted fields are excluded from the Yjs document
entirely.

**Materialized value**: The field does not exist in the local embedded database.
It has whatever value the remote Convex backend stores.

```ts
import { schema } from "@robelest/convex-embedded/crdt";
import { v } from "convex/values";

// This field only exists on the remote backend
embedding: schema.omit(v.array(v.float64())),
```

Omit is only meaningful on tables declared with `embeddedTable()`. Tables not
registered for remote are never sent to the local runtime in the first place.

## How CRDT Fields Work in Practice

When you write a mutation with `tasks.mutation()`, the handler writes plain
values to `ctx.db` as usual. On the remote Convex backend, after the handler
runs:

1. The mutation wrapper reads the committed document.
2. It encodes the document into a Yjs state snapshot using the schema
   definition.
3. The snapshot is stored as a binary delta via the `embedded` component's
   `insertDelta` mutation.

On reconnect, the client sends its local Yjs state vectors. The server computes
diffs against its stored deltas. The client applies the diffs, materializes the
merged Yjs documents back to plain records, and ingests them into the embedded
database.

All of this happens automatically. Your mutation handlers just read and write
plain values.
