import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@tests/testkit";

const hasBuildArtifacts = await access(
  new URL("../../packages/convex-embedded/dist/index.js", import.meta.url),
)
  .then(() => true)
  .catch(() => false);

const importableSpecifiers = [
  "@robelest/convex-embedded",
  "@robelest/convex-embedded/browser",
  "@robelest/convex-embedded/node",
  "@robelest/convex-embedded/react",
  "@robelest/convex-embedded/server",
  "@robelest/convex-embedded/client",
  "@robelest/convex-embedded/crdt",
  "@robelest/convex-embedded/codegen",
  "@robelest/convex-embedded/next",
  "@robelest/convex-embedded/nitro",
  "@robelest/convex-embedded/unplugin",
  "@robelest/convex-embedded/vite",
  "@robelest/convex-embedded/test",
  "@robelest/convex-embedded/convex.config",
] as const;

const resolveOnlySpecifiers = ["@robelest/convex-embedded/expo"] as const;

const resolvableSpecifiers = [
  ...importableSpecifiers,
  ...resolveOnlySpecifiers,
];

async function resolveSpecifier(specifier: string): Promise<string> {
  const resolved = import.meta.resolve(specifier);

  expect(resolved.startsWith("file://")).toBe(true);

  await access(fileURLToPath(resolved));

  return resolved;
}

(hasBuildArtifacts ? describe : describe.skip)(
  "package consumer exports",
  () => {
    it.for(resolvableSpecifiers)(
      "resolves %s via Node package resolution",
      async (specifier) => {
        await resolveSpecifier(specifier);
      },
    );

    it.for(importableSpecifiers)(
      "imports %s from its resolved file",
      async (specifier) => {
        const resolved = await resolveSpecifier(specifier);
        const imported: unknown = await import(resolved);
        expect(imported).toBeDefined();
      },
    );

    it("co-locates the browser sqlite worker with the chunk that loads it", async () => {
      const workerPath = fileURLToPath(
        new URL(
          "../../packages/convex-embedded/dist/worker.js",
          import.meta.url,
        ),
      );
      const distDir = dirname(workerPath);

      await access(workerPath);

      const topLevelJsFiles = (await readdir(distDir)).filter((entry) =>
        entry.endsWith(".js"),
      );
      const contents = await Promise.all(
        topLevelJsFiles.map((fileName) =>
          readFile(join(distDir, fileName), "utf8"),
        ),
      );
      const referencingFile = topLevelJsFiles.find((_fileName, index) =>
        contents[index]?.includes('new URL("./worker.js", import.meta.url)'),
      );

      expect(referencingFile).toBeDefined();
    });
  },
);
