// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DEMO_WORKSPACE_ID } from "@convex/workspace";
import { createAppConvexTest } from "@tests/helpers/convex";
import { describe, expect, it } from "@tests/testkit";

describe("convex bind queries", () => {
  it("accepts docIds and resolves only requested documents", async () => {
    const t = createAppConvexTest();

    const firstId: Id<"projects"> = await t.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: "Exact A",
      identifier: "EXA",
      description: "First project",
    });
    const secondId: Id<"projects"> = await t.mutation(api.projects.create, {
      workspaceId: DEMO_WORKSPACE_ID,
      name: "Exact B",
      identifier: "EXB",
      description: "Second project",
    });

    const result = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [],
      docIds: [secondId],
    });

    expect(result.mode).toBe("full");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      docId: secondId,
      document: expect.objectContaining({
        _id: secondId,
        name: "Exact B",
      }),
    });
    expect(result.documents[0]?.docId).not.toBe(firstId);
  });

  it("marks exact missing documents as deleted", async () => {
    const t = createAppConvexTest();

    const result = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [],
      docIds: ["missing-project"],
    });

    expect(result.documents).toEqual([
      { docId: "missing-project", deleted: true, seq: null },
    ]);
  });
});
