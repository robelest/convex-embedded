import { describe, it, expect, vi, beforeEach } from "vitest";

import { PendingQueue } from "#resolve/client/pending-queue";

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

const mockClient = {
  query: vi.fn(),
  mutation: vi.fn(),
};

let queue: PendingQueue;

beforeEach(() => {
  vi.clearAllMocks();
  queue = new PendingQueue(mockClient as any);
});

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

describe("hydrate()", () => {
  it("loads entries from client query", async () => {
    mockClient.query.mockResolvedValue([
      {
        _id: "doc-1",
        ref: "tasks:create",
        args: '{"title":"hello"}',
        localResult: '"uuid-1"',
        table: "tasks",
      },
    ]);

    await queue.hydrate();

    expect(mockClient.query).toHaveBeenCalledWith("_system:pendingGetAll", {});
    expect(queue.length).toBe(1);
  });

  it("handles empty result", async () => {
    mockClient.query.mockResolvedValue([]);

    await queue.hydrate();

    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });

  it("recovers gracefully on error (queue stays empty)", async () => {
    mockClient.query.mockRejectedValue(new Error("DB unavailable"));

    await queue.hydrate();

    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });

  it("after hydration, length and peek() reflect loaded data", async () => {
    mockClient.query.mockResolvedValue([
      {
        _id: "doc-1",
        ref: "tasks:create",
        args: '{"title":"hello"}',
        localResult: '"uuid-1"',
        table: "tasks",
      },
      {
        _id: "doc-2",
        ref: "tasks:update",
        args: '{"id":"1","title":"updated"}',
        localResult: "null",
        table: "tasks",
      },
    ]);

    await queue.hydrate();

    expect(queue.length).toBe(2);
    expect(queue.isEmpty).toBe(false);

    const first = queue.peek();
    expect(first).toBeDefined();
    expect(first!._id).toBe("doc-1");
    expect(first!.ref).toBe("tasks:create");
  });
});

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

describe("push()", () => {
  it("stores function name string and JSON-serializes args/localResult", async () => {
    mockClient.mutation.mockResolvedValue("doc-1");

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");

    expect(mockClient.mutation).toHaveBeenCalledWith("_system:pendingPush", {
      ref: "tasks:create",
      args: JSON.stringify({ title: "test" }),
      localResult: JSON.stringify("uuid-1"),
      table: "tasks",
    });
  });

  it("increments length", async () => {
    mockClient.mutation.mockResolvedValue("doc-1");

    expect(queue.length).toBe(0);
    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");
    expect(queue.length).toBe(1);
  });

  it("entries appear in peek()", async () => {
    mockClient.mutation.mockResolvedValue("doc-1");

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");

    const entry = queue.peek();
    expect(entry).toBeDefined();
    expect(entry!._id).toBe("doc-1");
    expect(entry!.ref).toBe("tasks:create");
    expect(entry!.args).toBe(JSON.stringify({ title: "test" }));
    expect(entry!.localResult).toBe(JSON.stringify("uuid-1"));
    expect(entry!.table).toBe("tasks");
  });

  it("multiple pushes maintain FIFO order", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1")
      .mockResolvedValueOnce("doc-2")
      .mockResolvedValueOnce("doc-3");

    await queue.push("tasks:create", { title: "first" }, "uuid-1", "tasks");
    await queue.push("tasks:create", { title: "second" }, "uuid-2", "tasks");
    await queue.push("tasks:create", { title: "third" }, "uuid-3", "tasks");

    expect(queue.length).toBe(3);
    expect(queue.peek()!._id).toBe("doc-1");
    expect(queue.peek()!.args).toBe(JSON.stringify({ title: "first" }));
  });

  it("recovers on persistence failure (still adds ephemeral entry)", async () => {
    mockClient.mutation.mockRejectedValue(new Error("write failed"));

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");

    expect(queue.length).toBe(1);

    const entry = queue.peek();
    expect(entry).toBeDefined();
    expect(entry!._id).toMatch(/^ephemeral_/);
    expect(entry!.ref).toBe("tasks:create");
    expect(entry!.table).toBe("tasks");
  });
});

// ---------------------------------------------------------------------------
// Peek
// ---------------------------------------------------------------------------

describe("peek()", () => {
  it("returns undefined on empty queue", () => {
    expect(queue.peek()).toBeUndefined();
  });

  it("returns first entry without removing it", async () => {
    mockClient.mutation.mockResolvedValue("doc-1");

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");

    const first = queue.peek();
    const second = queue.peek();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).toEqual(second);
    expect(queue.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Shift
// ---------------------------------------------------------------------------

describe("shift()", () => {
  it("removes first entry and returns it", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1") // push
      .mockResolvedValueOnce(null); // shift remove

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");
    expect(queue.length).toBe(1);

    const entry = await queue.shift();

    expect(entry).toBeDefined();
    expect(entry!._id).toBe("doc-1");
    expect(queue.length).toBe(0);
  });

  it("calls client mutation to remove from DB", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1") // push
      .mockResolvedValueOnce(null); // shift remove

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");
    mockClient.mutation.mockClear();
    mockClient.mutation.mockResolvedValue(null);

    await queue.shift();

    expect(mockClient.mutation).toHaveBeenCalledWith("_system:pendingRemove", {
      id: "doc-1",
    });
  });

  it("returns undefined on empty queue", async () => {
    const entry = await queue.shift();
    expect(entry).toBeUndefined();
  });

  it("decrements length", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1") // push 1
      .mockResolvedValueOnce("doc-2") // push 2
      .mockResolvedValueOnce(null); // shift remove

    await queue.push("tasks:create", { title: "first" }, "uuid-1", "tasks");
    await queue.push("tasks:create", { title: "second" }, "uuid-2", "tasks");
    expect(queue.length).toBe(2);

    await queue.shift();
    expect(queue.length).toBe(1);
  });

  it("skips the remove call for ephemeral entries", async () => {
    mockClient.mutation.mockRejectedValueOnce(new Error("write failed"));

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");
    expect(queue.peek()!._id).toMatch(/^ephemeral_/);

    mockClient.mutation.mockClear();

    const entry = await queue.shift();

    expect(entry).toBeDefined();
    expect(entry!._id).toMatch(/^ephemeral_/);
    expect(mockClient.mutation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

describe("clear()", () => {
  it("removes all entries", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1")
      .mockResolvedValueOnce("doc-2")
      .mockResolvedValueOnce(null); // clear call

    await queue.push("tasks:create", { title: "first" }, "uuid-1", "tasks");
    await queue.push("tasks:create", { title: "second" }, "uuid-2", "tasks");
    expect(queue.length).toBe(2);

    await queue.clear();

    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });

  it("calls client mutation", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1") // push
      .mockResolvedValueOnce(null); // clear call

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");
    mockClient.mutation.mockClear();
    mockClient.mutation.mockResolvedValue(null);

    await queue.clear();

    expect(mockClient.mutation).toHaveBeenCalledWith(
      "_system:pendingClear",
      {},
    );
  });

  it("on empty queue is safe", async () => {
    mockClient.mutation.mockResolvedValue(null);

    await queue.clear();

    expect(queue.length).toBe(0);
    expect(queue.isEmpty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Length / isEmpty
// ---------------------------------------------------------------------------

describe("length and isEmpty", () => {
  it("isEmpty is true initially", () => {
    expect(queue.isEmpty).toBe(true);
  });

  it("isEmpty is false after push", async () => {
    mockClient.mutation.mockResolvedValue("doc-1");

    await queue.push("tasks:create", { title: "test" }, "uuid-1", "tasks");

    expect(queue.isEmpty).toBe(false);
  });

  it("length is 0 initially", () => {
    expect(queue.length).toBe(0);
  });

  it("length increments on push, decrements on shift", async () => {
    mockClient.mutation
      .mockResolvedValueOnce("doc-1") // push
      .mockResolvedValueOnce("doc-2") // push
      .mockResolvedValueOnce(null); // shift remove

    expect(queue.length).toBe(0);

    await queue.push("tasks:create", { title: "first" }, "uuid-1", "tasks");
    expect(queue.length).toBe(1);

    await queue.push("tasks:create", { title: "second" }, "uuid-2", "tasks");
    expect(queue.length).toBe(2);

    await queue.shift();
    expect(queue.length).toBe(1);
  });
});
