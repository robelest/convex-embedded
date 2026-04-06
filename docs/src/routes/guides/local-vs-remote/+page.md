---
title: Local vs Remote Execution
description:
  How default execution, localOnly, remoteOnly, and component routing behave.
---

<svelte:head>

  <title>Local vs Remote Execution - convex-embedded</title>
</svelte:head>

# Local vs Remote Execution

This guide explains the execution rules you actually program against.

## Default rule

For embedded synced functions, the default model is:

- run locally when the embedded runtime can safely do it
- replay/sync with remote when `remote` is configured
- fail closed when a path is unsupported instead of silently doing the wrong
  thing

## `localOnly(...)`

Use `localOnly(...)` when a function must run in the embedded runtime or fail.

```ts
import { localOnly } from "@robelest/convex-embedded/server";
import { query } from "./_generated/server";

export const listDrafts = localOnly(
  query({
    args: {},
    handler: async (ctx) => await ctx.db.query("drafts").collect(),
  }),
);
```

If the target cannot run locally in alpha, the call throws a structured
`ConvexError`.

## `remoteOnly(...)`

Use `remoteOnly(...)` when the function must run on the remote deployment.

```ts
import { remoteOnly } from "@robelest/convex-embedded/server";
import { action } from "./_generated/server";
import { v } from "convex/values";

export const sendEmail = remoteOnly(
  action({
    args: { to: v.string() },
    handler: async (_ctx, args) => {
      await sendEmailViaProvider(args.to);
    },
  }),
);
```

If the client is offline, `remoteOnly(...)` fails immediately with a structured
guardrail error.

## Component refs

Current alpha behavior:

- top-level component refs remote-route by default
- nested/local component execution is rejected
- unsupported local paths fail closed

That means you should not expect nested component calls to silently work inside
local execution.

## Mutation/query `remote:` vs `remoteOnly(...)`

These are different tools.

| Feature            | What it does                                                              | When to use it                                    |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `remote:` callback | runs extra logic only on remote Convex after normal embedded handler flow | server-only side effects or remote result shaping |
| `remoteOnly(...)`  | forces the whole export to execute remotely                               | the full function must stay remote                |

Example:

```ts
export const create = tasks.mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => await ctx.db.insert("tasks", args),
  remote: async (_ctx, _args, taskId) => {
    await notifyRemoteOnlySystems(taskId);
  },
});
```

This stays local-first, but still has a remote-only post-handler hook.

## Typical choices

Use local-first embedded functions for:

- task/document CRUD
- rich-text editing
- collaborative counters and sets
- optimistic app state that should work offline

Use `remoteOnly(...)` for:

- provider-bound actions
- network-only side effects
- secrets / integrations that should never run locally
- unsupported local primitive paths

## Failure model

The current alpha contract is explicit:

- `localOnly()` means local or fail
- `remoteOnly()` means remote or fail
- unsupported local execution paths fail closed

This is intentional and safer than hidden fallbacks.

## Next steps

- [Embedded Tables & Fields](/guides/embedded-tables)
- [Server API](/api/server)
