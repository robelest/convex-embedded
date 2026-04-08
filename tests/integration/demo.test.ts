// @vitest-environment edge-runtime

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import schema from "@convex/schema";
import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import { register as registerResolveComponent } from "@robelest/convex-embedded/test";
import { convexTest } from "convex-test";
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
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
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
      documents: [
        {
          docId: projectId,
          vector: toArrayBuffer(emptyVector),
        },
      ],
    });

    expect(resolveResults).toHaveLength(1);
    const result = resolveResults[0];
    expect(result.docId).toBe(projectId);
    // The diff should be non-empty since the client has no state
    expect(result.diff).toBeDefined();
    expect(result.diff).toBeInstanceOf(ArrayBuffer);
    expect((result.diff as ArrayBuffer).byteLength).toBeGreaterThan(0);

    // 3. Apply the diff to a client Y.Doc
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, new Uint8Array(result.diff as ArrayBuffer));

    // Verify the client doc has the expected data
    // Register fields are stored as Y.Map<{value, timestamp}>
    const fields = clientDoc.getMap("fields");
    expect(fields.get("name")).toBe("Write tests");
    expect(readRegister(fields, "status")).toBe("active");

    // 4. Resolve again with the client's current state vector — should be up to date
    const clientVector = Y.encodeStateVector(clientDoc);
    const resolveResults2 = await t.query(api.projects.bind, {
      documents: [
        {
          docId: projectId,
          vector: toArrayBuffer(clientVector),
        },
      ],
    });

    expect(resolveResults2).toHaveLength(1);
    const result2 = resolveResults2[0];
    expect(result2.docId).toBe(projectId);
    // Should be undefined (no diff) since client is up to date
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
      documents: [
        {
          docId: projectId as string,
          vector: toArrayBuffer(freshVector),
        },
      ],
    });

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.docId).toBe(projectId);
    expect(result.diff).toBeDefined();

    // Apply the diff to a fresh client doc
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, new Uint8Array(result.diff as ArrayBuffer));

    // Verify updated values
    const fields = clientDoc.getMap("fields");
    expect(fields.get("name")).toBe("Original title");
    expect(readRegister(fields, "status")).toBe("active");

    // Resolve again — client should now be up to date
    const clientVector = Y.encodeStateVector(clientDoc);
    const results2 = await t.query(api.projects.bind, {
      documents: [
        {
          docId: projectId as string,
          vector: toArrayBuffer(clientVector),
        },
      ],
    });

    expect(results2).toHaveLength(1);
    expect(results2[0].diff).toBeUndefined();
  });

  it("resolves with no delta if document has never been recorded", async () => {
    const t = convexTest(schema, modules);
    registerResolveComponent(t);

    const emptyDoc = new Y.Doc();
    const emptyVector = Y.encodeStateVector(emptyDoc);

    const results = await t.query(api.projects.bind, {
      documents: [
        {
          docId: "nonexistent-id",
          vector: toArrayBuffer(emptyVector),
        },
      ],
    });

    expect(results).toHaveLength(1);
    expect(results[0].docId).toBe("nonexistent-id");
    expect(results[0].diff).toBeUndefined();
  });
});
