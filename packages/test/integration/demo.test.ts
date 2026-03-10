import { register as registerResolveComponent } from "@robelest/convex-resolve/test";
import { convexTest } from "convex-test";
/**
 * Integration test for convex-resolve using convex-test.
 *
 * Tests the full server-side pipeline:
 *   create task (wrapped mutation)
 *   → scheduler fires _recordDelta
 *   → delta stored in component
 *   → resolve returns diff
 *   → client applies diff
 *   → resolve returns empty (up to date)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

import { api } from "../../../convex/_generated/api.js";
import schema from "../../../convex/schema.js";

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
  if (!registerMap || !(registerMap instanceof Y.Map)) return undefined;
  // Find the entry with the highest timestamp (last-write-wins)
  let winner: { value: unknown; timestamp: number } | undefined;
  registerMap.forEach((entry: any) => {
    if (!winner || (entry.timestamp && entry.timestamp > winner.timestamp)) {
      winner = entry;
    }
  });
  return winner?.value;
}

// Glob all app modules for convex-test
const modules = import.meta.glob("../../../convex/**/*.ts");

describe("convex-resolve integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("creates a task, records a delta, and resolves a diff", async () => {
    const t = convexTest(schema, modules);
    registerResolveComponent(t);

    // 1. Create a task via the wrapped mutation.
    //    This should insert the row AND schedule _recordDelta via runAfter(0, ...)
    const taskId = await t.mutation(api.tasks.create, {
      title: "Write tests",
      body: "Integration test for convex-resolve",
    });

    expect(taskId).toBeDefined();
    expect(typeof taskId).toBe("string");

    // 2. Advance timers so the scheduled _recordDelta fires
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // 3. Resolve with an empty state vector — should get a non-empty diff
    //    An empty Y.Doc's state vector (V2) is what we send to represent
    //    "I have nothing"
    const emptyDoc = new Y.Doc();
    const emptyVector = Y.encodeStateVector(emptyDoc);

    const resolveResults = await t.query(api.tasks.resolve, {
      documents: [
        {
          docId: taskId as string,
          vector: toArrayBuffer(emptyVector),
        },
      ],
    });

    expect(resolveResults).toHaveLength(1);
    const result = resolveResults[0];
    expect(result.docId).toBe(taskId);
    // The diff should be non-empty since the client has no state
    expect(result.diff).toBeDefined();
    expect(result.diff).toBeInstanceOf(ArrayBuffer);
    expect((result.diff as ArrayBuffer).byteLength).toBeGreaterThan(0);

    // 4. Apply the diff to a client Y.Doc
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, new Uint8Array(result.diff as ArrayBuffer));

    // Verify the client doc has the expected data
    // Register fields are stored as Y.Map<{value, timestamp}>
    const fields = clientDoc.getMap("fields");
    expect(readRegister(fields, "title")).toBe("Write tests");

    // 5. Resolve again with the client's current state vector — should be up to date
    const clientVector = Y.encodeStateVector(clientDoc);
    const resolveResults2 = await t.query(api.tasks.resolve, {
      documents: [
        {
          docId: taskId as string,
          vector: toArrayBuffer(clientVector),
        },
      ],
    });

    expect(resolveResults2).toHaveLength(1);
    const result2 = resolveResults2[0];
    expect(result2.docId).toBe(taskId);
    // Should be undefined (no diff) since client is up to date
    expect(result2.diff).toBeUndefined();
  });

  it("handles update mutation and re-resolves correctly", async () => {
    const t = convexTest(schema, modules);
    registerResolveComponent(t);

    // Create a task
    const taskId = await t.mutation(api.tasks.create, {
      title: "Original title",
      body: "Original body",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Update the task
    await t.mutation(api.tasks.update, {
      id: taskId,
      title: "Updated title",
      body: "Updated body",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Resolve from scratch (empty vector) to get the latest full state.
    // Each _recordDelta stores a complete snapshot, so the latest delta
    // reflects the updated values.
    const freshDoc = new Y.Doc();
    const freshVector = Y.encodeStateVector(freshDoc);
    const results = await t.query(api.tasks.resolve, {
      documents: [
        {
          docId: taskId as string,
          vector: toArrayBuffer(freshVector),
        },
      ],
    });

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result.docId).toBe(taskId);
    expect(result.diff).toBeDefined();

    // Apply the diff to a fresh client doc
    const clientDoc = new Y.Doc();
    Y.applyUpdateV2(clientDoc, new Uint8Array(result.diff as ArrayBuffer));

    // Verify updated values
    const fields = clientDoc.getMap("fields");
    expect(readRegister(fields, "title")).toBe("Updated title");
    expect(readRegister(fields, "body")).toBe("Updated body");

    // Resolve again — client should now be up to date
    const clientVector = Y.encodeStateVector(clientDoc);
    const results2 = await t.query(api.tasks.resolve, {
      documents: [
        {
          docId: taskId as string,
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

    const results = await t.query(api.tasks.resolve, {
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
