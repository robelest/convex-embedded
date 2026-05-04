import {
  assertRemotePlanOnline,
  planMutationExecution,
  planReadExecution,
} from "@resolve/client/routing/plan";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { ConvexError } from "convex/values";

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
    expect((plan as { kind: "error"; error: Error }).error).toBeInstanceOf(
      ConvexError,
    );
    expect(
      (
        (plan as { kind: "error"; error: ConvexError<any> })
          .error as ConvexError<any>
      ).data.code,
    ).toBe("ROUTE_LOCAL_UNSUPPORTED");
    expect((plan as { kind: "error"; error: Error }).error.message).toMatch(
      /cannot run locally in alpha/,
    );
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
      throw new Error("expected offline routing guardrail to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
      expect((error as ConvexError<any>).data.code).toBe(
        "ROUTE_REMOTE_OFFLINE",
      );
      expect((error as Error).message).toMatch(/cannot run while offline/);
    }
  });
});
