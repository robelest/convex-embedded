import { embeddedTable } from "@robelest/convex-embedded/server";
import { describe, expectTypeOf, it } from "@tests/testkit";
import { v } from "convex/values";

describe("embeddedTable type inference", () => {
  it("preserves the literal table name", () => {
    const tasks = embeddedTable("tasks", { title: v.string() });
    expectTypeOf(tasks.table).toEqualTypeOf<"tasks">();
  });

  it("accepts only declared field names in field()", () => {
    const tasks = embeddedTable("tasks", {
      title: v.string(),
      done: v.boolean(),
    });
    expectTypeOf<typeof tasks.field>().toBeCallableWith("handle-1", "title");
    expectTypeOf<typeof tasks.field>().toBeCallableWith("handle-1", "done");
  });
});
