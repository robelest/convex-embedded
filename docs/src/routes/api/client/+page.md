---
title: Client API
 description: Server-side helpers for preloading queries during SSR.
---

<svelte:head>

  <title>Client API - convex-embedded</title>
</svelte:head>

# Client API

The client entry point (`@robelest/convex-embedded/client`) is the SSR surface
for convex-embedded. Most applications should still start with
[Browser API](/api/browser), but this module exposes the `preloadQuery(...)`
helpers used to run a query on the server and hand the result to a client
component for first paint.

```ts
import {
  preloadQuery,
  emptyPreloaded,
  preloadedQueryResult,
  preloadedQueryRef,
  type Preloaded,
  type PreloadQueryOptions,
} from "@robelest/convex-embedded/client";
```

## What this entry point is for

Use this module if you are:

- running a query on the server before first render with `preloadQuery(...)`
- passing the result through a loader into a client component
- falling back to `emptyPreloaded(...)` when there is no remote URL or the
  preload fails

For typical app code, start with the browser or Expo entry points.

## Main exports

### `preloadQuery`

Runs a query on the server against your remote Convex deployment and returns an
opaque `Preloaded` payload to pass into a client component.

```ts
function preloadQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
  options: PreloadQueryOptions,
): Promise<Preloaded<Query>>;
```

Use it when you want server-rendered HTML that matches the first browser render.
It is for non-paginated queries only; paginated queries load client-side,
matching Convex.

Typical SSR loader (e.g. SvelteKit `+layout.server.ts`, a Next loader):

```ts
import { preloadQuery, emptyPreloaded } from "@robelest/convex-embedded/client";
import { api } from "$convex/_generated/api";

export const load = async () => {
  let preloadedProjects = emptyPreloaded(api.projects.list, {});
  if (convexUrl) {
    preloadedProjects = await preloadQuery(
      api.projects.list,
      {},
      { url: convexUrl, token },
    );
  }
  return { preloadedProjects };
};
```

The returned `Preloaded` payload should be treated as opaque app data. Read its
server value with `preloadedQueryResult(...)` and decode the live query to run
locally with `preloadedQueryRef(...)`.

### `emptyPreloaded`

Builds a typed `Preloaded` payload with no server value. Its decoded value is
`null` until the live query yields. Use it when there is no remote URL or the
preload failed.

```ts
const fallback = emptyPreloaded(api.projects.list, {});
```

### `preloadedQueryResult`

Reads the server-fetched value out of a `Preloaded` payload. Works on the server
or in the browser.

```ts
function preloadedQueryResult<Query extends FunctionReference<"query">>(
  preloaded: Preloaded<Query>,
): FunctionReturnType<Query>;
```

### `preloadedQueryRef`

Decodes the query name and args from a `Preloaded` payload so you can run the
live local query in the browser.

```ts
function preloadedQueryRef<Query extends FunctionReference<"query">>(
  preloaded: Preloaded<Query>,
): { name: string; args: Record<string, unknown> };
```

### `Preloaded<Query>`

The serializable artifact returned by `preloadQuery(...)` and `emptyPreloaded`.
It carries the server-fetched value (if any) plus the encoded query reference
and args, and is passed straight from a loader into a client component.

### `PreloadQueryOptions`

The options object for `preloadQuery(...)`:

- `url`: remote Convex deployment URL
- `token`: optional auth token for authenticated reads

## Client handoff

Render `preloadedQueryResult(preloaded)` for SSR and first paint, then defer to
the live local query (your framework's `useQuery` on
`preloadedQueryRef(preloaded)`) once the preloaded scope has resolved from
remote. The [`whenPreloaded`](/api/browser) helper in
`@robelest/convex-embedded/browser` signals when that swap is safe, avoiding a
flash of stale local data. There is no SDK `usePreloadedQuery` hook; it is small
app-side glue you write from these primitives (the convex-svelte demo ships
one).

## Stability note

The `preloadQuery(...)` helpers are the supported SSR API exposed from this
module. For runtime startup, queries, mutations, auth, and remote sync, use the
browser or Expo entry points.
