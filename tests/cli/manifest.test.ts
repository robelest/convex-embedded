import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { collectRemoteManifest } from "@embedded/codegen/manifest";
import { describe, expect, it as base } from "@tests/testkit";

const it = base.extend<{ convexRoot: string }>({
  convexRoot: async ({ onTestFinished }, use) => {
    const root = await mkdtemp(path.join(tmpdir(), "convex-embedded-cli-"));
    await mkdir(path.join(root, "nested"), { recursive: true });
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await use(root);
  },
});

describe("codegen manifest generation", () => {
  it("preserves nested relative schema imports and actual embedded table names", async ({
    convexRoot,
  }) => {
    await writeFile(
      path.join(convexRoot, "nested", "schema.ts"),
      `
import { embeddedTable } from "@robelest/convex-embedded/server/table";
export const taskTable = embeddedTable("tasks", {});
`,
      "utf8",
    );

    const manifest = await collectRemoteManifest({
      convexRoot,
      moduleId: "features/tasks",
      source: `
import { bindTable } from "@robelest/convex-embedded/server";
import { taskTable as taskBinding } from "../nested/schema";

export const bind = bindTable(taskBinding);
export const list = taskBinding.query({ args: {}, handler: async () => [] });
`,
    });

    expect(manifest.tables).toEqual({
      tasks: {
        resolve: "features/tasks:bind",
        schemaModule: "nested/schema",
        schemaExport: "taskTable",
      },
    });
  });

  it("emits a single resolve-only entry even with multiple table queries", async ({
    convexRoot,
  }) => {
    await writeFile(
      path.join(convexRoot, "schema.ts"),
      `
import { embeddedTable } from "@robelest/convex-embedded/server/table";
export const tasks = embeddedTable("tasks", {});
`,
      "utf8",
    );

    const manifest = await collectRemoteManifest({
      convexRoot,
      moduleId: "tasks",
      source: `
import { bindTable } from "@robelest/convex-embedded/server";
import { tasks } from "./schema";

export const bind = bindTable(tasks);
export const listMine = tasks.query({ args: {}, handler: async () => [] });
export const list = tasks.query({ args: {}, handler: async () => [] });
`,
    });

    expect(manifest.tables).toEqual({
      tasks: {
        resolve: "tasks:bind",
        schemaModule: "schema",
        schemaExport: "tasks",
      },
    });
  });
});
