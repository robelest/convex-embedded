import { afterEach, describe, expect, it } from "@tests/testkit";

import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { DEMO_WORKSPACE_ID } from "../../convex/workspace";
import { getEmbeddedClientEntry } from "../../packages/convex-embedded/src/client/entry";
import { SystemPaths } from "../../packages/convex-embedded/src/index";
import { createConvexClient } from "../../packages/convex-embedded/src/node/index";
import {
  createLiveModules,
  temporaryDatabasePath,
  uniqueSuffix,
} from "../helpers/live";

const clientsToClose: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const client of clientsToClose.splice(0)) {
    await client.close();
  }
});

async function runLocalSystemMutation(
  client: Awaited<ReturnType<typeof createConvexClient>> & {
    close(): Promise<void>;
  },
  path: string,
  args: Record<string, unknown>,
) {
  const runtime = getEmbeddedClientEntry(client)?.runtime;
  if (!runtime) {
    throw new Error(
      "[convex-embedded] missing embedded runtime entry for client",
    );
  }
  return await runtime.executeLocal({
    kind: "mutation",
    path,
    args,
    applyLocalEffects: true,
  });
}

describe("node platform persistence", () => {
  it("persists local runtime state across client restarts", async () => {
    const name = uniqueSuffix("node-persist");
    const databasePath = temporaryDatabasePath(name);

    const firstClient = createConvexClient({
      convex: { modules: createLiveModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(firstClient as { close(): Promise<void> });

    const projectId = await firstClient.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: `Node Persist ${name}`,
      identifier: name.slice(-6).toUpperCase(),
      description: `Node persistence ${name}`,
    });
    const issueId = await firstClient.mutation(api.issues.create, {
      projectId,
      title: `Issue ${name}`,
    });

    await firstClient.close();
    clientsToClose.length = 0;

    const secondClient = createConvexClient({
      convex: { modules: createLiveModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(secondClient as { close(): Promise<void> });

    const result = (await secondClient.query(api.issues.forProject, {
      projectId,
    })) as {
      issues: Array<{ _id: string; title: string }>;
    };

    expect(result.issues).toEqual(
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
    const pendingCount = 120;

    const firstClient = createConvexClient({
      convex: { modules: createLiveModules() },
      schema,
      name,
      databasePath,
    });
    clientsToClose.push(firstClient as { close(): Promise<void> });

    for (let index = 0; index < pendingCount; index += 1) {
      await runLocalSystemMutation(
        firstClient as Awaited<ReturnType<typeof createConvexClient>> & {
          close(): Promise<void>;
        },
        SystemPaths.pendingPush,
        {
          ref: "issues:update",
          args: JSON.stringify({
            issueId: `fake-issue-${index}`,
            title: `${name}-${index}`,
          }),
          localResult: JSON.stringify(null),
          table: "issues",
          payloadVersion: 1,
        },
      );
    }

    const firstRuntime = getEmbeddedClientEntry(firstClient)?.runtime;
    if (!firstRuntime) {
      throw new Error(
        "[convex-embedded] missing embedded runtime entry for client",
      );
    }
    expect(
      await firstRuntime.getDocumentsForTable("_resolve_pending"),
    ).toHaveLength(pendingCount);

    await firstClient.close();
    clientsToClose.length = 0;

    const secondClient = createConvexClient({
      convex: { modules: createLiveModules() },
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
    const persistedPending =
      await runtime.getDocumentsForTable("_resolve_pending");

    expect(persistedPending).toHaveLength(pendingCount);
    expect(
      persistedPending.every(
        (entry) => (entry as { table?: string }).table === "issues",
      ),
    ).toBe(true);
    expect(
      persistedPending.some((entry) =>
        String((entry as { args?: string }).args).includes(
          `${name}-${pendingCount - 1}`,
        ),
      ),
    ).toBe(true);
  });

  it("does not duplicate projects in list after issue creation updates the project", async () => {
    const name = uniqueSuffix("node-project-dedupe");
    const databasePath = temporaryDatabasePath(name);

    const client = createConvexClient({
      convex: { modules: createLiveModules() },
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
