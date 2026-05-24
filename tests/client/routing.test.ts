import {
  assertRemotePlanOnline,
  planMutationExecution,
  planReadExecution,
} from "@resolve/client/routing/plan";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { ConvexError } from "convex/values";

type RoutingErrorData = {
  code: string;
  message: string;
};

function expectRoutingError(error: unknown): ConvexError<RoutingErrorData> {
  expect(error).toBeInstanceOf(ConvexError);
  return error as ConvexError<RoutingErrorData>;
}

describe("routing plan guardrails", () => {
  let originalNavigator: Navigator | undefined;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
  });

  it("routes component refs remote by default", () => {
    const plan = planMutationExecution({
      refName: "",
      refPath: {
        componentPath: "childComponent/embedded",
        udfPath: "tasks:list",
      },
      routeMode: null,
    });

    expect(plan).toEqual({
      kind: "remote",
      refName: "childComponent/embedded/tasks:list",
      cause: "component-routed",
    });
  });

  it("rejects localOnly component refs with a structured guardrail error", () => {
    const plan = planReadExecution({
      refName: "",
      refPath: {
        componentPath: "childComponent/embedded",
        udfPath: "tasks:list",
      },
      routeMode: "local",
    });

    expect(plan.kind).toBe("error");
    if (plan.kind !== "error") {
      throw new Error("expected an error plan");
    }
    const error = expectRoutingError(plan.error);
    expect(error.data.code).toBe("ROUTE_LOCAL_UNSUPPORTED");
    expect(error.message).toMatch(/cannot run locally in alpha/);
  });

  it("preserves explicit remote routes", () => {
    const plan = planReadExecution({
      refName: "messages:publish",
      refPath: { componentPath: "", udfPath: "messages:publish" },
      routeMode: "remote",
    });

    expect(plan).toEqual({
      kind: "remote",
      refName: "messages:publish",
      cause: "remote-routed",
    });
  });

  it("fails remote plans immediately when offline", () => {
    let thrown: unknown;
    try {
      assertRemotePlanOnline(
        {
          refName: "messages:publish",
          cause: "remote-routed",
        },
        {
          isOnline: () => false,
        },
      );
    } catch (error) {
      thrown = error;
    }

    const error = expectRoutingError(thrown);
    expect(error.data.code).toBe("ROUTE_REMOTE_OFFLINE");
    expect(error.message).toMatch(/cannot run while offline/);
  });
});
