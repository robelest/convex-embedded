#!/usr/bin/env node

import { Clerc, SingleCommand } from "clerc";

import { runCodegen } from "@/cli/codegen";
import { watchCodegen } from "@/cli/watch";

const DEFAULT_CONVEX_DIR = "./convex";
const DEFAULT_OUT_FILE = "./convex/_generated/embedded.ts";

function logResult(prefix: string, result: {
  modulesIncluded: string[];
  modulesStripped: string[];
  modulesExcluded: string[];
}): void {
  const parts: string[] = [];
  parts.push(`${result.modulesIncluded.length} included`);
  if (result.modulesStripped.length > 0) {
    parts.push(`${result.modulesStripped.length} stripped`);
  }
  if (result.modulesExcluded.length > 0) {
    parts.push(`${result.modulesExcluded.length} excluded`);
  }
  // eslint-disable-next-line no-console
  console.log(`${prefix} ${parts.join(", ")}`);
}

Clerc.create()
  .name("convex-embedded")
  .description("Generate the embedded module registry from convex/")
  .version("0.0.1")
  .command(SingleCommand, "Generate the embedded module registry from convex/", {
    flags: {
      "convex-dir": {
        type: String,
        description: "Path to the Convex source directory",
        default: DEFAULT_CONVEX_DIR,
      },
      out: {
        type: String,
        description:
          "Path to the generated registry file (defaults to convex/_generated/embedded.ts)",
        default: DEFAULT_OUT_FILE,
      },
      watch: {
        type: Boolean,
        description: "Re-run codegen on convex/ file changes",
        default: false,
      },
    },
  })
  .on(
    SingleCommand,
    async (ctx: {
      flags: {
        "convex-dir": string;
        out: string;
        watch: boolean;
      };
    }) => {
      const input = {
        convexDir: ctx.flags["convex-dir"],
        outFile: ctx.flags.out,
      };

      if (ctx.flags.watch) {
        await watchCodegen({
          ...input,
          onResult: (result) => logResult("regenerated:", result),
          onError: (err) => {
            // eslint-disable-next-line no-console
            console.error("[convex-embedded] codegen failed:", err);
          },
        });
        // eslint-disable-next-line no-console
        console.log(`watching ${input.convexDir} (Ctrl+C to stop)`);
        return;
      }

      const result = await runCodegen(input);
      logResult(`generated ${input.outFile}:`, result);
    },
  )
  .parse();
