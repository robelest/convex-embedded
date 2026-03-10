import { v } from "convex/values";

import { register } from "@robelest/convex-resolve/server";

import { api, components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { taskSchema } from "./schema";

// ---------------------------------------------------------------------------
// Register the tasks table for CRDT resolve sync.
// On remote Convex: components.resolve is populated → deltas are recorded.
// On local embedded: components.resolve is undefined → no-op.
// ---------------------------------------------------------------------------

const {
  resolve: resolveDefinition,
  _recordDelta: recordDeltaDefinition,
  wrapMutation,
} = register({
  table: "tasks",
  schema: taskSchema,
  component: (components as any).resolve,
});

// Export the resolve query — called by the client monitor on connect/reconnect
export const resolve = query(resolveDefinition);

// Export the internal delta recorder — scheduled by wrapMutation on remote
export const _recordDelta = mutation(recordDeltaDefinition);

// ---------------------------------------------------------------------------
// CRUD mutations — wrapped to schedule delta recording on remote
// ---------------------------------------------------------------------------

export const create = mutation(
  wrapMutation(api.tasks._recordDelta, {
    args: { title: v.string(), body: v.string() },
    handler: async (ctx, args) => {
      return await ctx.db.insert("tasks", args);
    },
  }),
);

export const update = mutation(
  wrapMutation(api.tasks._recordDelta, {
    args: { id: v.id("tasks"), title: v.string(), body: v.string() },
    handler: async (ctx, args) => {
      const { id, ...fields } = args;
      await ctx.db.patch(id, fields);
      return id;
    },
  }),
);

export const remove = mutation(
  wrapMutation(api.tasks._recordDelta, {
    args: { id: v.id("tasks") },
    handler: async (ctx, args) => {
      await ctx.db.delete(args.id);
      return args.id;
    },
  }),
);

// List all tasks
export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("tasks"),
      _creationTime: v.number(),
      title: v.string(),
      body: v.string(),
    }),
  ),
  handler: async (ctx) => {
    return await ctx.db.query("tasks").collect();
  },
});
