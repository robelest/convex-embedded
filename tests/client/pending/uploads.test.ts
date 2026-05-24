import { PendingUploadQueue } from "@resolve/client/pending/uploads";
import type { PendingUploadEntry } from "@resolve/client/pending/uploads";
import { describe, expect, it, vi } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

interface MockSystemClient {
  query: ReturnType<typeof vi.fn>;
  mutation: ReturnType<typeof vi.fn>;
}

function createQueue(identityKey: string | null = null) {
  const mockClient: MockSystemClient = {
    query: vi.fn(),
    mutation: vi.fn(),
  };
  const queue = new PendingUploadQueue(
    mockClient as unknown as ConvexClient,
    undefined,
    undefined,
    () => identityKey,
  );
  return { queue, mockClient };
}

describe("PendingUploadQueue.hydrate", () => {
  it("loads rows from _system:pendingUploadGetAll", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.query.mockResolvedValue([
      {
        _id: "row-1",
        localStorageId: "blob-1",
        sha256: "abc",
        size: 100,
        contentType: "image/png",
        identityKey: null,
        state: "pending",
      },
    ]);

    await queue.hydrate();

    expect(mockClient.query).toHaveBeenCalledWith(
      "_system:pendingUploadGetAll",
      { identityKey: null },
    );
    expect(queue.length).toBe(1);
    expect(queue.entries()[0]?.localStorageId).toBe("blob-1");
  });

  it("recovers gracefully when the query throws", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.query.mockRejectedValue(new Error("offline"));

    await queue.hydrate();

    expect(queue.length).toBe(0);
  });
});

describe("PendingUploadQueue.push", () => {
  it("persists via pendingUploadPush and tracks in memory", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation.mockResolvedValue("row-99");

    await queue.push({
      localStorageId: "blob-99",
      sha256: "deadbeef",
      size: 1234,
      contentType: "image/jpeg",
    });

    expect(mockClient.mutation).toHaveBeenCalledWith(
      "_system:pendingUploadPush",
      expect.objectContaining({
        localStorageId: "blob-99",
        sha256: "deadbeef",
        size: 1234,
        contentType: "image/jpeg",
        identityKey: null,
      }),
    );
    expect(queue.length).toBe(1);
    expect(queue.entries()[0]?._id).toBe("row-99");
  });

  it("dedups by localStorageId (in-memory check before persistence)", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation.mockResolvedValue("row-1");

    await queue.push({
      localStorageId: "blob-1",
      sha256: "x",
      size: 1,
      contentType: "x",
    });
    await queue.push({
      localStorageId: "blob-1",
      sha256: "x",
      size: 1,
      contentType: "x",
    });

    expect(mockClient.mutation).toHaveBeenCalledTimes(1);
    expect(queue.length).toBe(1);
  });

  it("falls back to ephemeral entry when persistence fails", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation.mockRejectedValue(new Error("disk full"));

    await queue.push({
      localStorageId: "blob-2",
      sha256: "y",
      size: 1,
      contentType: "y",
    });

    expect(queue.length).toBe(1);
    expect(queue.entries()[0]?._id.startsWith("ephemeral_")).toBe(true);
  });
});

describe("PendingUploadQueue.claimNext / remove", () => {
  it("claim returns the persisted row and remove deletes it", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation
      .mockResolvedValueOnce({
        _id: "row-1",
        localStorageId: "blob-1",
        sha256: "x",
        size: 1,
        contentType: "x",
        state: "processing",
        owner: "proc-A",
      })
      .mockResolvedValueOnce(true);

    const claimed = await queue.claimNext("proc-A");
    expect(claimed?._id).toBe("row-1");
    expect(claimed?.state).toBe("processing");
    expect(mockClient.mutation).toHaveBeenNthCalledWith(
      1,
      "_system:pendingUploadClaimNext",
      expect.objectContaining({ owner: "proc-A", identityKey: null }),
    );

    await queue.remove(claimed!, "proc-A");
    expect(mockClient.mutation).toHaveBeenNthCalledWith(
      2,
      "_system:pendingUploadRemove",
      { id: "row-1", owner: "proc-A" },
    );
    expect(queue.length).toBe(0);
  });

  it("claim returns undefined when there is nothing to drain", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation.mockResolvedValueOnce(null);

    const claimed = await queue.claimNext("proc-A");

    expect(claimed).toBeUndefined();
  });
});

describe("PendingUploadQueue.release / renewLease", () => {
  it("release patches the row back to pending state", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation.mockResolvedValueOnce(null);

    await queue.release(
      {
        _id: "row-1",
        localStorageId: "blob-1",
        sha256: "x",
        size: 1,
        contentType: "x",
        state: "processing",
        owner: "proc-A",
      },
      "proc-A",
    );

    expect(mockClient.mutation).toHaveBeenCalledWith(
      "_system:pendingUploadRelease",
      { id: "row-1", owner: "proc-A" },
    );
  });

  it("renewLease forwards to the system mutation and refreshes the local view", async () => {
    const { queue, mockClient } = createQueue();
    mockClient.mutation.mockResolvedValueOnce(true);
    const entry: PendingUploadEntry = {
      _id: "row-1",
      localStorageId: "blob-1",
      sha256: "x",
      size: 1,
      contentType: "x",
      state: "processing",
      owner: "proc-A",
    };

    const ok = await queue.renewLease(entry, "proc-A", 5_000);

    expect(ok).toBe(true);
    expect(entry.leaseExpiresAt).toBeGreaterThan(0);
    expect(mockClient.mutation).toHaveBeenCalledWith(
      "_system:pendingUploadRenewLease",
      { id: "row-1", owner: "proc-A", leaseMs: 5_000 },
    );
  });

  it("renewLease returns true for ephemeral entries without a server call", async () => {
    const { queue, mockClient } = createQueue();
    const entry: PendingUploadEntry = {
      _id: "ephemeral_1",
      localStorageId: "blob-1",
      sha256: "x",
      size: 1,
      contentType: "x",
      state: "processing",
    };

    const ok = await queue.renewLease(entry, "proc-A");

    expect(ok).toBe(true);
    expect(mockClient.mutation).not.toHaveBeenCalled();
  });
});
