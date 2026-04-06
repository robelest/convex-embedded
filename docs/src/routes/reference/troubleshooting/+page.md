---
title: Troubleshooting
description: Common issues and solutions when working with convex-embedded.
---

<svelte:head>

  <title>Troubleshooting - convex-embedded</title>
</svelte:head>

# Troubleshooting

This page covers common issues you may encounter when using convex-embedded and
how to resolve them.

## "Cannot use server functions in browser"

**Problem**: Convex SDK guards against importing server functions in the browser
to prevent accidental secret leakage.

**Solution**: This is handled automatically by convex-embedded when the client
is created. The embedded runtime intentionally runs Convex functions
client-side, so the library enables Convex's browser import flag before the
runtime starts.

If you see this error, it means your Convex function modules are being imported
before `createConvexClient(...)` is called.

## SSR errors

**Problem**: Errors like `ReferenceError: indexedDB is not defined`,
`Worker is not defined`, or `WebAssembly is not defined` during server-side
rendering.

**Solution**: Imports from `@robelest/convex-embedded/browser` are SSR-safe, but
creating the browser client still requires browser APIs that do not exist in
Node.js.

If you want a client-only app, disable SSR:

**SvelteKit**:

```ts
// src/routes/+layout.ts
export const ssr = false;
export const prerender = false;
```

**Next.js / React frameworks**:

```ts
// Guard client creation
const client =
  typeof window !== "undefined"
    ? createConvexClient({ modules, remote: { url } })
    : null;
```

If you want SSR for the first route instead, build a replica on the server with
`createReplica(...)`, render with `createEmbeddedRuntime({ replica })`, and only
call `createConvexClient(...)` in the browser.

## Module registry

**Problem**: No Convex functions are found, or the runtime fails to load
modules.

**Solution**: The `modules` option must be a lazy ESM registry whose keys are
canonical module ids and whose values are `() => Promise<Module>` loaders:

```ts
// Correct -- lazy ESM registry
const modules = {
  "./convex/tasks.ts": () => import("./convex/tasks"),
  "./convex/users.ts": () => import("./convex/users"),
};
```

Each entry in the map must be a `() => Promise<Module>` function. The embedded
runtime loads modules on demand during function execution and scans for
`remote metadata` exports during remote setup.

Also verify the keys match your Convex module ids:

```ts
const modules = {
  "./convex/tasks.ts": () => import("./convex/tasks"),
  "./convex/users.ts": () => import("./convex/users"),
  "./convex/lib/helpers.ts": () => import("./convex/lib/helpers"),
};
```

## Worker URL resolution

**Problem**: The wa-sqlite worker fails to load, with errors like
`wa-sqlite worker failed to load` or `wa-sqlite worker RPC timed out`.

**Solution**: In most setups the worker URL resolves automatically. The worker
is loaded as a `{ type: "module" }` Worker from a URL relative to the package:

```ts
new Worker(workerUrl, { type: "module" });
```

If your build pipeline moves worker scripts to a different location, override
the `workerUrl` option:

```ts
const client = createConvexClient({
  modules,
  workerUrl: new URL("./path/to/worker.js", import.meta.url),
});
```

The worker RPC has a default timeout of 15 seconds. If initialization takes
longer (slow device, large database), you may see timeout errors on first load
that resolve on subsequent loads once WebAssembly is cached.

### Firefox module workers

Firefox may have issues with CDN module imports inside module workers. If the
worker fails to load in Firefox specifically, check the browser console for
import errors and ensure all worker dependencies are bundled locally.

## Cross-tab conflicts

**Problem**: Data appears inconsistent between tabs or changes seem lost.

**Solution**: Cross-tab conflicts are handled automatically by the CRDT layer:

- **Ready fields** (`schema.register()`, `schema.counter()`, `schema.prose()`,
  `schema.set()`) use Yjs CRDTs for automatic conflict-free merging.
- **Plain fields** use last-write-wins semantics at the shared IndexedDB level.

If you see unexpected behavior, verify that:

1. All tabs use the same `name` option (or the default `"convex-embedded"`).
2. The `BroadcastChannel` API is available in your target browsers.
3. You are not creating multiple clients with different names that you expect to
   share data.

## Database name collisions

**Problem**: Data from a different app or environment appears in your embedded
database.

**Solution**: Use a unique `name` per application to avoid data mixing:

```ts
// Development
const client = createConvexClient({
  modules,
  name: "my-app-dev",
});

// Production
const client = createConvexClient({
  modules,
  name: "my-app-prod",
});
```

The default name is `"convex-embedded"`. If you have multiple apps on the same
origin using the default, they will share an IndexedDB database. Always specify
an explicit `name` in production.

## Pagefind search not working in dev

**Problem**: The docs site search (powered by Pagefind) does not return results
during development.

**Solution**: Pagefind indexes are generated at build time. Search only works
after running a production build. During development, the search dialog will
appear but will not find any content. Run a full build to generate the search
index.

## Mutations succeed locally but fail to remote

**Problem**: Mutations complete instantly (local-first) but the remote state
shows `error` or stays in `resolving`.

**Solution**: Check these common causes:

1. **Incorrect deployment URL**: Verify the `remote.url` matches your Convex
   deployment URL exactly.
2. **Auth token issues**: If the remote deployment requires authentication,
   ensure `auth.fetchToken` is configured and returning valid tokens.
3. **Schema or routing mismatch**: The local embedded functions and the remote
   deployment must still agree on the relevant API shape. Redeploy your Convex
   functions if they changed.
4. **Network issues**: The resolve engine retries with exponential back-off.
   Check the `RemoteState` for error details:

```ts
subscribeRemoteState(client, (state) => {
  if (state.status === "error") {
    console.error("Sync error:", state.error);
  }
});
```

If replay is stuck after a crash or abandoned tab, remember that pending replay
entries are now lease-based. Another processor can reclaim expired work after
lease expiry; this is core behavior, not a browser-only workaround.

## Client not cleaning up properly

**Problem**: Leaked workers, WebSocket connections, or `BroadcastChannel`
listeners after navigation or HMR.

**Solution**: Always call `client.close()` in cleanup hooks:

**Svelte**:

```ts
onDestroy(() => client.close());

// Also handle HMR in development
if (import.meta.hot) {
  import.meta.hot.dispose(() => client.close());
}
```

**React**:

```tsx
useEffect(() => {
  return () => client.close();
}, [client]);
```

The `close()` method terminates the wa-sqlite worker, closes BroadcastChannel
instances, shuts down the resolve engine, and closes the underlying
ConvexClient.
