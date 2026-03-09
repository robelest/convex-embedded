import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Create a new task
export const create = mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", args);
  },
});

// Update an existing task
export const update = mutation({
  args: { id: v.id("tasks"), title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    await ctx.db.patch(id, fields);
    return id;
  },
});

// Remove a task
export const remove = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

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
