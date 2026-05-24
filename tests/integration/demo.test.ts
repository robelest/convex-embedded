// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { projects } from "@convex/schema";
import { initYjsDoc } from "@resolve/shared/yjs";
import type { AppConvexTest } from "@tests/helpers/convex";
import { toArrayBuffer } from "@tests/helpers/convex";
import { describe, expect, it } from "@tests/testkit";
import * as Y from "yjs";

interface BindDocument {
  docId: string;
  document?: Record<string, unknown>;
  seq: number | null;
  diff?: ArrayBuffer;
}

interface BindResult {
  mode: "full" | "incremental";
  documents: BindDocument[];
}

function emptyStateVector(): ArrayBuffer {
  return toArrayBuffer(Y.encodeStateVector(new Y.Doc()));
}

async function bindProject(
  t: AppConvexTest,
  args: { docId: string; vector: ArrayBuffer },
): Promise<BindResult> {
  return (await t.query(api.projects.bind, {
    collectionSeq: null,
    documents: [{ docId: args.docId, vector: args.vector, lastSeq: null }],
  })) as unknown as BindResult;
}

function expectSingle(result: BindResult): BindDocument {
  expect(result.documents).toHaveLength(1);
  const [document] = result.documents;
  if (!document) {
    throw new Error("expected exactly one bound document");
  }
  return document;
}

function clientVectorFor(document: Record<string, unknown>): ArrayBuffer {
  const clientDoc = initYjsDoc(projects.schema, document);
  return toArrayBuffer(Y.encodeStateVector(clientDoc));
}

describe("convex-embedded integration", () => {
  it("returns a full diff for a freshly created project", async ({
    convex,
  }) => {
    const projectId: Id<"projects"> = await convex.mutation(
      api.projects.create,
      {
        name: "Write tests",
        identifier: "WT",
        description: "Integration test for convex-resolve",
      },
    );

    const result = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: emptyStateVector(),
      }),
    );

    expect(result.docId).toBe(projectId);
    expect(result.seq).toBeTypeOf("number");
    expect(result.document).toMatchObject({ name: "Write tests" });
  });

  it("seeds the status register on the resolved document", async ({
    convex,
  }) => {
    const projectId: Id<"projects"> = await convex.mutation(
      api.projects.create,
      {
        name: "Write tests",
        identifier: "WT",
        description: "Integration test for convex-resolve",
      },
    );

    const result = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: emptyStateVector(),
      }),
    );
    const document = result.document;
    if (!document) {
      throw new Error("expected a resolved document");
    }

    const fields = initYjsDoc(projects.schema, document).getMap("fields");
    expect(fields).toHaveYjsField("status", "active");
  });

  it("reports no further diff once the client is up to date", async ({
    convex,
  }) => {
    const projectId: Id<"projects"> = await convex.mutation(
      api.projects.create,
      {
        name: "Write tests",
        identifier: "WT",
        description: "Integration test for convex-resolve",
      },
    );

    const first = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: emptyStateVector(),
      }),
    );
    const document = first.document;
    if (!document) {
      throw new Error("expected a resolved document");
    }

    const second = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: clientVectorFor(document),
      }),
    );

    expect(second.docId).toBe(projectId);
    expect(second.diff).toBeUndefined();
  });

  it("reflects an update when re-resolving from an empty vector", async ({
    convex,
  }) => {
    const projectId: Id<"projects"> = await convex.mutation(
      api.projects.create,
      {
        name: "Original title",
        identifier: "OT",
        description: "Original body",
      },
    );
    await convex.mutation(api.projects.update, {
      projectId,
      description: "Updated body",
    });

    const result = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: emptyStateVector(),
      }),
    );

    expect(result.docId).toBe(projectId);
    expect(result.document).toMatchObject({ name: "Original title" });

    const document = result.document;
    if (!document) {
      throw new Error("expected a resolved document");
    }
    const fields = initYjsDoc(projects.schema, document).getMap("fields");
    expect(fields).toHaveYjsField("status", "active");
  });

  it("reports no diff after applying an update", async ({ convex }) => {
    const projectId: Id<"projects"> = await convex.mutation(
      api.projects.create,
      {
        name: "Original title",
        identifier: "OT",
        description: "Original body",
      },
    );
    await convex.mutation(api.projects.update, {
      projectId,
      description: "Updated body",
    });

    const first = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: emptyStateVector(),
      }),
    );
    const document = first.document;
    if (!document) {
      throw new Error("expected a resolved document");
    }

    const second = expectSingle(
      await bindProject(convex, {
        docId: projectId,
        vector: clientVectorFor(document),
      }),
    );

    expect(second.diff).toBeUndefined();
  });

  it("returns no documents for an id that was never recorded", async ({
    convex,
  }) => {
    const result = await bindProject(convex, {
      docId: "nonexistent-id",
      vector: emptyStateVector(),
    });

    expect(result.documents).toHaveLength(0);
  });
});
