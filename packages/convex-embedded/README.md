# `@robelest/convex-embedded`

Embedded Convex runtime for local-first applications.

## API Overview

- `@robelest/convex-embedded` - runtime primitives such as
  `createEmbeddedRuntime()` and transport helpers.
- `@robelest/convex-embedded/browser` - browser-first `createConvexClient()`
  factory with persistence, auth, and remote sync wiring.
- `@robelest/convex-embedded/react-native` - React Native `createConvexClient()`
  factory with SQLite persistence plus Expo-backed file, network, and crypto
  adapters.
- `@robelest/convex-embedded/server` - `embeddedTable()`, schema helpers,
  migrations, and Convex-side setup utilities.
- `@robelest/convex-embedded/crdt` - CRDT field constructors and runtime helpers
  for reading Yjs-backed state.
- `@robelest/convex-embedded/client` - client bootstrap helpers such as
  `createEmbeddedPrefetch()` for SSR/bootstrap data loading.
- `@robelest/convex-embedded/test` - test helpers for registering the packaged
  component with `convex-test`.
