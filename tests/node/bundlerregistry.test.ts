import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "@tests/testkit";

import { api } from "../../convex/_generated/api";
import * as schema from "../../convex/schema";
import { DEMO_WORKSPACE_ID } from "../../convex/workspace";
import { generateEmbeddedRegistry } from "../../packages/convex-embedded/src/codegen/index";
import { getEmbeddedClientEntry } from "../../packages/convex-embedded/src/client/entry";
import {
  getRemoteState,
  subscribeRemoteState,
} from "../../packages/convex-embedded/src/client/remote";
import { createConvexClient } from "../../packages/convex-embedded/src/node/index";
import { openNodeStorage } from "../../packages/convex-embedded/src/node/sqlite/adapter";
import { extractEmbeddedTableDefinitions } from "../../packages/convex-embedded/src/shared/schema";
import { temporaryDatabasePath, uniqueSuffix } from "../helpers/storage";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const CONVEX_URL = process.env.CONVEX_URL;

function waitForResolved(
  client: Parameters<typeof getRemoteState>[0],
  timeoutMs = 20_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const current = getRemoteState(client);
    if (current.status === "resolved") {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Timed out waiting for resolved. Last status: ${getRemoteState(client).status}`,
        ),
      );
    }, timeoutMs);

    const unsubscribe = subscribeRemoteState(client, (status) => {
      if (status.status !== "resolved") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

async function pollLocalTable(
  client: ReturnType<typeof createConvexClient>,
  tableName: string,
  timeoutMs = 15_000,
): Promise<Array<Record<string, unknown>>> {
  const entry = getEmbeddedClientEntry(client);
  if (!entry) throw new Error("missing embedded runtime entry");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const docs = await entry.runtime.getDocumentsForTable(tableName);
    if (docs.length > 0) return docs as Array<Record<string, unknown>>;
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
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
      } catch {}
    }
  });

  it("produces a manifest with tables and routeModes", async () => {
    const { convex } = (await import(outFile)) as {
      convex: {
        modules: Record<string, () => Promise<unknown>>;
        manifest?: {
          remote?: {
            routeModes?: Record<string, string>;
            tables?: Record<string, unknown>;
          };
        };
      };
    };

    expect(convex.manifest?.remote?.tables).toBeDefined();
    const tables = Object.keys(convex.manifest!.remote!.tables!);
    expect(tables).toEqual(
      expect.arrayContaining(["projects", "issues", "comments"]),
    );

    const routeModes = convex.manifest!.remote!.routeModes!;
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
  let convexInput: any;
  let userTableSpecs: Map<string, any> | undefined;

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

    const { convex } = (await import(outFile)) as { convex: any };
    convexInput = convex;

    const client = createConvexClient({
      convex,
      schema,
      name,
      databasePath,
      remote: { url: CONVEX_URL! },
    });

    await waitForResolved(client);

    await pollLocalTable(client, "projects");

    const projects = (await client.query(api.projects.list, {
      workspaceId: DEMO_WORKSPACE_ID,
    })) as Array<{ _id: string }>;

    const projectsToLoad = projects.slice(0, 2);
    for (const project of projectsToLoad) {
      await client.query(api.issues.allForProject, {
        projectId: project._id,
      });

      const entry = getEmbeddedClientEntry(client)!;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const docs = (await entry.runtime.getDocumentsForTable(
          "issues",
        )) as Array<Record<string, unknown>>;
        const forProject = docs.filter((d) => d.projectId === project._id);
        if (forProject.length > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const entry = getEmbeddedClientEntry(client);
    userTableSpecs = entry?.runtime.getUserTableSpecs() ?? undefined;

    await (client as { close(): Promise<void> }).close();
  }, 60_000);

  afterAll(() => {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch {}
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

  it("a fresh client reads from sqlite without remote", async () => {
    const name = uniqueSuffix("bundler-offline-read");

    const offlineClient = createConvexClient({
      convex: convexInput,
      schema,
      name,
      databasePath,
    });

    const projects = (await offlineClient.query(api.projects.list, {
      workspaceId: DEMO_WORKSPACE_ID,
    })) as Array<{ _id: string; name: string }>;

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

    await (offlineClient as { close(): Promise<void> }).close();
  });
});
