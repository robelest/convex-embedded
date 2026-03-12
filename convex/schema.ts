import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  define,
  registerField,
} from "@robelest/convex-embedded/server";

/**
 * CRDT schema definition for the tasks table.
 * Both `title` and `body` use last-writer-wins register strategy.
 */
export const taskSchema = define({
  version: 1,
  shape: {
    title: registerField(v.string()),
    body: registerField(v.string()),
  },
});

export default defineSchema({
  tasks: defineTable({
    title: v.string(),
    body: v.string(),
  }),
});
