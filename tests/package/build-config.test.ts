import { describe, expect, it } from "@tests/testkit";

import config from "../../packages/convex-embedded/tsdown.config";

describe("package build config", () => {
  it("emits the browser sqlite worker alongside browser/index", () => {
    expect(config[0]?.entry).toMatchObject({
      "browser/index": "src/browser/index.ts",
      worker: "src/browser/sqlite/worker.js",
    });
  });
});
