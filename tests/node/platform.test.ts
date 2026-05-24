import { describe, expect, it } from "@tests/testkit";
import type { TestFixtures } from "@tests/testkit";

import { api } from "../../convex/_generated/api";
import { GROUP_ID } from "../../convex/access";
import schema from "../../convex/schema";
import { getEmbeddedClientEntry } from "../../packages/convex-embedded/src/client/entry";
import { createConvexClient } from "../../packages/convex-embedded/src/node/index";
import { openNodeStorage } from "../../packages/convex-embedded/src/node/sqlite/adapter";
import { createAppModules } from "../helpers/convex";
import { temporaryDatabasePath, uniqueSuffix } from "../helpers/storage";

function makeClient(
  track: TestFixtures["track"],
  name: string,
  databasePath: string,
): ReturnType<typeof createConvexClient> {
  const client = createConvexClient({
    convex: { modules: createAppModules() },
    schema,
    name,
    databasePath,
  });
  track({ close: () => client.close() });
  return client;
}

describe("node platform storage", () => {
  it("persists local runtime state across client restarts", async ({
    track,
  }) => {
    const name = uniqueSuffix("node-persist");
    const databasePath = temporaryDatabasePath(name);

    const firstClient = makeClient(track, name, databasePath);

    await firstClient.query(api.projects.list, {});

    const projectId = await firstClient.mutation(api.projects.create, {
      name: `Node Persist ${name}`,
      identifier: name.slice(-6).toUpperCase(),
      description: `Node storage ${name}`,
    });
    const issueId = await firstClient.mutation(api.issues.create, {
      projectId,
      title: `Issue ${name}`,
    });

    await firstClient.close();

    const secondClient = makeClient(track, name, databasePath);

    const issues = (await secondClient.query(api.issues.allForProject, {
      projectId,
    })) as Array<{ _id: string; title: string }>;

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ _id: issueId, title: `Issue ${name}` }),
      ]),
    );
  });

  it("reloads a larger persisted local dataset after restart", async ({
    track,
  }) => {
    const name = uniqueSuffix("node-volume");
    const databasePath = temporaryDatabasePath(name);
    const projectCount = 100;

    const firstClient = makeClient(track, name, databasePath);

    for (let index = 0; index < projectCount; index += 1) {
      await firstClient.mutation(api.projects.create, {
        name: `Node Volume ${name}-${index}`,
        identifier: `V${String(index).padStart(5, "0")}`,
        description: `Node volume ${name}-${index}`,
      });
    }

    await firstClient.close();

    const secondClient = makeClient(track, name, databasePath);

    const runtime = getEmbeddedClientEntry(secondClient)?.runtime;
    if (!runtime) {
      throw new Error(
        "[convex-embedded] missing embedded runtime entry for client",
      );
    }
    const hydratedProjects = await runtime.getDocumentsForTable("projects");
    const userTableSpecs = runtime.getUserTableSpecs() ?? undefined;
    await secondClient.close();

    const storage = await openNodeStorage({
      filename: databasePath,
      userTableSpecs,
    });
    const persistedProjects = (await storage.getDocuments("projects")) as Array<
      Record<string, unknown>
    >;
    await storage.close();

    const matchesName = (entry: Record<string, unknown>): boolean =>
      (entry as { groupId?: string }).groupId === GROUP_ID &&
      String((entry as { name?: string }).name).startsWith(
        `Node Volume ${name}-`,
      );

    expect(hydratedProjects.filter(matchesName).length).toBeGreaterThan(0);
    expect(persistedProjects.filter(matchesName).length).toBeGreaterThanOrEqual(
      projectCount - 2,
    );
    expect(persistedProjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: GROUP_ID,
          name: `Node Volume ${name}-${projectCount - 1}`,
        }),
      ]),
    );
  });

  it("does not duplicate projects in list after issue creation updates the project", async ({
    track,
  }) => {
    const name = uniqueSuffix("node-project-dedupe");
    const databasePath = temporaryDatabasePath(name);

    const client = makeClient(track, name, databasePath);

    const projectId = await client.mutation(api.projects.create, {
      name: `Node Project ${name}`,
      identifier: name.slice(-6).toUpperCase(),
      description: `Node project ${name}`,
    });

    await client.mutation(api.issues.create, {
      projectId,
      title: `Issue ${name}`,
    });

    const projects = (await client.query(api.projects.list, {})) as Array<{
      _id: string;
      groupId: string;
      openIssueCount: number;
    }>;

    const matchingProjects = projects.filter(
      (project) => project.groupId === GROUP_ID && project._id === projectId,
    );
    expect(matchingProjects).toHaveLength(1);
    expect(matchingProjects[0]?.openIssueCount).toBe(1);
  });
});
