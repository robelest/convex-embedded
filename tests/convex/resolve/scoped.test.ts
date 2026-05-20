// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DEMO_WORKSPACE_ID } from "@convex/workspace";
import { createAppConvexTest } from "@tests/helpers/convex";
import { describe, expect, it } from "@tests/testkit";

describe("scoped resolve", () => {
  it("uses indexed scope args to resolve only matching issue documents", async () => {
    const t = createAppConvexTest();

    const firstProjectId: Id<"projects"> = await t.mutation(
      api.projects.create,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        name: "Scoped A",
        identifier: "SCA",
        description: "First scoped project",
      },
    );
    const secondProjectId: Id<"projects"> = await t.mutation(
      api.projects.create,
      {
        workspaceId: DEMO_WORKSPACE_ID,
        name: "Scoped B",
        identifier: "SCB",
        description: "Second scoped project",
      },
    );
    const firstIssueId: Id<"issues"> = await t.mutation(api.issues.create, {
      projectId: firstProjectId,
      title: "First scoped issue",
    });
    const secondIssueId: Id<"issues"> = await t.mutation(api.issues.create, {
      projectId: secondProjectId,
      title: "Second scoped issue",
    });

    const result = await t.query(api.issues.bind, {
      collectionSeq: null,
      documents: [],
      scopeArgs: { projectId: firstProjectId },
    });

    expect(result.mode).toBe("full");
    expect(result.isDone).toBe(true);
    expect(result.documents.map((document) => document.docId)).toEqual([
      firstIssueId,
    ]);
    expect(result.documents[0]).toMatchObject({
      docId: firstIssueId,
      document: expect.objectContaining({
        _id: firstIssueId,
        projectId: firstProjectId,
        title: "First scoped issue",
      }),
    });
    expect(result.documents.map((document) => document.docId)).not.toContain(
      secondIssueId,
    );
  });
});
