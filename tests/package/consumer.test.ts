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

async function resolveSpecifier(specifier: string): Promise<string> {
  const resolved = import.meta.resolve(specifier);

  expect(resolved.startsWith("file://")).toBe(true);

  const filePath = fileURLToPath(resolved);
  await access(filePath);

  return resolved;
}

(hasBuildArtifacts ? describe : describe.skip)(
  "package consumer exports",
  () => {
    it("resolves each public export via Node package resolution", async () => {
      for (const specifier of [
        ...importableSpecifiers,
        ...resolveOnlySpecifiers,
      ]) {
        await resolveSpecifier(specifier);
      }
    });

    it("imports consumer-facing exports from resolved files", async () => {
      for (const specifier of importableSpecifiers) {
        const resolved = await resolveSpecifier(specifier);
        const module = await import(resolved);
        expect(module).toBeDefined();
      }
    });

    it("keeps the browser sqlite worker co-located with the emitted chunk that loads it", async () => {
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
      let referencingFile: string | null = null;

      for (const fileName of topLevelJsFiles) {
        const content = await readFile(join(distDir, fileName), "utf8");
        if (content.includes('new URL("./worker.js", import.meta.url)')) {
          referencingFile = fileName;
          break;
        }
      }

      expect(referencingFile).not.toBeNull();
    });
  },
);
