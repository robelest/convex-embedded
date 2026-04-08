import { afterEach, describe, expect, it } from "vite-plus/test";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DEMO_WORKSPACE_ID } from "../../convex/workspace";
import {
  createLiveClient,
  pollUntil,
  type TestConnectivityController,
  uniqueSuffix,
  waitForOffline,
  waitForResolved,
} from "../helpers/live";

const CONVEX_URL = process.env.CONVEX_URL;
const maybeDescribe = CONVEX_URL ? describe : describe.skip;

type ClosableClient = Awaited<ReturnType<typeof createLiveClient>>["client"] & {
  close(): Promise<void>;
};

async function createProjectAndIssue(client: ClosableClient) {
  const suffix = uniqueSuffix("durability");
  const projectId = await client.mutation(api.projects.create, {
    workspaceId: DEMO_WORKSPACE_ID,
    name: `Durability ${suffix}`,
    identifier: suffix.slice(-6).toUpperCase(),
    description: `Durability seed ${suffix}`,
  });

  const issueId = await client.mutation(api.issues.create, {
    projectId,
    title: `Issue ${suffix}`,
  });

  return { projectId, issueId, suffix };
}

async function waitForCommentsCount(
  client: ClosableClient,
  issueId: Id<"issues">,
  expectedCount: number,
) {
  return await pollUntil({
    read: async () =>
      (await client.query(api.comments.forIssue, { issueId })) as Array<{
        body: string;
      }>,
    accept: (comments) => comments.length >= expectedCount,
    timeoutMs: 40_000,
    intervalMs: 250,
  });
}

async function waitForIssueState(input: {
  client: ClosableClient;
  projectId: Id<"projects">;
  issueId: Id<"issues">;
  status: string;
  priority: string;
}) {
  return await pollUntil({
    read: async () =>
      (await input.client.query(api.issues.forProject, {
        projectId: input.projectId,
      })) as {
        issues: Array<{
          _id: string;
          status: string;
          priority: string;
        }>;
      },
    accept: (result) =>
      result.issues.some(
        (issue) =>
          issue._id === input.issueId &&
          issue.status === input.status &&
          issue.priority === input.priority,
      ),
    timeoutMs: 40_000,
    intervalMs: 250,
  });
}

maybeDescribe("live reconnect durability", () => {
  const clientsToClose: ClosableClient[] = [];
  const connectivities: TestConnectivityController[] = [];

  afterEach(async () => {
    for (const connectivity of connectivities.splice(0)) {
      connectivity.close();
    }
    for (const client of clientsToClose.splice(0)) {
      await client.close();
    }
  });

  it("replays offline changes while online changes continue and converges on the live backend", async () => {
    const clientAEntry = createLiveClient({
      name: uniqueSuffix("live-a"),
      remoteUrl: CONVEX_URL!,
    });
    const clientBEntry = createLiveClient({
      name: uniqueSuffix("live-b"),
      remoteUrl: CONVEX_URL!,
    });

    clientsToClose.push(clientAEntry.client as ClosableClient);
    clientsToClose.push(clientBEntry.client as ClosableClient);
    connectivities.push(clientAEntry.connectivity, clientBEntry.connectivity);

    await Promise.all([
      waitForResolved(clientAEntry.client),
      waitForResolved(clientBEntry.client),
    ]);

    const { projectId, issueId, suffix } = await createProjectAndIssue(
      clientBEntry.client as ClosableClient,
    );

    await waitForResolved(clientBEntry.client);
    await pollUntil({
      read: async () =>
        (await clientAEntry.client.query(api.issues.forProject, {
          projectId,
        })) as { issues: Array<{ _id: string }> },
      accept: (result) => result.issues.some((issue) => issue._id === issueId),
      timeoutMs: 40_000,
      intervalMs: 250,
    });

    clientAEntry.connectivity.setOnline(false);
    await waitForOffline(clientAEntry.client);

    await clientAEntry.client.mutation(api.issues.update, {
      issueId,
      status: "in_progress",
    });

    for (let index = 0; index < 8; index += 1) {
      await clientAEntry.client.mutation(api.comments.create, {
        issueId,
        body: `offline-comment-${suffix}-${index}`,
      });
    }

    await clientBEntry.client.mutation(api.issues.update, {
      issueId,
      priority: "urgent",
    });

    for (let index = 0; index < 8; index += 1) {
      await clientBEntry.client.mutation(api.comments.create, {
        issueId,
        body: `online-comment-${suffix}-${index}`,
      });
    }

    const continuedOnlineWrites = (async () => {
      for (let index = 8; index < 12; index += 1) {
        await clientBEntry.client.mutation(api.comments.create, {
          issueId,
          body: `online-comment-${suffix}-${index}`,
        });
      }
    })();

    clientAEntry.connectivity.setOnline(true);

    await Promise.all([
      continuedOnlineWrites,
      waitForResolved(clientAEntry.client, 40_000),
      waitForResolved(clientBEntry.client, 40_000),
    ]);

    const expectedCommentCount = 20;
    const [commentsA, commentsB] = await Promise.all([
      waitForCommentsCount(
        clientAEntry.client as ClosableClient,
        issueId,
        expectedCommentCount,
      ),
      waitForCommentsCount(
        clientBEntry.client as ClosableClient,
        issueId,
        expectedCommentCount,
      ),
    ]);

    expect(new Set(commentsA.map((comment) => comment.body)).size).toBe(
      expectedCommentCount,
    );
    expect(new Set(commentsB.map((comment) => comment.body)).size).toBe(
      expectedCommentCount,
    );

    await Promise.all([
      waitForIssueState({
        client: clientAEntry.client as ClosableClient,
        projectId,
        issueId,
        status: "in_progress",
        priority: "urgent",
      }),
      waitForIssueState({
        client: clientBEntry.client as ClosableClient,
        projectId,
        issueId,
        status: "in_progress",
        priority: "urgent",
      }),
    ]);
  }, 90_000);
});
