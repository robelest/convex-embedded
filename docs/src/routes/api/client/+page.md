---
title: Client Internals
description: Internal resolve engine and remote protocol.
---

<svelte:head>

  <title>Client Internals - convex-embedded</title>
</svelte:head>

# Client Internals

The client internals (`@robelest/convex-embedded/crdt`) expose lower-level
utilities for working with Yjs documents in the CRDT remote pipeline. These are
primarily for **advanced use cases** where you need direct control over document
materialization, state vectors, or binary updates.

Most applications should use the higher-level [Browser API](/api/browser) and
[CRDT Schema](/api/crdt) instead.

```ts
import {
  materializeYjsDoc,
  createEmptyDoc,
  encodeStateVector,
  applyUpdate,
  encodeState,
} from "@robelest/convex-embedded/crdt";
```

---

## `materializeYjsDoc(schemaDef, doc)`

Materialize a `Y.Doc` back into a plain document record. This is the inverse of
`initYjsDoc`. Given a schema `Definition` and a Yjs document that was
initialized or updated via the CRDT pipeline, it reads each field's Yjs
structure and produces the corresponding plain-JavaScript value.

```ts
function materializeYjsDoc(
  schemaDef: Definition,
  doc: Y.Doc,
): Record<string, unknown>;
```

| Parameter   | Type         | Description                                                                 |
| ----------- | ------------ | --------------------------------------------------------------------------- |
| `schemaDef` | `Definition` | The schema definition (from `embeddedTable().schema` or `define()`).        |
| `doc`       | `Y.Doc`      | A Yjs document initialized via `initYjsDoc` or populated by remote updates. |

**Returns** a plain JavaScript object with materialized field values.

CRDT types are resolved as follows:

| CRDT Type    | Resolution                                                       |
| ------------ | ---------------------------------------------------------------- |
| **Prose**    | Extracted as plain text via `extractProseText`                   |
| **Register** | Latest-timestamp-wins (or custom resolver) via `resolveRegister` |
| **Counter**  | Sum of all deltas via `getCounterValue`                          |
| **Set**      | Array of member keys via `getSetMembers`                         |
| **Omitted**  | Skipped (not included in output)                                 |
| **Plain**    | Read directly from the `Y.Map`                                   |

Internal fields (`_id`, `_creationTime`) are **not** included in the output --
the caller must supply them separately.

---

## `createEmptyDoc()`

Create an empty `Y.Doc` with the top-level `Y.Map("fields")` initialized. Useful
for creating a new document structure before any data is written.

```ts
function createEmptyDoc(): Y.Doc;
```

**Returns** a new `Y.Doc` instance with an empty `"fields"` map.

---

## `encodeStateVector(doc)`

Encode the state vector of a `Y.Doc`. The state vector summarizes what the
document already contains. This is what the client sends to the server during
the resolve handshake to request only missing updates.

```ts
function encodeStateVector(doc: Y.Doc): Uint8Array;
```

| Parameter | Type    | Description                                       |
| --------- | ------- | ------------------------------------------------- |
| `doc`     | `Y.Doc` | The Yjs document to encode the state vector from. |

**Returns** a `Uint8Array` containing the encoded state vector.

---

## `applyUpdate(doc, update)`

Apply a binary update (diff) to a `Y.Doc`. This is what the client does after
receiving a resolve response from the server. Uses Yjs V2 encoding.

```ts
function applyUpdate(doc: Y.Doc, update: Uint8Array): void;
```

| Parameter | Type         | Description                                                                        |
| --------- | ------------ | ---------------------------------------------------------------------------------- |
| `doc`     | `Y.Doc`      | The Yjs document to apply the update to.                                           |
| `update`  | `Uint8Array` | A V2-encoded binary update (typically from `computeDiff` or the resolve response). |

---

## `encodeState(doc)`

Encode a `Y.Doc`'s full state as a V2 update. Used when pushing local changes to
the server.

```ts
function encodeState(doc: Y.Doc): Uint8Array;
```

| Parameter | Type    | Description                 |
| --------- | ------- | --------------------------- |
| `doc`     | `Y.Doc` | The Yjs document to encode. |

**Returns** a `Uint8Array` containing the full V2-encoded state.

---

## Sync Protocol Overview

These low-level helpers implement the following remote flow:

1. **Client** calls `encodeStateVector(localDoc)` and sends the vector to the
   server.
2. **Server** calls `computeDiff(serverUpdate, clientVector)` to produce the
   minimal diff.
3. **Server** checks `isDiffEmpty(diff)` -- if empty, the client is already up
   to date.
4. **Client** receives the diff and calls `applyUpdate(localDoc, diff)` to merge
   server changes.
5. **Client** calls `encodeState(localDoc)` when pushing local mutations to the
   server.
6. **Server** calls `mergeUpdate(serverUpdate, clientUpdate)` to incorporate
   client changes.

The `materializeYjsDoc` function is used at the end of remote to convert the
merged Yjs document back into a plain JavaScript record that can be stored in
the local embedded database.
