import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodegen } from "@embedded/codegen";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";

let workDir: string;

async function writeFileEnsured(filePath: string, contents: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "convex-embedded-codegen-"));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {}
});

describe("runCodegen", () => {
  it("includes plain modules unchanged in the registry", async () => {
    const convexDir = path.join(workDir, "convex");
    await writeFileEnsured(
      path.join(convexDir, "messages.ts"),
      `import { query } from "./_generated/server";\nexport const list = query({});\n`,
    );

    const result = await runCodegen({
      convexDir,
      outFile: path.join(convexDir, "_generated/embedded.ts"),
    });

    expect(result.modulesIncluded).toEqual(["messages"]);
    expect(result.modulesStripped).toEqual([]);
    expect(result.modulesExcluded).toEqual([]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain("messages: () => import(");
    expect(generated).toContain("../messages");
  });

  it("strips a mixed module to a companion and references it from the registry", async () => {
    const convexDir = path.join(workDir, "convex");
    await writeFileEnsured(
      path.join(convexDir, "billing.ts"),
      [
        `import { internalMutation, query } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        `export const list = query({});`,
        ``,
      ].join("\n"),
    );

    const result = await runCodegen({
      convexDir,
      outFile: path.join(convexDir, "_generated/embedded.ts"),
    });

    expect(result.modulesIncluded).toEqual([]);
    expect(result.modulesStripped).toEqual(["billing"]);
    expect(result.modulesExcluded).toEqual([]);
    expect(result.companionFiles).toHaveLength(1);

    const companion = await readFile(result.companionFiles[0]!, "utf8");
    expect(companion).toContain("AUTO-GENERATED");
    expect(companion).toContain("export const list");
    expect(companion).not.toContain("chargeCard");
    // No `remoteOnly` import or call should remain in the companion
    expect(companion).not.toMatch(/import[^;]*\bremoteOnly\b/);
    expect(companion).not.toMatch(/=\s*remoteOnly\(/);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain('billing: () => import("./embedded/billing")');
  });

  it("excludes a fully-remoteOnly module from the registry entirely", async () => {
    const convexDir = path.join(workDir, "convex");
    await writeFileEnsured(
      path.join(convexDir, "secrets.ts"),
      [
        `import { internalMutation } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const fetch = remoteOnly(internalMutation({}));`,
        `export const rotate = remoteOnly(internalMutation({}));`,
        ``,
      ].join("\n"),
    );

    const result = await runCodegen({
      convexDir,
      outFile: path.join(convexDir, "_generated/embedded.ts"),
    });

    expect(result.modulesExcluded).toEqual(["secrets"]);
    expect(result.modulesIncluded).toEqual([]);
    expect(result.modulesStripped).toEqual([]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).not.toContain("./secrets");
    expect(generated).not.toContain("./_generated/embedded/secrets");
  });

  it("preserves manifest routeModes for stripped exports", async () => {
    const convexDir = path.join(workDir, "convex");
    await writeFileEnsured(
      path.join(convexDir, "billing.ts"),
      [
        `import { internalMutation } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        ``,
      ].join("\n"),
    );

    const result = await runCodegen({
      convexDir,
      outFile: path.join(convexDir, "_generated/embedded.ts"),
    });

    expect(result.modulesExcluded).toEqual(["billing"]);
    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain('"billing:chargeCard": "remote"');
  });

  it("handles nested directories", async () => {
    const convexDir = path.join(workDir, "convex");
    await writeFileEnsured(
      path.join(convexDir, "billing/charge.ts"),
      [
        `import { internalMutation } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        ``,
      ].join("\n"),
    );
    await writeFileEnsured(
      path.join(convexDir, "messages.ts"),
      `import { query } from "./_generated/server";\nexport const list = query({});\n`,
    );

    const result = await runCodegen({
      convexDir,
      outFile: path.join(convexDir, "_generated/embedded.ts"),
    });

    expect(result.modulesExcluded).toEqual(["billing/charge"]);
    expect(result.modulesIncluded).toEqual(["messages"]);

    const generated = await readFile(result.outFile, "utf8");
    expect(generated).toContain("messages: () => import(");
    // billing/charge does not appear as an importable module, but its
    // routing entry is still recorded in the manifest
    expect(generated).not.toMatch(/import\(.*billing\/charge/);
    expect(generated).toContain('"billing/charge:chargeCard": "remote"');
  });

  it("strips a mixed module in a nested directory and emits the companion at the matching path", async () => {
    const convexDir = path.join(workDir, "convex");
    await writeFileEnsured(
      path.join(convexDir, "billing/index.ts"),
      [
        `import { internalMutation, query } from "./_generated/server";`,
        `import { remoteOnly } from "@robelest/convex-embedded";`,
        ``,
        `export const chargeCard = remoteOnly(internalMutation({}));`,
        `export const list = query({});`,
        ``,
      ].join("\n"),
    );

    const result = await runCodegen({
      convexDir,
      outFile: path.join(convexDir, "_generated/embedded.ts"),
    });

    expect(result.modulesStripped).toEqual(["billing/index"]);
    const companion = result.companionFiles[0]!;
    expect(companion).toContain("billing/index.ts");

    const generated = await readFile(result.outFile, "utf8");
    // outFile is at convex/_generated/embedded.ts; companion is at
    // convex/_generated/embedded/billing/index.ts; relative import is
    // "./embedded/billing/index"
    expect(generated).toContain(
      '"billing/index": () => import("./embedded/billing/index")',
    );
  });
});
