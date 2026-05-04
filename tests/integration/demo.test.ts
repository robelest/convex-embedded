// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import { projects } from "@convex/schema";
import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import { initYjsDoc } from "@resolve/shared/yjs";
import { register as registerResolveComponent } from "@robelest/convex-embedded/test";
/**
 * Integration test for convex-embedded using convex-test.
 *
 * Tests the full server-side pipeline:
 *   create task (wrapped mutation with inline delta recording)
 *   -> delta stored in component (same transaction)
 *   -> resolve returns diff
 *   -> client applies diff
 *   -> resolve returns empty (up to date)
 */
import { describe, it, expect, beforeEach } from "@tests/testkit";
import { convexTest } from "convex-test";
import { vi } from "vitest";
import * as Y from "yjs";

/** Safely convert a Uint8Array to a proper ArrayBuffer for Convex v.bytes() */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return buf;
}

/**
 * Read the winning value from a register field in the Yjs doc.
 * Register fields are stored as Y.Map<{ value, timestamp }> keyed by client ID.
 * The winning value is the entry with the highest timestamp (last-write-wins).
 */
function readRegister(fields: Y.Map<unknown>, key: string): unknown {
  const registerMap = fields.get(key) as Y.Map<unknown>;
  // Early return via ternary — no Y.Map means no register
  return registerMap instanceof Y.Map
    ? Array.from(registerMap.values()).reduce<
        { value: unknown; timestamp: number } | undefined
      >(
        (winner, entry: any) =>
          !winner || (entry.timestamp && entry.timestamp > winner.timestamp)
            ? entry
            : winner,
        undefined,
      )?.value
    : undefined;
}

const modules = {
  "_generated/api": () => import("../../convex/_generated/api.js"),
  "_generated/server": () => import("../../convex/_generated/server.js"),
  schema: () => import("../../convex/schema"),
  projects: () => import("../../convex/projects"),
  issues: () => import("../../convex/issues"),
  comments: () => import("../../convex/comments"),
} satisfies ConvexModuleRegistry;

describe("convex-embedded integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("creates a task, records a delta inline, and resolves a diff", async () => {
    const t = convexTest(schema, modules);
    registerResolveComponent(t);

    // 1. Create a task via the wrapped mutation.
    //    Delta recording happens inline (same transaction) — no scheduler needed.
    const projectId: Id<"projects"> = await t.mutation(api.projects.create, {
      workspaceId: "workspace_demo",
      name: "Write tests",
      identifier: "WT",
      description: "Integration test for convex-resolve",
    });

    expect(projectId).toBeDefined();
    expect(typeof projectId).toBe("string");

    // 2. Resolve with an empty state vector — should get a non-empty diff.
    //    No need to advance timers; delta was recorded in the same transaction.
    const emptyDoc = new Y.Doc();
    const emptyVector = Y.encodeStateVector(emptyDoc);

    const resolveResults = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [
        {
          docId: projectId,
          vector: toArrayBuffer(emptyVector),
          lastSeq: null,
        },
      ],
    });

    expect(resolveResults.mode).toBe("full");
    expect(resolveResults.documents).toHaveLength(1);
    const result = resolveResults.documents[0]!;
    expect(result.docId).toBe(projectId);
    expect(result.seq).toBeTypeOf("number");
    expect(result.document).toBeDefined();

    const document = result.document as Record<string, unknown>;
    expect(document.name).toBe("Write tests");

    const clientDoc = initYjsDoc(projects.schema, document);
    const fields = clientDoc.getMap("fields");
    expect(readRegister(fields, "status")).toBe("active");

    const clientVector = Y.encodeStateVector(clientDoc);
    const resolveResults2 = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [
        {
          docId: projectId,
          vector: toArrayBuffer(clientVector),
          lastSeq: null,
        },
      ],
    });

    expect(resolveResults2.documents).toHaveLength(1);
    const result2 = resolveResults2.documents[0]!;
    expect(result2.docId).toBe(projectId);
    expect(result2.diff).toBeUndefined();
  });

  it("handles update mutation and re-resolves correctly", async () => {
    const t = convexTest(schema, modules);
    registerResolveComponent(t);

    // Create a task — delta recorded inline
    const projectId: Id<"projects"> = await t.mutation(api.projects.create, {
      workspaceId: "workspace_demo",
      name: "Original title",
      identifier: "OT",
      description: "Original body",
    });

    // Update the project description — delta recorded inline
    await t.mutation(api.projects.update, {
      projectId,
      description: "Updated body",
    });

    // Resolve from scratch (empty vector) to get the latest full state.
    // Each inline delta records a complete snapshot, so the latest delta
    // reflects the updated values.
    const freshDoc = new Y.Doc();
    const freshVector = Y.encodeStateVector(freshDoc);
    const results = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [
        {
          docId: projectId as string,
          vector: toArrayBuffer(freshVector),
          lastSeq: null,
        },
      ],
    });

    expect(results.documents).toHaveLength(1);
    const result = results.documents[0]!;
    expect(result.docId).toBe(projectId);
    expect(result.document).toBeDefined();

    const document = result.document as Record<string, unknown>;
    expect(document.name).toBe("Original title");

    const clientDoc = initYjsDoc(projects.schema, document);
    const fields = clientDoc.getMap("fields");
    expect(readRegister(fields, "status")).toBe("active");

    // Resolve again — client should now be up to date
    const clientVector = Y.encodeStateVector(clientDoc);
    const results2 = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [
        {
          docId: projectId as string,
          vector: toArrayBuffer(clientVector),
          lastSeq: null,
        },
      ],
    });

    expect(results2.documents).toHaveLength(1);
    expect(results2.documents[0]?.diff).toBeUndefined();
  });

  it("resolves with no delta if document has never been recorded", async () => {
    const t = convexTest(schema, modules);
    registerResolveComponent(t);

    const emptyDoc = new Y.Doc();
    const emptyVector = Y.encodeStateVector(emptyDoc);

    const results = await t.query(api.projects.bind, {
      collectionSeq: null,
      documents: [
        {
          docId: "nonexistent-id",
          vector: toArrayBuffer(emptyVector),
          lastSeq: null,
        },
      ],
    });

    expect(results.documents).toHaveLength(0);
  });
});
