import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TestFixtures } from "@tests/testkit";
import { describe, expect, it } from "@tests/testkit";

interface MetroResolution {
  filePath: string;
  type: "sourceFile";
}

interface MetroResolveContext {
  resolveRequest: (
    context: MetroResolveContext,
    moduleName: string,
    platform: string | null,
  ) => MetroResolution;
  originModulePath?: string;
}

interface MetroConfig {
  resolver: {
    resolveRequest?: (
      context: MetroResolveContext,
      moduleName: string,
      platform: string | null,
    ) => MetroResolution;
    extraNodeModules?: Record<string, string>;
  };
}

interface MetroPluginOptions {
  packageRoot: string;
  projectRoot: string;
  convexDir: string;
  out: string;
  watch: boolean;
  aliases?: Record<string, string>;
}

type WithConvexEmbeddedExpoMetro = (
  config: MetroConfig,
  options?: MetroPluginOptions,
) => MetroConfig;

const require = createRequire(import.meta.url);
const { withConvexEmbeddedExpoMetro } =
  require("../../packages/convex-embedded/src/expo/metro.cjs") as {
    withConvexEmbeddedExpoMetro: WithConvexEmbeddedExpoMetro;
  };

function makeWorkDir(track: TestFixtures["track"]): string {
  const workDir = mkdtempSync(
    path.join(tmpdir(), "convex-embedded-expo-metro-"),
  );
  track({
    close: () => {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  });
  return workDir;
}

async function writeFileEnsured(
  filePath: string,
  contents: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function createFakePackageRoot(workDir: string): Promise<string> {
  const packageRoot = path.join(workDir, "package");
  await writeFileEnsured(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFileEnsured(
    path.join(packageRoot, "dist/codegen.js"),
    `import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function generateEmbeddedRegistry(input) {
  const counterFile = path.join(input.cwd, "codegen-count.txt");
  let count = 0;
  try {
    count = Number(await readFile(counterFile, "utf8"));
  } catch {}
  count += 1;
  await writeFile(counterFile, String(count), "utf8");
  const outFile = path.resolve(input.cwd, input.outFile);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, String(count), "utf8");
}
`,
  );
  await mkdir(path.join(packageRoot, "src/expo/shims"), { recursive: true });
  return packageRoot;
}

describe("withConvexEmbeddedExpoMetro", () => {
  it("runs codegen synchronously before returning the config", async ({
    track,
  }) => {
    const workDir = makeWorkDir(track);
    const packageRoot = await createFakePackageRoot(workDir);
    await mkdir(path.join(workDir, "convex"), { recursive: true });

    withConvexEmbeddedExpoMetro(
      { resolver: {} },
      {
        packageRoot,
        projectRoot: workDir,
        convexDir: "convex",
        out: "generated/embedded.ts",
        watch: false,
      },
    );

    await expect(
      readFile(path.join(workDir, "generated/embedded.ts"), "utf8"),
    ).resolves.toBe("1");
  });

  it("regenerates before resolving the generated registry alias", async ({
    track,
  }) => {
    const workDir = makeWorkDir(track);
    const packageRoot = await createFakePackageRoot(workDir);
    const generated = path.join(workDir, "generated/embedded.ts");
    await mkdir(path.join(workDir, "convex"), { recursive: true });

    const config = withConvexEmbeddedExpoMetro(
      { resolver: {} },
      {
        packageRoot,
        projectRoot: workDir,
        convexDir: "convex",
        out: "generated/embedded.ts",
        watch: false,
        aliases: {
          "$convex/_generated/embedded": generated,
        },
      },
    );

    const resolved = config.resolver.resolveRequest?.(
      {
        resolveRequest: () => ({ filePath: "fallback", type: "sourceFile" }),
      },
      "$convex/_generated/embedded",
      "ios",
    );

    expect(resolved).toEqual({ filePath: generated, type: "sourceFile" });
    await expect(readFile(generated, "utf8")).resolves.toBe("2");
  });
});
