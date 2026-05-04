import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "@tests/testkit";

import { collectRemoteManifest } from "../../packages/convex-embedded/src/manifest";

describe("cli manifest generation", () => {
  let convexRoot: string;

  beforeEach(async () => {
    convexRoot = await mkdtemp(path.join(tmpdir(), "convex-embedded-cli-"));
    await mkdir(path.join(convexRoot, "nested"), { recursive: true });
  });

  it("preserves nested relative schema imports and actual embedded table names", async () => {
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

  it("emits a resolve-only entry even when multiple table queries are defined", async () => {
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
