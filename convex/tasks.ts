import { v } from "convex/values";

import { register } from "./sync";
import { taskSchema } from "./schema";

const tasks = register("tasks", taskSchema);

export const resolve = tasks.resolve;

export const create = tasks.mutation({
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", args);
  },
});

export const update = tasks.mutation({
  args: { id: v.id("tasks"), title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const { id, ...fields } = args;
    await ctx.db.patch(id, fields);
    return id;
  },
});

export const remove = tasks.mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

export const list = tasks.query({
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
