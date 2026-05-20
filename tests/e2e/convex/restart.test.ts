import { afterEach, describe, expect, it } from "@tests/testkit";

import { api } from "../../../convex/_generated/api";
import { DEMO_WORKSPACE_ID } from "../../../convex/workspace";
import { getEmbeddedClientEntry } from "../../../packages/convex-embedded/src/client/entry";
import { SystemPaths } from "../../../packages/convex-embedded/src/index";
import {
  createLiveClient,
  describeLiveClientState,
  pollUntil,
  temporaryDatabasePath,
  type TestConnectivityController,
  waitForMappedRemoteId,
  uniqueSuffix,
  waitForOffline,
  waitForResolved,
} from "./harness";

const CONVEX_URL = process.env.CONVEX_URL;
const maybeDescribe =
  CONVEX_URL && process.env.RUN_CONVEX_E2E === "1" ? describe : describe.skip;

type LiveClient = Awaited<ReturnType<typeof createLiveClient>>["client"] & {
  close(): Promise<void>;
};

async function runLocalSystemMutation(
  client: LiveClient,
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

maybeDescribe("live persisted restart", () => {
  const clientsToClose: LiveClient[] = [];
  const connectivities: TestConnectivityController[] = [];

  afterEach(async () => {
    for (const connectivity of connectivities.splice(0)) {
      connectivity.close();
    }
    for (const client of clientsToClose.splice(0)) {
      await client.close();
    }
  });

  it("replays persisted offline mutations after a client restart", async () => {
    const suffix = uniqueSuffix("persisted-restart");
    const databasePath = temporaryDatabasePath(suffix);

    const first = createLiveClient({
      name: suffix,
      remoteUrl: CONVEX_URL!,
      databasePath,
    });
    clientsToClose.push(first.client as LiveClient);
    connectivities.push(first.connectivity);

    await waitForResolved(first.client, 40_000);

    const projectId = await first.client.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: `Restart ${suffix}`,
      identifier: suffix.slice(-6).toUpperCase(),
      description: `Restart persistence ${suffix}`,
    });
    const canonicalProjectId = await waitForMappedRemoteId<
      import("../../../convex/_generated/dataModel").Id<"projects">
    >(first.client, projectId);
    const issueId = await first.client.mutation(api.issues.create, {
      projectId: canonicalProjectId,
      title: `Issue ${suffix}`,
    });
    const canonicalIssueId = await waitForMappedRemoteId<
      import("../../../convex/_generated/dataModel").Id<"issues">
    >(first.client, issueId);

    first.connectivity.setOnline(false);
    await waitForOffline(first.client, 40_000);

    await first.client.mutation(api.issues.update, {
      issueId: canonicalIssueId,
      status: "in_progress",
    });
    await first.client.mutation(api.comments.create, {
      issueId: canonicalIssueId,
      body: `persisted-comment-${suffix}`,
    });

    await first.client.close();
    clientsToClose.length = 0;

    const second = createLiveClient({
      name: suffix,
      remoteUrl: CONVEX_URL!,
      databasePath,
    });
    clientsToClose.push(second.client as LiveClient);
    connectivities.push(second.connectivity);

    await waitForResolved(second.client, 40_000);

    const issues = await pollUntil({
      description: `restarted client sees issue ${canonicalIssueId} in_progress`,
      read: async () =>
        (await second.client.query(api.issues.allForProject, {
          projectId: canonicalProjectId,
        })) as Array<{ _id: string; status: string }>,
      accept: (issues) =>
        issues.some(
          (issue) =>
            issue._id === canonicalIssueId && issue.status === "in_progress",
        ),
      diagnostics: () => describeLiveClientState(second.client),
      timeoutMs: 40_000,
      intervalMs: 250,
    });

    const comments = await pollUntil({
      description: `restarted client sees persisted comment for ${canonicalIssueId}`,
      read: async () =>
        (await second.client.query(api.comments.forIssue, {
          issueId: canonicalIssueId,
        })) as Array<{ body: string }>,
      accept: (result) =>
        result.some(
          (comment) => comment.body === `persisted-comment-${suffix}`,
        ),
      diagnostics: () => describeLiveClientState(second.client),
      timeoutMs: 40_000,
      intervalMs: 250,
    });

    expect(
      issues.some(
        (issue) =>
          issue._id === canonicalIssueId && issue.status === "in_progress",
      ),
    ).toBe(true);
    expect(
      comments.some(
        (comment) => comment.body === `persisted-comment-${suffix}`,
      ),
    ).toBe(true);
  }, 90_000);

  it("reclaims a persisted processing entry after restart when its owner is gone", async () => {
    const suffix = uniqueSuffix("persisted-processing");
    const databasePath = temporaryDatabasePath(suffix);

    const first = createLiveClient({
      name: suffix,
      remoteUrl: CONVEX_URL!,
      databasePath,
    });
    clientsToClose.push(first.client as LiveClient);
    connectivities.push(first.connectivity);

    await waitForResolved(first.client, 40_000);

    const projectId = await first.client.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: `Processing ${suffix}`,
      identifier: suffix.slice(-6).toUpperCase(),
      description: `Processing persistence ${suffix}`,
    });
    const canonicalProjectId = await waitForMappedRemoteId<
      import("../../../convex/_generated/dataModel").Id<"projects">
    >(first.client, projectId);
    const issueId = await first.client.mutation(api.issues.create, {
      projectId: canonicalProjectId,
      title: `Issue ${suffix}`,
    });
    const canonicalIssueId = await waitForMappedRemoteId<
      import("../../../convex/_generated/dataModel").Id<"issues">
    >(first.client, issueId);

    first.connectivity.setOnline(false);
    await waitForOffline(first.client, 40_000);

    await runLocalSystemMutation(
      first.client as LiveClient,
      SystemPaths.pendingPush,
      {
        ref: "issues:update",
        args: JSON.stringify({
          issueId: canonicalIssueId,
          status: "in_progress",
        }),
        localResult: JSON.stringify(null),
        table: "issues",
        payloadVersion: 1,
      },
    );
    await runLocalSystemMutation(
      first.client as LiveClient,
      SystemPaths.pendingClaimNext,
      {
        identityKey: null,
        owner: `dead-owner-${suffix}`,
        leaseMs: 60_000,
        processorStaleMs: 60_000,
      },
    );

    await first.client.close();
    clientsToClose.length = 0;

    const second = createLiveClient({
      name: suffix,
      remoteUrl: CONVEX_URL!,
      databasePath,
    });
    clientsToClose.push(second.client as LiveClient);
    connectivities.push(second.connectivity);

    await waitForResolved(second.client, 40_000);

    const issues = await pollUntil({
      description: `reclaimed client sees issue ${canonicalIssueId} in_progress`,
      read: async () =>
        (await second.client.query(api.issues.allForProject, {
          projectId: canonicalProjectId,
        })) as Array<{ _id: string; status: string }>,
      accept: (issues) =>
        issues.some(
          (issue) =>
            issue._id === canonicalIssueId && issue.status === "in_progress",
        ),
      diagnostics: () => describeLiveClientState(second.client),
      timeoutMs: 40_000,
      intervalMs: 250,
    });

    expect(
      issues.some(
        (issue) =>
          issue._id === canonicalIssueId && issue.status === "in_progress",
      ),
    ).toBe(true);
  }, 90_000);

  it("replays a larger persisted offline mutation batch after restart", async () => {
    const suffix = uniqueSuffix("persisted-volume");
    const databasePath = temporaryDatabasePath(suffix);
    const commentBodies = Array.from(
      { length: 18 },
      (_, index) => `persisted-volume-comment-${index}-${suffix}`,
    );

    const first = createLiveClient({
      name: suffix,
      remoteUrl: CONVEX_URL!,
      databasePath,
    });
    clientsToClose.push(first.client as LiveClient);
    connectivities.push(first.connectivity);

    await waitForResolved(first.client, 40_000);

    const projectId = await first.client.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: `Volume ${suffix}`,
      identifier: suffix.slice(-6).toUpperCase(),
      description: `Volume persistence ${suffix}`,
    });
    const canonicalProjectId = await waitForMappedRemoteId<
      import("../../../convex/_generated/dataModel").Id<"projects">
    >(first.client, projectId);
    const issueId = await first.client.mutation(api.issues.create, {
      projectId: canonicalProjectId,
      title: `Issue ${suffix}`,
    });
    const canonicalIssueId = await waitForMappedRemoteId<
      import("../../../convex/_generated/dataModel").Id<"issues">
    >(first.client, issueId);

    first.connectivity.setOnline(false);
    await waitForOffline(first.client, 40_000);

    for (const [index, body] of commentBodies.entries()) {
      await first.client.mutation(api.comments.create, {
        issueId: canonicalIssueId,
        body,
      });
      await first.client.mutation(api.issues.update, {
        issueId: canonicalIssueId,
        title: `Volume title ${index} ${suffix}`,
      });
    }
    await first.client.mutation(api.issues.update, {
      issueId: canonicalIssueId,
      status: "done",
      priority: "high",
    });

    const firstRuntime = getEmbeddedClientEntry(
      first.client as LiveClient,
    )?.runtime;
    if (!firstRuntime) {
      throw new Error(
        "[convex-embedded] missing embedded runtime entry for client",
      );
    }
    const pendingBeforeRestart =
      await firstRuntime.getDocumentsForTable("_resolve_pending");
    const localCommentsBeforeRestart =
      await firstRuntime.getDocumentsForTable("comments");
    const pendingCommentCreates = pendingBeforeRestart.filter(
      (entry) => entry.ref === "comments:create",
    );
    const pendingCreateLocalIds = pendingCommentCreates.map((entry) =>
      JSON.parse(String(entry.localResult)),
    );
    const matchingLocalComments = localCommentsBeforeRestart.filter((comment) =>
      commentBodies.includes(
        ((comment.body as any)?.content?.[0]?.content?.[0]?.text as
          | string
          | undefined) ?? "__missing__",
      ),
    );

    expect(new Set(pendingCreateLocalIds).size).toBe(commentBodies.length);
    expect(matchingLocalComments).toHaveLength(commentBodies.length);

    await first.client.close();
    clientsToClose.length = 0;

    const second = createLiveClient({
      name: suffix,
      remoteUrl: CONVEX_URL!,
      databasePath,
    });
    clientsToClose.push(second.client as LiveClient);
    connectivities.push(second.connectivity);

    await waitForResolved(second.client, 60_000);

    const issues = await pollUntil({
      description: `volume restart sees final issue ${canonicalIssueId}`,
      read: async () =>
        (await second.client.query(api.issues.allForProject, {
          projectId: canonicalProjectId,
        })) as Array<{
          _id: string;
          title: string;
          status: string;
          priority: string;
        }>,
      accept: (issues) =>
        issues.some(
          (issue) =>
            issue._id === canonicalIssueId &&
            issue.status === "done" &&
            issue.priority === "high" &&
            issue.title ===
              `Volume title ${commentBodies.length - 1} ${suffix}`,
        ),
      diagnostics: () => describeLiveClientState(second.client),
      timeoutMs: 60_000,
      intervalMs: 250,
    });

    const comments = await pollUntil({
      description: `volume restart sees all ${commentBodies.length} comments`,
      read: async () =>
        (await second.client.query(api.comments.forIssue, {
          issueId: canonicalIssueId,
        })) as Array<{ body: string }>,
      accept: (result) => {
        const bodies = new Set(result.map((comment) => comment.body));
        return commentBodies.every((body) => bodies.has(body));
      },
      diagnostics: () => describeLiveClientState(second.client),
      timeoutMs: 60_000,
      intervalMs: 250,
    });

    const issue = issues.find(
      (candidate) => candidate._id === canonicalIssueId,
    );
    expect(issue).toMatchObject({
      title: `Volume title ${commentBodies.length - 1} ${suffix}`,
      status: "done",
      priority: "high",
    });
    expect(comments).toHaveLength(commentBodies.length);
  }, 120_000);
});
