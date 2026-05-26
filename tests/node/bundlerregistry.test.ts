import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import type { ConvexInput } from "@embedded/kernel/modules";
import type { InternalTableSpec } from "@embedded/storage/sqlite/factory";
import { afterAll, beforeAll, describe, expect, it, vi } from "@tests/testkit";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import * as schema from "../../convex/schema";
import { getEmbeddedClientEntry } from "../../packages/convex-embedded/src/client/entry";
import { getRemoteState } from "../../packages/convex-embedded/src/client/remote";
import { generateEmbeddedRegistry } from "../../packages/convex-embedded/src/codegen/index";
import { createConvexClient } from "../../packages/convex-embedded/src/node/index";
import { openNodeStorage } from "../../packages/convex-embedded/src/node/sqlite/adapter";
import { extractEmbeddedTableDefinitions } from "../../packages/convex-embedded/src/shared/schema";
import { temporaryDatabasePath, uniqueSuffix } from "../helpers/storage";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CONVEX_URL = process.env.CONVEX_URL;

type ConvexClientLike = Parameters<typeof getRemoteState>[0];
type EmbeddedClient = ReturnType<typeof createConvexClient>;

async function waitForResolved(client: ConvexClientLike): Promise<void> {
  await vi.waitFor(
    () => {
      const { status } = getRemoteState(client);
      if (status !== "resolved") {
        throw new Error(`not resolved yet, last status: ${status}`);
      }
    },
    { timeout: 20_000, interval: 100 },
  );
}

async function pollLocalTable(
  client: EmbeddedClient,
  tableName: string,
): Promise<Array<Record<string, unknown>>> {
  const entry = getEmbeddedClientEntry(client);
  if (!entry) throw new Error("missing embedded runtime entry");

  return vi.waitFor(
    async () => {
      const docs = (await entry.runtime.getDocumentsForTable(
        tableName,
      )) as Array<Record<string, unknown>>;
      if (docs.length === 0) throw new Error(`no rows in ${tableName} yet`);
      return docs;
    },
    { timeout: 15_000, interval: 200 },
  );
}

const runWhenRemote = CONVEX_URL ? describe : describe.skip;

describe("codegen manifest", () => {
  let outFile: string;
  let outDir: string;

  beforeAll(async () => {
    const name = uniqueSuffix("bundler-codegen");
    outDir = path.join(PROJECT_ROOT, "tmp", name);
    mkdirSync(outDir, { recursive: true });
    outFile = path.join(outDir, "embedded.ts");
    await generateEmbeddedRegistry({
      convexDir: "./convex",
      outFile: path.relative(PROJECT_ROOT, outFile),
      cwd: PROJECT_ROOT,
    });
  });

  afterAll(() => {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("produces a manifest with tables and routeModes", async () => {
    const { convex } = (await import(outFile)) as { convex: ConvexInput };

    const tablesManifest = convex.manifest?.remote?.tables;
    expect(tablesManifest).toBeDefined();
    expect(Object.keys(tablesManifest ?? {})).toEqual(
      expect.arrayContaining(["projects", "issues", "comments"]),
    );

    const routeModes = convex.manifest?.remote?.routeModes ?? {};
    expect(routeModes["agent:summarizeIssue"]).toBe("remote");
    expect(routeModes["agent:summarizeProject"]).toBe("remote");
  });

  it("namespace schema import yields embedded table definitions", () => {
    const definitions = extractEmbeddedTableDefinitions(schema);
    expect(definitions.size).toBe(3);
    expect(definitions.has("projects")).toBe(true);
    expect(definitions.has("issues")).toBe(true);
    expect(definitions.has("comments")).toBe(true);
  });

  it("default-only schema import loses embedded table definitions", async () => {
    const defaultOnly = (await import("../../convex/schema")).default;
    const definitions = extractEmbeddedTableDefinitions(defaultOnly);
    expect(definitions.size).toBe(0);
  });
});

runWhenRemote("bundler registry syncs remote data into local sqlite", () => {
  let outDir: string;
  let databasePath: string;
  let convexInput: ConvexInput;
  let userTableSpecs: Map<string, InternalTableSpec> | undefined;

  beforeAll(async () => {
    const name = uniqueSuffix("bundler-live");
    outDir = path.join(PROJECT_ROOT, "tmp", name);
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "embedded.ts");
    databasePath = temporaryDatabasePath(name);

    await generateEmbeddedRegistry({
      convexDir: "./convex",
      outFile: path.relative(PROJECT_ROOT, outFile),
      cwd: PROJECT_ROOT,
    });

    const { convex } = (await import(outFile)) as { convex: ConvexInput };
    convexInput = convex;

    const client = createConvexClient({
      convex,
      schema,
      name,
      databasePath,
      remote: { url: CONVEX_URL! },
    });

    await waitForResolved(client);

    const unsubProjects = client.onUpdate(api.projects.list, {}, () => {});
    await pollLocalTable(client, "projects");

    const projects = (await client.query(api.projects.list, {})) as Array<{
      _id: Id<"projects">;
    }>;

    for (const project of projects.slice(0, 2)) {
      const unsubIssues = client.onUpdate(
        api.issues.allForProject,
        { projectId: project._id },
        () => {},
      );

      const entry = getEmbeddedClientEntry(client)!;
      await vi.waitFor(
        async () => {
          const docs = (await entry.runtime.getDocumentsForTable(
            "issues",
          )) as Array<Record<string, unknown>>;
          const forProject = docs.filter((d) => d.projectId === project._id);
          if (forProject.length === 0) {
            throw new Error("issues for project not synced yet");
          }
        },
        { timeout: 15_000, interval: 200 },
      );

      unsubIssues();
    }

    userTableSpecs =
      getEmbeddedClientEntry(client)?.runtime.getUserTableSpecs() ?? undefined;

    unsubProjects();
    await client.close();
  }, 60_000);

  afterAll(() => {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("projects are persisted in sqlite", async () => {
    const storage = await openNodeStorage({
      filename: databasePath,
      userTableSpecs,
    });
    const docs = (await storage.getDocuments("projects")) as Array<
      Record<string, unknown>
    >;
    await storage.close();

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toHaveProperty("_id");
    expect(docs[0]).toHaveProperty("name");
  });

  it("issues are persisted in sqlite", async () => {
    const storage = await openNodeStorage({
      filename: databasePath,
      userTableSpecs,
    });
    const docs = (await storage.getDocuments("issues")) as Array<
      Record<string, unknown>
    >;
    await storage.close();

    expect(docs.length).toBeGreaterThan(0);
    expect(docs[0]).toHaveProperty("_id");
    expect(docs[0]).toHaveProperty("projectId");
    expect(docs[0]).toHaveProperty("title");
  });

  it("a fresh client reads from sqlite without remote", async ({ track }) => {
    const name = uniqueSuffix("bundler-offline-read");

    const offlineClient = createConvexClient({
      convex: convexInput,
      schema,
      name,
      databasePath,
    });
    track({ close: () => offlineClient.close() });

    const projects = (await offlineClient.query(
      api.projects.list,
      {},
    )) as Array<{
      _id: Id<"projects">;
      name: string;
    }>;

    expect(projects.length).toBeGreaterThan(0);

    let totalIssues = 0;
    for (const project of projects.slice(0, 2)) {
      const issues = (await offlineClient.query(api.issues.allForProject, {
        projectId: project._id,
      })) as Array<{ _id: string; projectId: string }>;
      expect(issues.every((i) => i.projectId === project._id)).toBe(true);
      totalIssues += issues.length;
    }
    expect(totalIssues).toBeGreaterThan(0);
  });
});
