import { afterEach, describe, expect, it } from "@tests/testkit";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { DEMO_WORKSPACE_ID } from "../../../convex/workspace";
import {
  createDirectRemoteClient,
  createLiveClient,
  describeLiveClientState,
  pollUntil,
  waitForMappedRemoteId,
  type TestConnectivityController,
  uniqueSuffix,
  waitForOffline,
  waitForResolved,
} from "./harness";

const CONVEX_URL = process.env.CONVEX_URL;
const maybeDescribe =
  CONVEX_URL && process.env.RUN_CONVEX_E2E === "1" ? describe : describe.skip;

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

async function waitForCommentsCount(
  client: ClosableClient,
  issueId: Id<"issues">,
  expectedCount: number,
) {
  return await pollUntil({
    description: `comments for issue ${issueId} reach ${expectedCount}`,
    read: async () =>
      (await client.query(api.comments.forIssue, { issueId })) as Array<{
        body: string;
      }>,
    accept: (comments) => comments.length >= expectedCount,
    diagnostics: () => describeLiveClientState(client),
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
    description: `issue ${input.issueId} reaches ${input.status}/${input.priority}`,
    read: async () =>
      (await input.client.query(api.issues.allForProject, {
        projectId: input.projectId,
      })) as Array<{
        _id: string;
        status: string;
        priority: string;
      }>,
    accept: (issues) =>
      issues.some(
        (issue) =>
          issue._id === input.issueId &&
          issue.status === input.status &&
          issue.priority === input.priority,
      ),
    diagnostics: () => describeLiveClientState(input.client),
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
      description: `client A sees created issue ${issueId}`,
      read: async () =>
        (await clientAEntry.client.query(api.issues.allForProject, {
          projectId,
        })) as Array<{ _id: string }>,
      accept: (issues) => issues.some((issue) => issue._id === issueId),
      diagnostics: () => describeLiveClientState(clientAEntry.client),
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

  it("falls back to a full reconnect sync after collection tail compaction", async () => {
    const clientAEntry = createLiveClient({
      name: uniqueSuffix("fallback-a"),
      remoteUrl: CONVEX_URL!,
    });
    const clientBEntry = createLiveClient({
      name: uniqueSuffix("fallback-b"),
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
      description: `client A can query comments for issue ${issueId}`,
      read: async () =>
        (await clientAEntry.client.query(api.comments.forIssue, {
          issueId,
        })) as Array<{ _id: string }>,
      accept: () => true,
      diagnostics: () => describeLiveClientState(clientAEntry.client),
      timeoutMs: 40_000,
      intervalMs: 250,
    });
    const canonicalIssueId = await pollUntil({
      description: `client A sees issue titled Issue ${suffix}`,
      read: async () =>
        (await clientAEntry.client.query(api.issues.allForProject, {
          projectId,
        })) as Array<{ _id: Id<"issues">; title: string }>,
      accept: (issues) =>
        issues.some((candidate) => candidate.title === `Issue ${suffix}`),
      diagnostics: () => describeLiveClientState(clientAEntry.client),
      timeoutMs: 40_000,
      intervalMs: 250,
    }).then((result) => {
      const found = result.find(
        (candidate) => candidate.title === `Issue ${suffix}`,
      );
      if (!found) {
        throw new Error("[convex-embedded] missing canonical issue after sync");
      }
      return found._id;
    });

    clientAEntry.connectivity.setOnline(false);
    await waitForOffline(clientAEntry.client);

    // Exceed the default collection tail retention (256) with a small buffer so
    // the test still forces full fallback without spending extra time on writes.
    const expectedCount = 270;
    const directRemoteClient = createDirectRemoteClient(CONVEX_URL!);
    for (let index = 0; index < expectedCount; index += 1) {
      await directRemoteClient.mutation(api.comments.create, {
        issueId: canonicalIssueId,
        body: `fallback-comment-${index}`,
      });
    }

    clientAEntry.connectivity.setOnline(true);
    await Promise.all([
      waitForResolved(clientAEntry.client, 60_000),
      waitForResolved(clientBEntry.client, 60_000),
    ]);

    const comments = await waitForCommentsCount(
      clientAEntry.client as ClosableClient,
      canonicalIssueId,
      expectedCount,
    );

    expect(new Set(comments.map((comment) => comment.body)).size).toBe(
      expectedCount,
    );
  }, 300_000);
});
