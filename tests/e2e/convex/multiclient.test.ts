import { afterEach, describe, expect, it } from "@tests/testkit";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  createLiveClient,
  describeLiveClientState,
  pollUntil,
  type TestConnectivityController,
  waitForMappedRemoteId,
  uniqueSuffix,
  waitForResolved,
} from "./harness";

const CONVEX_URL = process.env.CONVEX_URL;
const maybeDescribe =
  CONVEX_URL && process.env.RUN_CONVEX_E2E === "1" ? describe : describe.skip;

type LiveClient = Awaited<ReturnType<typeof createLiveClient>>["client"] & {
  close(): Promise<void>;
};

async function createProjectAndIssue(client: LiveClient) {
  const suffix = uniqueSuffix("merge");
  const projectId = await client.mutation(api.projects.create, {
    name: `Merge ${suffix}`,
    identifier: suffix.slice(-6).toUpperCase(),
    description: `Merge seed ${suffix}`,
  });
  const canonicalProjectId = await waitForMappedRemoteId<Id<"projects">>(
    client,
    projectId,
  );
  const issueId = await client.mutation(api.issues.create, {
    projectId: canonicalProjectId,
    title: `Issue ${suffix}`,
  });
  const canonicalIssueId = await waitForMappedRemoteId<Id<"issues">>(
    client,
    issueId,
  );
  return { projectId: canonicalProjectId, issueId: canonicalIssueId, suffix };
}

async function waitForIssueProjection(
  client: LiveClient,
  projectId: Id<"projects">,
  issueId: Id<"issues">,
  expected?: { title?: string; status?: string; priority?: string },
) {
  return await pollUntil({
    description: `issue ${issueId} projection${expected ? ` matches ${JSON.stringify(expected)}` : " exists"}`,
    read: async () =>
      (await client.query(api.issues.allForProject, { projectId })) as Array<{
        _id: Id<"issues">;
        title: string;
        status: string;
        priority: string;
      }>,
    accept: (issues) =>
      issues.some(
        (issue) =>
          issue._id === issueId &&
          (expected?.title === undefined || issue.title === expected.title) &&
          (expected?.status === undefined ||
            issue.status === expected.status) &&
          (expected?.priority === undefined ||
            issue.priority === expected.priority),
      ),
    diagnostics: () => describeLiveClientState(client),
    timeoutMs: 40_000,
    intervalMs: 250,
  });
}

async function waitForCommentsBodies(
  client: LiveClient,
  issueId: Id<"issues">,
  expectedBodies: string[],
) {
  return await pollUntil({
    description: `comments for ${issueId} include ${expectedBodies.length} bodies`,
    read: async () =>
      (await client.query(api.comments.forIssue, { issueId })) as Array<{
        body: string;
      }>,
    accept: (comments) => {
      const bodies = new Set(comments.map((comment) => comment.body));
      return expectedBodies.every((body) => bodies.has(body));
    },
    diagnostics: () => describeLiveClientState(client),
    timeoutMs: 40_000,
    intervalMs: 250,
  });
}

maybeDescribe("live multi-client merge", () => {
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

  it("converges across three live clients after mixed offline and online writes", async () => {
    const clientAEntry = createLiveClient({
      name: uniqueSuffix("merge-a"),
      remoteUrl: CONVEX_URL!,
    });
    const clientBEntry = createLiveClient({
      name: uniqueSuffix("merge-b"),
      remoteUrl: CONVEX_URL!,
    });
    const clientCEntry = createLiveClient({
      name: uniqueSuffix("merge-c"),
      remoteUrl: CONVEX_URL!,
    });

    clientsToClose.push(
      clientAEntry.client as LiveClient,
      clientBEntry.client as LiveClient,
      clientCEntry.client as LiveClient,
    );
    connectivities.push(
      clientAEntry.connectivity,
      clientBEntry.connectivity,
      clientCEntry.connectivity,
    );

    await Promise.all([
      waitForResolved(clientAEntry.client),
      waitForResolved(clientBEntry.client),
      waitForResolved(clientCEntry.client),
    ]);

    const { projectId, issueId, suffix } = await createProjectAndIssue(
      clientAEntry.client as LiveClient,
    );

    await Promise.all([
      waitForIssueProjection(
        clientAEntry.client as LiveClient,
        projectId,
        issueId,
      ),
      waitForIssueProjection(
        clientBEntry.client as LiveClient,
        projectId,
        issueId,
      ),
      waitForIssueProjection(
        clientCEntry.client as LiveClient,
        projectId,
        issueId,
      ),
    ]);

    clientAEntry.connectivity.setOnline(false);
    await clientAEntry.client.mutation(api.issues.update, {
      issueId,
      status: "in_progress",
    });
    const bodies = [
      `merge-a-${suffix}`,
      `merge-b-${suffix}`,
      `merge-c-${suffix}`,
    ];
    await clientAEntry.client.mutation(api.comments.create, {
      issueId,
      body: bodies[0],
    });

    await clientBEntry.client.mutation(api.issues.update, {
      issueId,
      priority: "high",
    });
    await clientBEntry.client.mutation(api.comments.create, {
      issueId,
      body: bodies[1],
    });

    await clientCEntry.client.mutation(api.issues.update, {
      issueId,
      title: `Merged title ${suffix}`,
    });
    await clientCEntry.client.mutation(api.comments.create, {
      issueId,
      body: bodies[2],
    });

    clientAEntry.connectivity.setOnline(true);
    await Promise.all([
      waitForResolved(clientAEntry.client, 40_000),
      waitForResolved(clientBEntry.client, 40_000),
      waitForResolved(clientCEntry.client, 40_000),
    ]);

    const [issuesA, issuesB, issuesC] = await Promise.all([
      waitForIssueProjection(
        clientAEntry.client as LiveClient,
        projectId,
        issueId,
        {
          title: `Merged title ${suffix}`,
          status: "in_progress",
          priority: "high",
        },
      ),
      waitForIssueProjection(
        clientBEntry.client as LiveClient,
        projectId,
        issueId,
        {
          title: `Merged title ${suffix}`,
          status: "in_progress",
          priority: "high",
        },
      ),
      waitForIssueProjection(
        clientCEntry.client as LiveClient,
        projectId,
        issueId,
        {
          title: `Merged title ${suffix}`,
          status: "in_progress",
          priority: "high",
        },
      ),
    ]);

    const issueA = issuesA.find((issue) => issue._id === issueId)!;
    const issueB = issuesB.find((issue) => issue._id === issueId)!;
    const issueC = issuesC.find((issue) => issue._id === issueId)!;

    expect(issueA).toMatchObject({
      title: `Merged title ${suffix}`,
      status: "in_progress",
      priority: "high",
    });
    expect(issueB).toMatchObject({
      title: `Merged title ${suffix}`,
      status: "in_progress",
      priority: "high",
    });
    expect(issueC).toMatchObject({
      title: `Merged title ${suffix}`,
      status: "in_progress",
      priority: "high",
    });

    await Promise.all([
      waitForCommentsBodies(clientAEntry.client as LiveClient, issueId, bodies),
      waitForCommentsBodies(clientBEntry.client as LiveClient, issueId, bodies),
      waitForCommentsBodies(clientCEntry.client as LiveClient, issueId, bodies),
    ]);
  }, 180_000);
});
