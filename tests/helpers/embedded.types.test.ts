import {
  embeddedTest,
  testAction,
  testMutation,
  testQuery,
} from "@tests/helpers/embedded";
import { describe, expectTypeOf, it } from "@tests/testkit";
import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

describe("embeddedTest type inference", () => {
  const t = embeddedTest({
    modules: {
      "messages:list": testQuery(async (ctx): Promise<string[]> => {
        expectTypeOf(ctx).toEqualTypeOf<GenericQueryCtx<GenericDataModel>>();
        return [];
      }),
      "messages:send": testMutation(
        async (ctx, args: { body: string }): Promise<number> => {
          expectTypeOf(ctx).toEqualTypeOf<
            GenericMutationCtx<GenericDataModel>
          >();
          expectTypeOf(args).toEqualTypeOf<{ body: string }>();
          return 1;
        },
      ),
      "tasks:run": testAction(async (ctx, args: { id: string }) => {
        expectTypeOf(ctx).toEqualTypeOf<GenericActionCtx<GenericDataModel>>();
        return args.id.length;
      }),
    },
  });

  it("infers a query's return type from its path", async () => {
    const list = await t.query("messages:list");
    expectTypeOf(list).toEqualTypeOf<string[]>();
  });

  it("infers a mutation's args and return type from its path", async () => {
    const sent = await t.mutation("messages:send", { body: "hi" });
    expectTypeOf(sent).toEqualTypeOf<number>();
  });

  it("infers an action's args and return type from its path", async () => {
    const ran = await t.action("tasks:run", { id: "abc" });
    expectTypeOf(ran).toEqualTypeOf<number>();
  });
});
