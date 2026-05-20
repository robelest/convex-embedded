import { afterEach, describe, expect, it } from "@tests/testkit";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { DEMO_WORKSPACE_ID } from "../../convex/workspace";
import { getEmbeddedClientEntry } from "../../packages/convex-embedded/src/client/entry";
import { createConvexClient } from "../../packages/convex-embedded/src/node/index";
import { openNodeStorage } from "../../packages/convex-embedded/src/node/sqlite/adapter";
import { createAppModules } from "../helpers/convex";
import { temporaryDatabasePath, uniqueSuffix } from "../helpers/storage";

const clientsToClose: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const client of clientsToClose.splice(0)) {
    await client.close();
  }
});

describe("node platform storage", () => {
  it("persists local runtime state across client restarts", async () => {
    const name = uniqueSuffix("node-persist");
    const databasePath = temporaryDatabasePath(name);

    const firstClient = createConvexClient({
      convex: { modules: createAppModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(firstClient as { close(): Promise<void> });

    await firstClient.query(api.projects.list, {
      workspaceId: DEMO_WORKSPACE_ID,
    });

    const projectId = await firstClient.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: `Node Persist ${name}`,
      identifier: name.slice(-6).toUpperCase(),
      description: `Node storage ${name}`,
    });
    const issueId = await firstClient.mutation(api.issues.create, {
      projectId,
      title: `Issue ${name}`,
    });

    await firstClient.close();
    clientsToClose.length = 0;

    const secondClient = createConvexClient({
      convex: { modules: createAppModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(secondClient as { close(): Promise<void> });

    const issues = (await secondClient.query(api.issues.allForProject, {
      projectId,
    })) as Array<{ _id: string; title: string }>;

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: issueId,
          title: `Issue ${name}`,
        }),
      ]),
    );
  });

  it("reloads a larger persisted local dataset after restart", async () => {
    const name = uniqueSuffix("node-volume");
    const databasePath = temporaryDatabasePath(name);
    const projectCount = 100;

    const firstClient = createConvexClient({
      convex: { modules: createAppModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(firstClient as { close(): Promise<void> });

    for (let index = 0; index < projectCount; index += 1) {
      await firstClient.mutation(api.projects.create, {
        workspaceId: DEMO_WORKSPACE_ID,
        name: `Node Volume ${name}-${index}`,
        identifier: `V${String(index).padStart(5, "0")}`,
        description: `Node volume ${name}-${index}`,
      });
    }

    await firstClient.close();
    clientsToClose.length = 0;

    const secondClient = createConvexClient({
      convex: { modules: createAppModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(secondClient as { close(): Promise<void> });

    const runtime = getEmbeddedClientEntry(secondClient)?.runtime;
    if (!runtime) {
      throw new Error(
        "[convex-embedded] missing embedded runtime entry for client",
      );
    }
    const hydratedProjects = await runtime.getDocumentsForTable("projects");
    const userTableSpecs = runtime.getUserTableSpecs() ?? undefined;
    await secondClient.close();
    clientsToClose.length = 0;

    const storage = await openNodeStorage({
      filename: databasePath,
      userTableSpecs,
    });
    const persistedProjects = (await storage.getDocuments("projects")) as Array<
      Record<string, unknown>
    >;
    await storage.close();
    expect(
      hydratedProjects
        .filter(
          (entry) =>
            (entry as { groupId?: string }).groupId === DEMO_WORKSPACE_ID,
        )
        .filter((entry) =>
          String((entry as { name?: string }).name).startsWith(
            `Node Volume ${name}-`,
          ),
        ).length,
    ).toBeGreaterThan(0);
    expect(
      persistedProjects
        .filter(
          (entry) =>
            (entry as { groupId?: string }).groupId === DEMO_WORKSPACE_ID,
        )
        .filter((entry) =>
          String((entry as { name?: string }).name).startsWith(
            `Node Volume ${name}-`,
          ),
        ).length,
    ).toBeGreaterThanOrEqual(projectCount - 2);
    expect(persistedProjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: DEMO_WORKSPACE_ID,
          name: `Node Volume ${name}-${projectCount - 1}`,
        }),
      ]),
    );
  });

  it("does not duplicate projects in list after issue creation updates the project", async () => {
    const name = uniqueSuffix("node-project-dedupe");
    const databasePath = temporaryDatabasePath(name);

    const client = createConvexClient({
      convex: { modules: createAppModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(client as { close(): Promise<void> });

    const projectId = await client.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: `Node Project ${name}`,
      identifier: name.slice(-6).toUpperCase(),
      description: `Node project ${name}`,
    });

    await client.mutation(api.issues.create, {
      projectId,
      title: `Issue ${name}`,
    });

    const projects = (await client.query(api.projects.list, {
      workspaceId: DEMO_WORKSPACE_ID,
    })) as Array<{
      _id: string;
      groupId: string;
      openIssueCount: number;
    }>;

    const matchingProjects = projects.filter(
      (project) =>
        project.groupId === DEMO_WORKSPACE_ID && project._id === projectId,
    );
    expect(matchingProjects).toHaveLength(1);
    expect(matchingProjects[0]?.openIssueCount).toBe(1);
  });
});
