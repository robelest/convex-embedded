---
title: CRDT Schema
description: CRDT field descriptors for ready data.
---

<svelte:head>

  <title>CRDT Schema - convex-embedded</title>
</svelte:head>

# CRDT Schema

The CRDT entry point (`@robelest/convex-embedded/crdt`) provides field
constructors for defining ready data shapes and runtime helpers for reading CRDT
state from Yjs documents.

## Which field helper should I use?

| Field helper           | Use when                                     | Merge behavior               | Stored locally |
| ---------------------- | -------------------------------------------- | ---------------------------- | -------------- |
| `schema.register(v.*)` | one logical value can be edited concurrently | register conflict resolution | yes            |
| `schema.prose()`       | rich collaborative text                      | Yjs XML fragment merge       | yes            |
| `schema.counter()`     | additive changes matter more than overwrite  | summed increments            | yes            |
| `schema.set(v.*)`      | membership should be add-wins                | add-wins set                 | yes            |
| `schema.omit(v.*)`     | field must stay remote-only                  | omitted from embedded sync   | no             |
| plain `v.*`            | simple synced field                          | last-write-wins              | yes            |

## Common embedded shape

```ts
export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.prose(),
  votes: schema.counter(),
  tags: schema.set(v.string()),
  remoteAttachmentId: schema.omit(v.string()),
  done: v.boolean(),
});
```

The important distinction is:

- `schema.*` fields get special merge/omit behavior
- plain `v.*` fields still sync as part of the embedded table, but use simple
  last-write-wins semantics

Field constructors are used inside `embeddedTable()` shape definitions. Each
maps to a Yjs data structure that enables automatic conflict-free merging across
clients and offline sessions.

```ts
import {
  schema,
  getConflict,
  getCounterValue,
  getSetMembers,
  resolveRegister,
  extractProseText,
  materializeYjsDoc,
} from "@robelest/convex-embedded/crdt";
```

---

## Field Constructors

Use these inside `embeddedTable()` shape definitions to declare how each field
should participate in remote reconciliation.

```ts
import { schema } from "@robelest/convex-embedded/crdt";
import { embeddedTable } from "@robelest/convex-embedded/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.prose(),
  votes: schema.counter(),
  tags: schema.set(v.string()),
  secret: schema.omit(v.string()),
  done: v.boolean(), // plain validator = last-write-wins
});
```

### `schema.register(validator, options?)`

Multi-value register. Maps to `Y.Map<{ value, timestamp }>`. Concurrent writes
from different clients produce a conflict. By default, the value with the
highest timestamp wins. Provide a custom `resolve` callback to implement
different conflict resolution.

```ts
function register<T>(
  validator: Validator<T, any, any>,
  options?: RegisterOptions<T>,
): CrdtFieldDescriptor;
```

| Parameter         | Type                           | Description                                                                |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `validator`       | `Validator<T>`                 | Convex validator for the field value (e.g. `v.string()`).                  |
| `options.resolve` | `(conflict: Conflict<T>) => T` | Custom conflict resolver. Called when multiple clients wrote concurrently. |

#### `RegisterOptions<T>`

```ts
interface RegisterOptions<T> {
  resolve?: (conflict: Conflict<T>) => T;
}
```

#### `Conflict<T>`

```ts
interface Conflict<T> {
  values: T[];
  entries: ConflictEntry<T>[];
  latest(): T;
  byClient(id: string): T | undefined;
}
```

| Member         | Type                 | Description                                                      |
| -------------- | -------------------- | ---------------------------------------------------------------- |
| `values`       | `T[]`                | All concurrent values, unordered.                                |
| `entries`      | `ConflictEntry<T>[]` | Per-entry metadata including client ID and timestamp.            |
| `latest()`     | `T`                  | Returns the value with the highest timestamp (default resolver). |
| `byClient(id)` | `T \| undefined`     | Returns the value written by a specific client, if any.          |

#### `ConflictEntry<T>`

```ts
interface ConflictEntry<T> {
  value: T;
  clientId: string;
  timestamp: number;
}
```

#### Example with custom resolver

```ts
schema.register(v.string(), {
  resolve: (conflict) => {
    // Pick the longest string instead of latest timestamp
    return conflict.values.reduce((a, b) => (a.length >= b.length ? a : b));
  },
});
```

---

### `schema.prose()`

Rich text field. Maps to `Y.XmlFragment` for character-level CRDT merge. Use
with ProseMirror or TipTap bindings for collaborative editing.

```ts
function prose(): CrdtFieldDescriptor;
```

Serialized as a `v.string()` for Convex storage. The Yjs document manages the
structured content internally.

---

### `schema.counter()`

Counter field. Maps to `Y.Array<{ client, delta, timestamp }>`. An append-only
array of increments. The materialized value is the sum of all deltas.

```ts
function counter(): CrdtFieldDescriptor;
```

Uses `v.number()` as the underlying Convex validator.

---

### `schema.set(validator)`

Add-wins set. Maps to `Y.Map<{ addedBy, addedAt }>`. Key presence equals
membership. Deleting a key removes the member. Yjs add-wins semantics mean that
if one client adds and another concurrently removes, the add wins.

```ts
function set<T>(validator: Validator<T, any, any>): CrdtFieldDescriptor;
```

| Parameter   | Type           | Description                             |
| ----------- | -------------- | --------------------------------------- |
| `validator` | `Validator<T>` | Convex validator for set member values. |

---

### `schema.omit(validator)`

Marks a field as remote-only. It exists on the remote Convex backend but is
stripped from every payload sent to the local embedded runtime. Only needed on
embedded synced tables. Tables outside the embedded sync path already stay
remote-only by default.

Use this for:

- large remote-only metadata
- sensitive server-side ids
- fields the browser should never persist locally

```ts
function omit<T>(validator: Validator<T, any, any>): CrdtFieldDescriptor;
```

| Parameter   | Type           | Description                                                                 |
| ----------- | -------------- | --------------------------------------------------------------------------- |
| `validator` | `Validator<T>` | Convex validator for the field (still needed for remote schema validation). |

---

### `schema.define(options)` / `define(options)`

Creates a versioned schema `Definition`. This is called internally by
`embeddedTable()`, but can be used directly for advanced schema introspection.

```ts
function define(options: DefineOptions): Definition;
```

#### `DefineOptions`

```ts
interface DefineOptions {
  version: number;
  shape: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  migrate?: Record<number, LocalTableMigrationStep>;
}
```

| Field      | Type                                      | Default      | Description                                                          |
| ---------- | ----------------------------------------- | ------------ | -------------------------------------------------------------------- |
| `version`  | `number`                                  | **required** | Current schema version number.                                       |
| `shape`    | `Record<string, unknown>`                 | **required** | Current field shape (mix of CRDT descriptors and plain validators).  |
| `defaults` | `Record<string, unknown>`                 | `{}`         | Default values for additive changes.                                 |
| `migrate`  | `Record<number, LocalTableMigrationStep>` | `{}`         | Forward-only local document migration steps keyed by target version. |

#### `Definition`

```ts
interface Definition {
  version: number;
  shape: Record<string, unknown>;
  defaults: Record<string, unknown>;
  migrate: Record<number, LocalTableMigrationStep>;
  getShape(): Record<string, unknown>;
  getCrdtFields(): Map<string, CrdtFieldDescriptor>;
  getOmittedFields(): string[];
}
```

| Member               | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `migrate`            | Forward-only local table migration steps keyed by target version number. |
| `getShape()`         | Get the current field shape.                                             |
| `getCrdtFields()`    | Get all CRDT field names and their descriptors for the current version.  |
| `getOmittedFields()` | Get field names that should be omitted from local remote.                |

---

## Runtime Read Helpers

These functions read CRDT state from Yjs documents. Use them to extract
materialized values from documents managed by the remote engine.

### `getConflict(doc, fieldName)`

Check if a register field has a conflict (multiple concurrent values). Returns
the `Conflict` object if there are multiple entries, `null` otherwise.

```ts
function getConflict<T>(doc: Y.Doc, fieldName: string): Conflict<T> | null;
```

### `getCounterValue(doc, fieldName)`

Get the materialized value of a counter field (sum of all deltas). Returns `0`
if the field does not exist or is empty.

```ts
function getCounterValue(doc: Y.Doc, fieldName: string): number;
```

### `getSetMembers(doc, fieldName)`

Get all members of an add-wins set field. Returns an empty array if the field
does not exist.

```ts
function getSetMembers<T = string>(doc: Y.Doc, fieldName: string): T[];
```

### `resolveRegister(doc, fieldName, resolver?)`

Resolve a register field's value. Uses the custom resolver if provided, or falls
back to latest-timestamp-wins. Returns `undefined` if the field has no entries.

```ts
function resolveRegister<T>(
  doc: Y.Doc,
  fieldName: string,
  resolver?: (conflict: Conflict<T>) => T,
): T | undefined;
```

### `extractProseText(doc, fieldName)`

Extract plain text content from a Yjs document's prose field. Returns the text
content of the `Y.XmlFragment`.

```ts
function extractProseText(doc: Y.Doc, fieldName: string): string;
```

---

## Yjs Helpers

Low-level functions for working with Yjs documents and the CRDT remote protocol.

### `initYjsDoc(schemaDef, row)`

Initialize a `Y.Doc` from a document row according to the schema definition.
Creates the top-level `Y.Map("fields")` and populates each field with the
appropriate Yjs structure.

```ts
function initYjsDoc(schemaDef: Definition, row: Record<string, unknown>): Y.Doc;
```

### `encodeDocumentState(schemaDef, row)`

Encode a document row as a full Yjs state snapshot (V2 encoding).

```ts
function encodeDocumentState(
  schemaDef: Definition,
  row: Record<string, unknown>,
): Uint8Array;
```

### `computeDiff(serverUpdate, clientVector)`

Compute the diff between a server document and a client's state vector. Returns
the minimal binary update needed to bring the client up to date.

```ts
function computeDiff(
  serverUpdate: Uint8Array,
  clientVector: Uint8Array,
): Uint8Array;
```

### `mergeUpdate(serverUpdate, clientUpdate)`

Merge a client's update into the server document and return the merged state.

```ts
function mergeUpdate(
  serverUpdate: Uint8Array,
  clientUpdate: Uint8Array,
): Uint8Array;
```

### `isDiffEmpty(diff)`

Check if a diff is effectively empty (client is already up to date). Yjs V2
empty updates are exactly 13 bytes.

```ts
function isDiffEmpty(diff: Uint8Array): boolean;
```

---

## Type Guards

### `isCrdtField(value)`

Check if a value is a CRDT field descriptor (created by `schema.register()`,
`schema.prose()`, etc.).

```ts
function isCrdtField(value: unknown): value is CrdtFieldDescriptor;
```

### `getCrdtType(field)`

Extract the CRDT type from a field descriptor. Returns `null` if the value is
not a CRDT field.

```ts
function getCrdtType(field: unknown): CrdtType | null;
```

### `CrdtType`

```ts
const CrdtType = {
  Prose: "prose",
  Register: "register",
  Counter: "counter",
  Set: "set",
  Plain: "plain",
  Omitted: "omitted",
} as const;

type CrdtType = (typeof CrdtType)[keyof typeof CrdtType];
```
