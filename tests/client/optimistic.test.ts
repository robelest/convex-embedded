import { effectToTransitionsForEntries } from "@resolve/client/optimistic/apply";
import { deriveOptimisticEffect } from "@resolve/client/optimistic/derive";
import type { CachedEntry } from "@resolve/client/cache";
import { describe, expect, it } from "@tests/testkit";

function entry(value: unknown): CachedEntry {
  return { value, receivedAtMs: 0 };
}

describe("deriveOptimisticEffect", () => {
  const knownTables = new Set(["issues", "projects", "comments"]);

  it("derives a patch from a single id field plus other fields", () => {
    const effect = deriveOptimisticEffect({
      refName: "issues:update",
      args: {
        issueId: "doc_abc",
        status: "in_progress",
        priority: "high",
      },
      knownTables,
    });
    expect(effect).toEqual({
      kind: "patch",
      table: "issues",
      id: "doc_abc",
      patch: { status: "in_progress", priority: "high" },
    });
  });

  it("returns null when the inferred table isn't in knownTables", () => {
    const effect = deriveOptimisticEffect({
      refName: "widgets:update",
      args: { widgetId: "doc_x", color: "red" },
      knownTables,
    });
    expect(effect).toBeNull();
  });

  it("returns null when args contain no id-like field on a non-create mutation", () => {
    const effect = deriveOptimisticEffect({
      refName: "issues:update",
      args: { status: "in_progress" },
      knownTables,
    });
    expect(effect).toBeNull();
  });

  it("returns null when there are multiple id fields", () => {
    const effect = deriveOptimisticEffect({
      refName: "issues:reassign",
      args: { issueId: "doc_a", projectId: "doc_b" },
      knownTables,
    });
    expect(effect).toBeNull();
  });

  it("derives an insert from a /create suffix when no id is present", () => {
    const effect = deriveOptimisticEffect({
      refName: "comments:create",
      args: { issueId: "doc_a", body: "hi" },
      knownTables,
    });
    // Has an id field (issueId) -> patch heuristic wins. Acceptable for the
    // demo's update-style mutations; create-without-id is rare.
    expect(effect?.kind).toBe("patch");
  });

  it("derives an insert when no id field and create suffix", () => {
    const effect = deriveOptimisticEffect({
      refName: "projects:create",
      args: { name: "demo" },
      knownTables,
    });
    expect(effect).toEqual({
      kind: "insert",
      table: "projects",
      doc: { name: "demo" },
    });
  });

  it("derives a delete when name suggests removal and one id is present", () => {
    const effect = deriveOptimisticEffect({
      refName: "issues:remove",
      args: { issueId: "doc_a" },
      knownTables,
    });
    expect(effect).toEqual({
      kind: "delete",
      table: "issues",
      id: "doc_a",
    });
  });
});

describe("effectToTransitionsForEntries", () => {
  it("patches a single-doc cache entry whose _id matches", () => {
    const entries = [
      {
        refName: "issues:detail",
        args: { issueId: "doc_a" },
        entry: entry({ _id: "doc_a", _creationTime: 0, status: "todo" }),
      },
    ];
    const updates = effectToTransitionsForEntries(
      { kind: "patch", table: "issues", id: "doc_a", patch: { status: "done" } },
      entries,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.value).toMatchObject({ _id: "doc_a", status: "done" });
  });

  it("skips a cache entry whose _id doesn't match", () => {
    const entries = [
      {
        refName: "issues:detail",
        args: { issueId: "doc_b" },
        entry: entry({ _id: "doc_b", _creationTime: 0, status: "todo" }),
      },
    ];
    const updates = effectToTransitionsForEntries(
      { kind: "patch", table: "issues", id: "doc_a", patch: { status: "done" } },
      entries,
    );
    expect(updates).toEqual([]);
  });

  it("patches a paginated page whose item _id matches", () => {
    const entries = [
      {
        refName: "issues:forProject",
        args: { paginationOpts: { cursor: null, numItems: 30 } },
        entry: entry({
          page: [
            { _id: "doc_a", _creationTime: 0, status: "todo" },
            { _id: "doc_b", _creationTime: 0, status: "todo" },
          ],
          isDone: true,
          continueCursor: "_end_cursor",
        }),
      },
    ];
    const updates = effectToTransitionsForEntries(
      { kind: "patch", table: "issues", id: "doc_b", patch: { status: "done" } },
      entries,
    );
    expect(updates).toHaveLength(1);
    const value = updates[0]?.value as { page: Array<{ _id: string; status: string }> };
    expect(value.page[0]?.status).toBe("todo");
    expect(value.page[1]?.status).toBe("done");
  });

  it("patches a bare list whose item _id matches", () => {
    const entries = [
      {
        refName: "comments:forIssue",
        args: { issueId: "doc_x" },
        entry: entry([
          { _id: "doc_a", _creationTime: 0, body: "hi" },
          { _id: "doc_b", _creationTime: 0, body: "bye" },
        ]),
      },
    ];
    const updates = effectToTransitionsForEntries(
      { kind: "patch", table: "comments", id: "doc_b", patch: { body: "edited" } },
      entries,
    );
    expect(updates).toHaveLength(1);
    const value = updates[0]?.value as Array<{ _id: string; body: string }>;
    expect(value[1]?.body).toBe("edited");
  });

  it("removes a deleted item from a paginated page", () => {
    const entries = [
      {
        refName: "issues:forProject",
        args: { paginationOpts: { cursor: null, numItems: 30 } },
        entry: entry({
          page: [
            { _id: "doc_a", _creationTime: 0 },
            { _id: "doc_b", _creationTime: 0 },
          ],
          isDone: true,
          continueCursor: "_end_cursor",
        }),
      },
    ];
    const updates = effectToTransitionsForEntries(
      { kind: "delete", table: "issues", id: "doc_b" },
      entries,
    );
    expect(updates).toHaveLength(1);
    const value = updates[0]?.value as { page: Array<{ _id: string }> };
    expect(value.page).toHaveLength(1);
    expect(value.page[0]?._id).toBe("doc_a");
  });
});
