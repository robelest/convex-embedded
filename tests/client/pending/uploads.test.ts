import { PendingUploadQueue } from "@resolve/client/pending/uploads";
import { beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

const mockClient = {
  query: vi.fn(),
  mutation: vi.fn(),
};

let queue: PendingUploadQueue;
let identityKey: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  identityKey = null;
  queue = new PendingUploadQueue(
    mockClient as any,
    undefined,
    undefined,
    () => identityKey,
  );
});

describe("PendingUploadQueue.hydrate", () => {
  it("loads rows from _system:pendingUploadGetAll", async () => {
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
    mockClient.query.mockRejectedValue(new Error("offline"));
    await queue.hydrate();
    expect(queue.length).toBe(0);
  });
});

describe("PendingUploadQueue.push", () => {
  it("persists via pendingUploadPush and tracks in memory", async () => {
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
    mockClient.mutation.mockResolvedValueOnce(null);
    const claimed = await queue.claimNext("proc-A");
    expect(claimed).toBeUndefined();
  });
});

describe("PendingUploadQueue.release / renewLease", () => {
  it("release patches the row back to pending state", async () => {
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
    mockClient.mutation.mockResolvedValueOnce(true);
    const entry = {
      _id: "row-1",
      localStorageId: "blob-1",
      sha256: "x",
      size: 1,
      contentType: "x",
      state: "processing" as const,
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
    const entry = {
      _id: "ephemeral_1",
      localStorageId: "blob-1",
      sha256: "x",
      size: 1,
      contentType: "x",
      state: "processing" as const,
    };
    const ok = await queue.renewLease(entry, "proc-A");
    expect(ok).toBe(true);
    expect(mockClient.mutation).not.toHaveBeenCalled();
  });
});
