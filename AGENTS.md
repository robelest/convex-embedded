<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, but it invokes Vite through `vp dev` and `vp build`.

## Vite+ Workflow

`vp` is a global binary that handles the full development lifecycle. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

### Start

- create - Create a new project from a template
- migrate - Migrate an existing project to Vite+
- config - Configure hooks and agent integration
- staged - Run linters on staged files
- install (`i`) - Install dependencies
- env - Manage Node.js versions

### Develop

- dev - Run the development server
- check - Run format, lint, and TypeScript type checks
- lint - Lint code
- fmt - Format code
- test - Run tests

### Execute

- run - Run monorepo tasks
- exec - Execute a command from local `node_modules/.bin`
- dlx - Execute a package binary without installing it as a dependency
- cache - Manage the task cache

### Build

- build - Build for production
- pack - Build libraries
- preview - Preview production build

### Manage Dependencies

Vite+ automatically detects and wraps the underlying package manager such as pnpm, npm, or Yarn through the `packageManager` field in `package.json` or package manager-specific lockfiles.

- add - Add packages to dependencies
- remove (`rm`, `un`, `uninstall`) - Remove packages from dependencies
- update (`up`) - Update packages to latest versions
- dedupe - Deduplicate dependencies
- outdated - Check for outdated packages
- list (`ls`) - List installed packages
- why (`explain`) - Show why a package is installed
- info (`view`, `show`) - View package information from the registry
- link (`ln`) / unlink - Manage local package links
- pm - Forward a command to the package manager

### Maintain

- upgrade - Update `vp` itself to the latest version

These commands map to their corresponding tools. For example, `vp dev --port 3000` runs Vite's dev server and works the same as Vite. `vp test` runs JavaScript tests through the bundled Vitest. The version of all tools can be checked using `vp --version`. This is useful when researching documentation, features, and bugs.

## Common Pitfalls

- **Using the package manager directly:** Do not use pnpm, npm, or Yarn directly. Vite+ can handle all package manager operations.
- **Always use Vite commands to run tools:** Don't attempt to run `vp vitest` or `vp oxlint`. They do not exist. Use `vp test` and `vp lint` instead.
- **Running scripts:** Vite+ built-in commands (`vp dev`, `vp build`, `vp test`, etc.) always run the Vite+ built-in tool, not any `package.json` script of the same name. To run a custom script that shares a name with a built-in command, use `vp run <script>`. For example, if you have a custom `dev` script that runs multiple services concurrently, run it with `vp run dev`, not `vp dev` (which always starts Vite's dev server).
- **Do not install Vitest, Oxlint, Oxfmt, or tsdown directly:** Vite+ wraps these tools. They must not be installed directly. You cannot upgrade these tools by installing their latest versions. Always use Vite+ commands.
- **Use Vite+ wrappers for one-off binaries:** Use `vp dlx` instead of package-manager-specific `dlx`/`npx` commands.
- **Import JavaScript modules from `vite-plus`:** Instead of importing from `vite` or `vitest`, all modules should be imported from the project's `vite-plus` dependency. For example, `import { defineConfig } from 'vite-plus';` or `import { expect, test, vi } from 'vite-plus/test';`. You must not install `vitest` to import test utilities.
- **Type-Aware Linting:** There is no need to install `oxlint-tsgolint`, `vp lint --type-aware` works out of the box.

## CI Integration

For GitHub Actions, consider using [`voidzero-dev/setup-vp`](https://github.com/voidzero-dev/setup-vp) to replace separate `actions/setup-node`, package-manager setup, cache, and install steps with a single action.

```yaml
- uses: voidzero-dev/setup-vp@v1
  with:
    cache: true
- run: vp check
- run: vp test
```

## Review Checklist for Agents

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to validate changes.
<!--VITE PLUS END-->

## Lexicon — canonical verb dictionary for `packages/convex-embedded`

Matches the Convex SDK where the concept exists, internally consistent
elsewhere. Enforced by `no-restricted-syntax` in the package's eslint overrides;
new code that uses a banned verb fails `vp run check`.

| Meaning                                  | Canonical                   | Banned → rewrite                                    |
| ---------------------------------------- | --------------------------- | --------------------------------------------------- |
| Read one record (logical)                | `get*`                      | —                                                   |
| Read rows from durable store             | `read*`                     | —                                                   |
| Bring a subsystem into memory (async)    | `load*`                     | —                                                   |
| Network/remote retrieval                 | `fetch*`                    | (network only)                                      |
| Gather a derived collection (non-query)  | `gather*`                   | `collect*`(non-query) · `find[A-Z]` · `lookup[A-Z]` |
| Extract a sub-part of a value/AST        | `extract*`                  | —                                                   |
| Convex query terminal                    | `collect`                   | **reserved** — never reuse                          |
| Insert a logical document                | `insert*`                   | `put*`(doc) · `upsert*`                             |
| Replace a logical document               | `replace*`                  | —                                                   |
| Shallow update a logical document        | `patch*`                    | `update*`(doc) · `modify*`                          |
| Delete a logical record                  | `delete*`                   | `remove*`(records)                                  |
| Detach from in-memory set / listener     | `remove*` / `detach*`       | (kept)                                              |
| Bulk reset in-memory state               | `clear*`                    | —                                                   |
| Store blob/file content                  | `store*`                    | `put*`(blob)                                        |
| Durably write metadata/rows to sqlite    | `write*`                    | `persist*`                                          |
| Create a stateful/live instance          | `create*`                   | `make*`/`build*`(stateful)                          |
| Assemble pure data (SQL, plans)          | `build*`                    | `make*`(pure)                                       |
| Convert in-memory type→type              | `to*`                       | —                                                   |
| Symmetric A↔B content conversion         | `aToB*`                     | (kept)                                              |
| Decode/encode binary/wire                | `decode*`/`encode*`         | —                                                   |
| Parse text→structured                    | `parse*`                    | —                                                   |
| Boolean predicate                        | `is*`/`has*`/`should*`      | —                                                   |
| Invoke at the Convex level               | `run*`                      | —                                                   |
| Execute at the engine/SQL level          | `execute*`                  | —                                                   |
| Event/message handler                    | `handle*`/`on*`             | —                                                   |
| Schedule deferred work                   | `schedule*`                 | —                                                   |
| Format for display                       | `format*`                   | `fmt`                                               |
| Subscribe/unsubscribe                    | `subscribe*`/`unsubscribe*` | `unsub`                                             |
| Offline↔remote synchronization subsystem | `replicate*`/`replication*` | `sync*`(subsystem)                                  |
| Synchronous vs async variant             | `*Sync`/`*Async` suffix     | (kept — `fs.readFileSync` idiom)                    |
| Remote→local data fetch/merge subsystem  | `pull*`                     | `resolve*`(subsystem) · `*Resolve*` noun            |
| Turn a reference into the concrete thing | `get*`/`route*`/`plan*`     | `resolve*`(verb)                                    |
| Merge CRDT/dirty rows                    | `merge*`                    | `resolveDirty*`                                     |

**Documented exceptions** (never flagged): Convex seam (`query`, `mutation`,
`action`, db `get/insert/patch/replace/delete`, `paginate`, `withIndex`,
`useQuery`, `preloadQuery`, `makeFunctionReference`,
`convexToJson`/`jsonToConvex`, `compareValues`); CRDT DSL (`prose`, `register`,
`counter`, `set`, `omit`, `schema`, `define`, `view`, `migration`); native
platform APIs (`removeEventListener`, `addEventListener`, `randomUUID`,
`setTimeout`, …); symmetric `aToB` converters (`proseContentToYDoc`,
`convexToJson`, …); third-party plugin hooks (Vite's
`configResolved`/`configureServer`/`closeBundle`); kernel CRUD namespace
(`tableGet`/`Insert`/`Patch`/`Replace`/`Delete`,
`systemInsert`/`Patch`/`ReadByIndex`/`Delete` — they ARE the Convex db verbs
under a noun namespace, kept this shape to avoid colliding with the existing
`getTableForId`/`getTableNames` accessor family).

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md`
first** for important guidelines on how to correctly use Convex APIs and
patterns. The file contains rules that override what you may have learned about
Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
