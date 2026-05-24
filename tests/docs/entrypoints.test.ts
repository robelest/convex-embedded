import { readFile } from "node:fs/promises";

import { describe, expect, it } from "@tests/testkit";

const entryFiles = [
  "packages/convex-embedded/src/index.ts",
  "packages/convex-embedded/src/browser/index.ts",
  "packages/convex-embedded/src/node/index.ts",
  "packages/convex-embedded/src/react.ts",
  "packages/convex-embedded/src/expo/index.ts",
  "packages/convex-embedded/src/server/index.ts",
  "packages/convex-embedded/src/server/table.ts",
  "packages/convex-embedded/src/server/fields.ts",
  "packages/convex-embedded/src/server/schema.ts",
  "packages/convex-embedded/src/crdt/index.ts",
  "packages/convex-embedded/src/client/index.ts",
  "packages/convex-embedded/src/test.ts",
] as const;

describe("public entrypoint docs", () => {
  it.concurrent.for(entryFiles)(
    "%s includes package documentation",
    async (relativePath) => {
      const fileUrl = new URL(`../../${relativePath}`, import.meta.url);
      const source = await readFile(fileUrl, "utf8");

      expect(source).toContain("@packageDocumentation");
    },
  );
});
