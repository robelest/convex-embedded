#!/usr/bin/env node

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Clerc } from "clerc";

import {
  collectRemoteManifest,
  renderGeneratedFile,
  toModuleId,
  type GeneratedRemoteManifest,
} from "@/manifest";

async function listTsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry: Dirent) => {
      const next = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_generated") {
          return [] as string[];
        }
        return listTsFiles(next);
      }
      if (!entry.isFile()) {
        return [] as string[];
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
        return [] as string[];
      }
      if (entry.name.endsWith(".d.ts")) {
        return [] as string[];
      }
      return [next];
    }),
  );
  return files.flat().sort();
}

async function generate(convexDir: string, out: string): Promise<void> {
  const cwd = process.cwd();
  const convexRoot = path.resolve(cwd, convexDir);
  const outFile = path.resolve(cwd, out);
  const files = (await listTsFiles(convexRoot)).filter(
    (filePath) => path.resolve(filePath) !== outFile,
  );
  const moduleFiles: string[] = [];
  const manifest: GeneratedRemoteManifest = {
    routeModes: {},
    tables: {},
  };

  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    moduleFiles.push(filePath);
    const remote = await collectRemoteManifest({
      convexRoot,
      moduleId: toModuleId(convexRoot, filePath),
      source,
    });
    Object.assign(manifest.routeModes, remote.routeModes);
    Object.assign(manifest.tables, remote.tables);
    manifest.uploadUrl ??= remote.uploadUrl;
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    renderGeneratedFile({
      outFile,
      moduleFiles,
      convexDir: convexRoot,
      manifest,
    }),
    "utf8",
  );

  console.log(`generated ${out}`);
}

Clerc.create()
  .name("convex-embedded")
  .version("0.0.1")
  .command("", "Generate convex modules and manifest", {
    flags: {
      "convex-dir": {
        type: String,
        description: "Path to the Convex source directory",
        default: "./convex",
      },
      out: {
        type: String,
        description: "Path to the generated convex modules file",
        default: "./convex/embedded.modules.ts",
      },
    },
  })
  .on("", async (ctx: { flags: { "convex-dir": string; out: string } }) => {
    await generate(ctx.flags["convex-dir"], ctx.flags.out);
  })
  .parse();
