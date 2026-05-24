import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodegen } from "@embedded/codegen";
import { describe, expect, it as base } from "@tests/testkit";

interface CodegenFixtures {
  convexDir: string;
  writeModule: (relativePath: string, contents: string) => Promise<void>;
}

const it = base.extend<CodegenFixtures>({
  convexDir: async ({ onTestFinished }, use) => {
    const workDir = await mkdtemp(
      path.join(tmpdir(), "convex-embedded-codegen-"),
    );
    onTestFinished(() => rm(workDir, { recursive: true, force: true }));
    await use(path.join(workDir, "convex"));
  },
  writeModule: async ({ convexDir }, use) => {
    await use(async (relativePath, contents) => {
      const filePath = path.join(convexDir, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf8");
    });
  },
});

const remoteOnlyModule = (...lines: string[]): string => lines.join("\n");

function outFileFor(convexDir: string): string {
  return path.join(convexDir, "_generated/embedded.ts");
}

describe("runCodegen", () => {
  it("includes plain modules unchanged in the registry", async ({
    convexDir,
    writeModule,
  }) => {
    await writeModule(
      "messages.ts",
      `import { query } from "./_generated/server";\nexport const list = query({});\n`,
    );

    const result = await runCodegen({
      convexDir,
      outFile: outFileFor(convexDir),
    });

    expect(result.modulesIncluded).toEqual(["messages"]);
    expect(result.modulesStripped).toEqual([]);
    expect(result.modulesExcluded).toEqual([]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain("messages: () => import(");
    expect(generated).toContain("../messages");
  });

  it("strips a mixed module to a companion and references it from the registry", async ({
    convexDir,
    writeModule,
  }) => {
    await writeModule(
      "billing.ts",
      remoteOnlyModule(
        `import { internalMutation, query } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        `export const list = query({});`,
        ``,
      ),
    );

    const result = await runCodegen({
      convexDir,
      outFile: outFileFor(convexDir),
    });

    expect(result.modulesIncluded).toEqual([]);
    expect(result.modulesStripped).toEqual(["billing"]);
    expect(result.modulesExcluded).toEqual([]);
    expect(result.companionFiles).toHaveLength(1);

    const companion = await readFile(result.companionFiles[0]!, "utf8");
    expect(companion).toContain("AUTO-GENERATED");
    expect(companion).toContain("export const list");
    expect(companion).not.toContain("chargeCard");
    expect(companion).not.toMatch(/import[^;]*\bremoteOnly\b/);
    expect(companion).not.toMatch(/=\s*remoteOnly\(/);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain('billing: () => import("./embedded/billing")');
  });

  it("excludes a fully-remoteOnly module from the registry entirely", async ({
    convexDir,
    writeModule,
  }) => {
    await writeModule(
      "secrets.ts",
      remoteOnlyModule(
        `import { internalMutation } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const fetch = remoteOnly(internalMutation({}));`,
        `export const rotate = remoteOnly(internalMutation({}));`,
        ``,
      ),
    );

    const result = await runCodegen({
      convexDir,
      outFile: outFileFor(convexDir),
    });

    expect(result.modulesExcluded).toEqual(["secrets"]);
    expect(result.modulesIncluded).toEqual([]);
    expect(result.modulesStripped).toEqual([]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).not.toContain("./secrets");
    expect(generated).not.toContain("./_generated/embedded/secrets");
  });

  it("preserves manifest routeModes for stripped exports", async ({
    convexDir,
    writeModule,
  }) => {
    await writeModule(
      "billing.ts",
      remoteOnlyModule(
        `import { internalMutation } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        ``,
      ),
    );

    const result = await runCodegen({
      convexDir,
      outFile: outFileFor(convexDir),
    });

    expect(result.modulesExcluded).toEqual(["billing"]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain('"billing:chargeCard": "remote"');
  });

  it("handles nested directories", async ({ convexDir, writeModule }) => {
    await writeModule(
      "billing/charge.ts",
      remoteOnlyModule(
        `import { internalMutation } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        ``,
      ),
    );
    await writeModule(
      "messages.ts",
      `import { query } from "./_generated/server";\nexport const list = query({});\n`,
    );

    const result = await runCodegen({
      convexDir,
      outFile: outFileFor(convexDir),
    });

    expect(result.modulesExcluded).toEqual(["billing/charge"]);
    expect(result.modulesIncluded).toEqual(["messages"]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain("messages: () => import(");
    expect(generated).not.toMatch(/import\(.*billing\/charge/);
    expect(generated).toContain('"billing/charge:chargeCard": "remote"');
  });

  it("strips a mixed module in a nested directory and emits the companion at the matching path", async ({
    convexDir,
    writeModule,
  }) => {
    await writeModule(
      "billing/index.ts",
      remoteOnlyModule(
        `import { internalMutation, query } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        `export const list = query({});`,
        ``,
      ),
    );

    const result = await runCodegen({
      convexDir,
      outFile: outFileFor(convexDir),
    });

    expect(result.modulesStripped).toEqual(["billing/index"]);
    expect(result.companionFiles[0]!).toContain("billing/index.ts");

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain(
      '"billing/index": () => import("./embedded/billing/index")',
    );
  });
});
