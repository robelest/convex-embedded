import { afterEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

describe("browser entry SSR imports", () => {
  const originalAllowFunctions = (globalThis as Record<string, unknown>)
    .__convexAllowFunctionsInBrowser;

  afterEach(() => {
    vi.resetModules();
    if (originalAllowFunctions === undefined) {
      delete (globalThis as Record<string, unknown>)
        .__convexAllowFunctionsInBrowser;
      return;
    }

    (globalThis as Record<string, unknown>).__convexAllowFunctionsInBrowser =
      originalAllowFunctions;
  });

  it("does not mutate the Convex browser import flag at module import time", async () => {
    delete (globalThis as Record<string, unknown>)
      .__convexAllowFunctionsInBrowser;

    await import("@resolve/browser/index");

    expect(
      (globalThis as Record<string, unknown>).__convexAllowFunctionsInBrowser,
    ).toBeUndefined();
  });
});
