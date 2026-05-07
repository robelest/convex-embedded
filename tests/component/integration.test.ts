import {
  planMutationExecution,
  planReadExecution,
} from "@embedded/client/routing/plan";
import { resolveFunctionPath } from "@embedded/kernel/modules";
import { EmbeddedRuntime } from "@embedded/runtime/embedded";
import { describe, expect, it } from "@tests/testkit";

const STUB_MODULES: Record<string, () => Promise<unknown>> = {
  "_generated/api": () => Promise.resolve({}),
};

// ---------------------------------------------------------------------------
// resolveFunctionPath — direct UDF names stay local (componentPath empty)
// ---------------------------------------------------------------------------

describe("component path resolution", () => {
  it("leaves componentPath empty for direct UDF names", () => {
    const path = resolveFunctionPath({ name: "messages:send" });
    expect(path.componentPath).toBe("");
    expect(path.udfPath).toBe("messages:send");
  });
});

// ---------------------------------------------------------------------------
// Routing — component refs are remote-routed with cause "component-routed"
// ---------------------------------------------------------------------------

describe("routing for component functions", () => {
  it("planMutationExecution routes component refs remote with component-routed cause", () => {
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

  it("planReadExecution routes component refs remote with component-routed cause", () => {
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

  it("non-component refs route locally by default (mirror)", () => {
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

// ---------------------------------------------------------------------------
// Runtime — _runUdf throws cleanly when reached for a component function
// ---------------------------------------------------------------------------

describe("EmbeddedRuntime component dispatch (alpha guard)", () => {
  it("throws NESTED_COMPONENT_LOCAL_UNSUPPORTED when invoked with a component path", async () => {
    const runtime = new EmbeddedRuntime({ convex: { modules: STUB_MODULES } });
    await runtime.hydrate();
    try {
      const path = {
        componentPath: "embedded",
        udfPath: "messages:send",
      };
      // _runUdf is private but reachable for tests; this is the path the
      // protocol takes when a component function arrives via 1.0/runUdf.
      const error = await (runtime as any)
        ._runUdf("mutation", path, {})
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      const data = (error as { data?: { code?: string } }).data ?? {};
      expect(data.code).toBe("NESTED_COMPONENT_LOCAL_UNSUPPORTED");
      expect((error as Error).message).toMatch(
        /Component refs are remote-routed in alpha/,
      );
    } finally {
      runtime.shutdown();
    }
  });
});
