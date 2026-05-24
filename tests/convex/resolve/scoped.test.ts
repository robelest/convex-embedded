// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { AppConvexTest } from "@tests/helpers/convex";
import { describe, expect, it } from "@tests/testkit";

interface ScopedDocument {
  docId: string;
  document?: Record<string, unknown>;
}

interface ScopedResult {
  mode: "full" | "incremental";
  isDone: boolean;
  documents: ScopedDocument[];
}

async function createProject(
  t: AppConvexTest,
  args: { name: string; identifier: string; description: string },
): Promise<Id<"projects">> {
  return await t.mutation(api.projects.create, args);
}

async function bindIssuesForProject(
  t: AppConvexTest,
  projectId: Id<"projects">,
): Promise<ScopedResult> {
  return (await t.query(api.issues.bind, {
    collectionSeq: null,
    documents: [],
    scopeArgs: { projectId },
  })) as unknown as ScopedResult;
}

describe("scoped resolve", () => {
  it("resolves only issues belonging to the scoped project", async ({
    convex,
  }) => {
    const firstProjectId = await createProject(convex, {
      name: "Scoped A",
      identifier: "SCA",
      description: "First scoped project",
    });
    const secondProjectId = await createProject(convex, {
      name: "Scoped B",
      identifier: "SCB",
      description: "Second scoped project",
    });
    const firstIssueId: Id<"issues"> = await convex.mutation(
      api.issues.create,
      { projectId: firstProjectId, title: "First scoped issue" },
    );
    const secondIssueId: Id<"issues"> = await convex.mutation(
      api.issues.create,
      { projectId: secondProjectId, title: "Second scoped issue" },
    );

    const result = await bindIssuesForProject(convex, firstProjectId);

    expect(result.mode).toBe("full");
    expect(result.isDone).toBe(true);
    expect(result.documents.map((doc) => doc.docId)).toEqual([firstIssueId]);
    expect(result.documents[0]).toMatchObject({
      docId: firstIssueId,
      document: expect.objectContaining({
        _id: firstIssueId,
        projectId: firstProjectId,
        title: "First scoped issue",
      }),
    });
    expect(result.documents.map((doc) => doc.docId)).not.toContain(
      secondIssueId,
    );
  });
});
