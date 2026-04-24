import { discoverPendingReplayMetadata } from "@resolve/client/replay";
import { beforeEach, describe, expect, it, vi } from "@tests/testkit";

describe("discoverPendingReplayMetadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caches replay metadata per module registry", async () => {
    const replayTagged = () => {};
    Object.defineProperty(
      replayTagged,
      Symbol.for("convex-embedded:pendingReplayMeta"),
      {
        value: {
          __brand: "convex-embedded:pendingReplayMeta",
          version: 1,
          migrate: {},
        },
      },
    );

    const loadModule = vi.fn(async () => ({ create: replayTagged }));
    const modules = {
      issues: loadModule,
    };

    const first = await discoverPendingReplayMetadata(modules);
    const second = await discoverPendingReplayMetadata(modules);

    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.get("issues:create")).toMatchObject({
      version: 1,
    });
  });
});
