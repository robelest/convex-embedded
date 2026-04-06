import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const hasBuildArtifacts = await access(
  new URL("../../packages/convex-embedded/dist/index.js", import.meta.url),
)
  .then(() => true)
  .catch(() => false);

const importableSpecifiers = [
  "@robelest/convex-embedded",
  "@robelest/convex-embedded/browser",
  "@robelest/convex-embedded/react",
  "@robelest/convex-embedded/server",
  "@robelest/convex-embedded/client",
  "@robelest/convex-embedded/crdt",
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
  },
);
