# convex-embedded

Embedded Convex runtime with offline-first sync for local-first applications.

## Features

- **Standard Convex client API** - Run against an embedded runtime without
  rewriting your app around a custom client surface.
- **Offline-first sync** - Keep working locally, persist data in-browser, and
  reconcile with a remote Convex deployment when connectivity returns.
- **CRDT field types** - Model collaborative state with Yjs-backed field
  primitives such as `register`, `prose`, `counter`, and `set`.
- **Cross-platform runtime** - Use the package across browser, React, Expo,
  Node.js, and Convex server entry points.
- **Cross-tab persistence** - Share local state, session updates, and write
  notifications across tabs that use the same database name.
- **Optional remote routing** - Choose which functions stay local and which ones
  execute against the authoritative remote backend.

## Documentation

**[embedded.estifanos.com](https://embedded.estifanos.com)**

| Section                                                                         | Description                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Getting Started](https://embedded.estifanos.com/getting-started/installation/) | Install the package, register the component, and wire up your first client.                |
| [Guides](https://embedded.estifanos.com/guides/browser/)                        | Browser integration, embedded tables, auth, remote configuration, and cross-tab sync.      |
| [API Reference](https://embedded.estifanos.com/api/browser/)                    | Browser, client, server, CRDT, and test entry points.                                      |
| [Concepts](https://embedded.estifanos.com/concepts/architecture/)               | Architecture, persistence, offline reconciliation, embedded runtime internals, and search. |
| [Reference](https://embedded.estifanos.com/reference/config/)                   | Configuration, migration notes, troubleshooting, and error handling.                       |

## Contributing

```bash
vp install
vp check
vp test
```

| Directory                   | Description                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/convex-embedded/` | Published package with browser, server, Expo, Node, React, CRDT, and test entry points.          |
| `convex/`                   | Example Convex app modules used by the repo, tests, and demos.                                   |
| `docs/`                     | Documentation site published at `embedded.estifanos.com`.                                        |
| `demos/`                    | Svelte and Expo demos that exercise the embedded runtime.                                        |
| `tests/`                    | Vitest suites for package behavior, runtime behavior, docs invariants, and integration coverage. |

## License

MIT
