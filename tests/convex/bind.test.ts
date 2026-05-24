// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { AppConvexTest } from "@tests/helpers/convex";
import { describe, expect, it } from "@tests/testkit";

interface BindDocument {
  docId: string;
  document?: Record<string, unknown>;
  seq: number | null;
  deleted?: boolean;
}

interface BindResult {
  mode: "full" | "incremental";
  documents: BindDocument[];
}

async function bindProjects(
  t: AppConvexTest,
  args: { docIds: string[] },
): Promise<BindResult> {
  return (await t.query(api.projects.bind, {
    collectionSeq: null,
    documents: [],
    docIds: args.docIds,
  })) as unknown as BindResult;
}

async function createProject(
  t: AppConvexTest,
  args: { name: string; identifier: string; description: string },
): Promise<Id<"projects">> {
  return await t.mutation(api.projects.create, args);
}

describe("convex bind queries", () => {
  it("resolves only the requested document id", async ({ convex }) => {
    const secondId = await createProject(convex, {
      name: "Exact B",
      identifier: "EXB",
      description: "Second project",
    });

    const result = await bindProjects(convex, { docIds: [secondId] });

    expect(result.mode).toBe("full");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      docId: secondId,
      document: expect.objectContaining({ _id: secondId, name: "Exact B" }),
    });
  });

  it("excludes documents whose ids were not requested", async ({ convex }) => {
    const firstId = await createProject(convex, {
      name: "Exact A",
      identifier: "EXA",
      description: "First project",
    });
    const secondId = await createProject(convex, {
      name: "Exact B",
      identifier: "EXB",
      description: "Second project",
    });

    const result = await bindProjects(convex, { docIds: [secondId] });

    expect(result.documents.map((doc) => doc.docId)).toEqual([secondId]);
    expect(result.documents.map((doc) => doc.docId)).not.toContain(firstId);
  });

  it("marks an exact missing document as deleted", async ({ convex }) => {
    const result = await bindProjects(convex, { docIds: ["missing-project"] });

    expect(result.documents).toEqual([
      { docId: "missing-project", deleted: true, seq: null },
    ]);
  });
});
