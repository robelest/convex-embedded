import { mutation, query } from "./_generated/server";
import { api, components } from "./_generated/api";
import { v } from "convex/values";
import {
  register,
  define,
  registerField,
  prose,
} from "convex-resolve/server";

// CRDT schema definition for the tasks table
const taskSchema = define({
  version: 1,
  shape: {
    title: registerField(v.string()),
    body: prose(),
  },
});

// Wire up delta recording and resolve for this table
const {
  resolve,
  _recordDelta,
  wrapMutation,
} = register({
  table: "tasks",
  schema: taskSchema,
  component: components.resolve,
});

// Export the resolve query for clients to call
export const resolveTask = query(resolve);

// Export _recordDelta so the scheduler can reference it
export const recordDelta = mutation(_recordDelta);

// Wrapped mutation — creates a task and schedules delta recording
export const create = mutation(
  wrapMutation(api.tasks.recordDelta, {
    args: { title: v.string(), body: v.string() },
    handler: async (ctx, args) => {
      return await ctx.db.insert("tasks", args);
    },
  }),
);

// Wrapped mutation — updates a task
export const update = mutation(
  wrapMutation(api.tasks.recordDelta, {
    args: { id: v.id("tasks"), title: v.string(), body: v.string() },
    handler: async (ctx, args) => {
      const { id, ...fields } = args;
      await ctx.db.patch(id, fields);
      return id;
    },
  }),
);

// List all tasks — used by the TanStack Start demo UI
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
