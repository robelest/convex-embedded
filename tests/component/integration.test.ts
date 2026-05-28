import {
  planMutationExecution,
  planReadExecution,
} from "@embedded/client/routing/plan";
import type {
  ConvexModuleRegistry,
  FunctionPath,
} from "@embedded/kernel/modules";
import { getFunctionPath } from "@embedded/kernel/modules";
import { createEmbeddedRuntime } from "@embedded/runtime/embedded";
import { describe, expect, it } from "@tests/testkit";
import { ConvexError } from "convex/values";

const STUB_MODULES: ConvexModuleRegistry = {
  "_generated/api": () => Promise.resolve({}),
};

interface RunUdfRuntime {
  _runUdf(
    type: "query" | "mutation" | "action",
    path: FunctionPath,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

describe.concurrent("component path resolution", () => {
  it("leaves componentPath empty for direct UDF names", () => {
    const path = getFunctionPath({ name: "messages:send" });

    expect(path.componentPath).toBe("");
    expect(path.udfPath).toBe("messages:send");
  });
});

describe.concurrent("routing for component functions", () => {
  it("routes component mutation refs remote with a component-routed cause", () => {
    const plan = planMutationExecution({
      refName: "embedded:messages.send",
      refPath: { componentPath: "embedded", udfPath: "messages:send" },
      routeMode: null,
    });

    expect(plan.kind).toBe("remote");
    if (plan.kind === "remote") {
      expect(plan.cause).toBe("component-routed");
    }
  });

  it("routes component read refs remote with a component-routed cause", () => {
    const plan = planReadExecution({
      refName: "embedded:messages.list",
      refPath: { componentPath: "embedded", udfPath: "messages:list" },
      routeMode: null,
    });

    expect(plan.kind).toBe("remote");
    if (plan.kind === "remote") {
      expect(plan.cause).toBe("component-routed");
    }
  });

  it("rejects localOnly() on a component function (alpha contract)", () => {
    const plan = planMutationExecution({
      refName: "embedded:messages.send",
      refPath: { componentPath: "embedded", udfPath: "messages:send" },
      routeMode: "local",
    });

    expect(plan.kind).toBe("error");
    if (plan.kind === "error") {
      expect(plan.error.message).toMatch(
        /localOnly\(\) but cannot run locally in alpha/,
      );
    }
  });

  it("routes non-component refs locally by default (mirror)", () => {
    const plan = planMutationExecution({
      refName: "messages:send",
      refPath: { componentPath: "", udfPath: "messages:send" },
      routeMode: null,
    });

    expect(plan.kind).toBe("local");
    if (plan.kind === "local") {
      expect(plan.enqueueForReplay).toBe(true);
    }
  });
});

describe("EmbeddedRuntime component dispatch (alpha guard)", () => {
  it("throws NESTED_COMPONENT_LOCAL_UNSUPPORTED when invoked with a component path", async ({
    track,
  }) => {
    const runtime = createEmbeddedRuntime({
      convex: { modules: STUB_MODULES },
    });
    track({ close: () => runtime.shutdown() });
    await runtime.hydrate();

    const runUdf = runtime as unknown as RunUdfRuntime;
    const error = await runUdf
      ._runUdf(
        "mutation",
        { componentPath: "embedded", udfPath: "messages:send" },
        {},
      )
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConvexError);
    if (error instanceof ConvexError) {
      const data = error.data as { code?: string };
      expect(data.code).toBe("NESTED_COMPONENT_LOCAL_UNSUPPORTED");
      expect(error.message).toMatch(
        /Component refs are remote-routed in alpha/,
      );
    }
  });
});
