import { schema } from "@robelest/convex-embedded/crdt";
import { embeddedTable } from "@robelest/convex-embedded/server";
import { defineSchema } from "convex/server";
import { v } from "convex/values";

export const tasks = embeddedTable("tasks", {
  title: schema.register(v.string()),
  body: schema.register(v.string()),
});

export default defineSchema({
  tasks,
});
