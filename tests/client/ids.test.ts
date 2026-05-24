import { IdMap } from "@resolve/client/ids";
import type { LocalDocumentPresenceFn } from "@resolve/client/ids";
import { describe, expect, it, vi } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

interface MockSystemClient {
  query: ReturnType<typeof vi.fn>;
  mutation: ReturnType<typeof vi.fn>;
}

function createMockClient(): MockSystemClient {
  return {
    query: vi.fn(),
    mutation: vi.fn(),
  };
}

function asConvexClient(client: MockSystemClient): ConvexClient {
  return client as unknown as ConvexClient;
}

function createIdMap(
  options: {
    identityKey?: string | null;
    hasLocalDocumentId?: LocalDocumentPresenceFn;
  } = {},
) {
  const mockClient = createMockClient();
  const state = { identityKey: options.identityKey ?? null };
  const idMap = new IdMap(
    asConvexClient(mockClient),
    undefined,
    undefined,
    () => state.identityKey,
    options.hasLocalDocumentId,
  );
  return { idMap, mockClient, state };
}

describe("IdMap", () => {
  describe("hydrate()", () => {
    it("loads entries from client query into cache", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.query.mockResolvedValue([
        { localId: "local-1", remoteId: "remote-1", table: "tasks" },
        { localId: "local-2", remoteId: "remote-2", table: "tasks" },
      ]);

      await idMap.hydrate();

      expect(idMap.size).toBe(2);
      expect(mockClient.query).toHaveBeenCalledWith("_system:idMapGetAll", {
        identityKey: null,
      });
    });

    it("handles empty result", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.query.mockResolvedValue([]);

      await idMap.hydrate();

      expect(idMap.size).toBe(0);
    });

    it("recovers gracefully on error (cache stays empty, does not throw)", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.query.mockRejectedValue(new Error("DB unavailable"));

      await idMap.hydrate();

      expect(idMap.size).toBe(0);
    });

    it("populates getRemoteId after hydration", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.query.mockResolvedValue([
        { localId: "local-1", remoteId: "remote-1", table: "tasks" },
        { localId: "local-2", remoteId: "remote-2", table: "tasks" },
      ]);

      await idMap.hydrate();

      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
      expect(idMap.getRemoteId("local-2")).toBe("remote-2");
    });

    it("populates getLocalId (reverse mapping) after hydration", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.query.mockResolvedValue([
        { localId: "local-1", remoteId: "remote-1", table: "tasks" },
        { localId: "local-2", remoteId: "remote-2", table: "tasks" },
      ]);

      await idMap.hydrate();

      expect(idMap.getLocalId("remote-1")).toBe("local-1");
      expect(idMap.getLocalId("remote-2")).toBe("local-2");
    });

    it("clears stale cache entries before rehydrating", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-stale", "remote-stale", "tasks");

      mockClient.query.mockResolvedValue([
        { localId: "local-1", remoteId: "remote-1", table: "tasks" },
      ]);

      await idMap.hydrate();

      expect(idMap.size).toBe(1);
      expect(idMap.getRemoteId("local-stale")).toBeNull();
      expect(idMap.getLocalId("remote-stale")).toBeNull();
      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
    });
  });

  describe("set()", () => {
    it("updates in-memory cache immediately", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);

      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
    });

    it("calls client mutation with correct args", async () => {
      const { idMap, mockClient } = createIdMap({ identityKey: "user:alice" });
      mockClient.mutation.mockResolvedValue(null);

      await idMap.set("local-1", "remote-1", "tasks");

      expect(mockClient.mutation).toHaveBeenCalledWith("_system:idMapSet", {
        localId: "local-1",
        remoteId: "remote-1",
        table: "tasks",
        identityKey: "user:alice",
      });
    });

    it("updates reverse cache", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);

      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.getLocalId("remote-1")).toBe("local-1");
    });

    it("overwrites existing mapping for same localId", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);

      await idMap.set("local-1", "remote-1", "tasks");
      await idMap.set("local-1", "remote-2", "tasks");

      expect(idMap.getRemoteId("local-1")).toBe("remote-2");
      expect(idMap.size).toBe(1);
    });

    it("removes the stale reverse mapping when overwriting a localId", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);

      await idMap.set("local-1", "remote-1", "tasks");
      await idMap.set("local-1", "remote-2", "tasks");

      expect(idMap.getLocalId("remote-1")).toBeNull();
      expect(idMap.getLocalId("remote-2")).toBe("local-1");
    });

    it("recovers gracefully on storage failure (cache still updated)", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockRejectedValue(new Error("persist failed"));

      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
      expect(idMap.getLocalId("remote-1")).toBe("local-1");
    });
  });

  describe("delete()", () => {
    it("removes from forward cache", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");

      await idMap.delete("local-1");

      expect(idMap.getRemoteId("local-1")).toBeNull();
    });

    it("removes from reverse cache", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");

      await idMap.delete("local-1");

      expect(idMap.getLocalId("remote-1")).toBeNull();
    });

    it("calls client mutation with correct args", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");
      mockClient.mutation.mockClear();

      await idMap.delete("local-1");

      expect(mockClient.mutation).toHaveBeenCalledWith("_system:idMapDelete", {
        localId: "local-1",
        identityKey: null,
      });
    });

    it("is safe for unknown localId (no error)", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);

      await idMap.delete("nonexistent");

      expect(mockClient.mutation).toHaveBeenCalledWith("_system:idMapDelete", {
        localId: "nonexistent",
        identityKey: null,
      });
    });
  });

  describe("read helpers", () => {
    it("getRemoteId returns null for unknown id", () => {
      const { idMap } = createIdMap();
      expect(idMap.getRemoteId("unknown")).toBeNull();
    });

    it("getLocalId returns null for unknown id", () => {
      const { idMap } = createIdMap();
      expect(idMap.getLocalId("unknown")).toBeNull();
    });

    it("hasLocalId returns true for known id", async () => {
      const { idMap, mockClient } = createIdMap();
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.hasLocalId("local-1")).toBe(true);
    });

    it("hasLocalId returns false for unknown id", () => {
      const { idMap } = createIdMap();
      expect(idMap.hasLocalId("unknown")).toBe(false);
    });

    it("size reflects cache size", async () => {
      const { idMap, mockClient } = createIdMap();
      expect(idMap.size).toBe(0);

      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");
      expect(idMap.size).toBe(1);

      await idMap.set("local-2", "remote-2", "tasks");
      expect(idMap.size).toBe(2);
    });

    it("prefers a canonical local document over a provisional alias", async () => {
      const hasLocalDocumentId = vi.fn((id: string) => id === "remote-1");
      const { idMap, mockClient } = createIdMap({ hasLocalDocumentId });
      mockClient.mutation.mockResolvedValue(null);

      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.translateRemoteIdsToLocal({ issueId: "remote-1" })).toEqual({
        issueId: "remote-1",
      });
      expect(
        idMap.translateClientIdsToRuntime({ issueId: "remote-1" }),
      ).toEqual({ issueId: "remote-1" });
    });
  });

  describe("translateArgs()", () => {
    async function seededIdMap() {
      const created = createIdMap();
      created.mockClient.mutation.mockResolvedValue(null);
      await created.idMap.set("local-1", "remote-1", "tasks");
      await created.idMap.set("local-2", "remote-2", "tasks");
      return created;
    }

    it("translates string values that are known local IDs", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({ id: "local-1" });

      expect(result).toEqual({ id: "remote-1" });
    });

    it("leaves unknown strings unchanged", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({ name: "hello" });

      expect(result).toEqual({ name: "hello" });
    });

    it("deep-walks nested objects", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({
        outer: { inner: { issueId: "local-2" } },
      });

      expect(result).toEqual({
        outer: { inner: { issueId: "remote-2" } },
      });
    });

    it("deep-walks arrays", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({
        issueIds: ["local-1", "local-2", "unrelated"],
      });

      expect(result).toEqual({
        issueIds: ["remote-1", "remote-2", "unrelated"],
      });
    });

    it("leaves non-string primitives unchanged", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({
        count: 42,
        active: true,
        nothing: null,
      });

      expect(result).toEqual({
        count: 42,
        active: true,
        nothing: null,
      });
    });

    it("returns a new object (does not mutate original)", async () => {
      const { idMap } = await seededIdMap();
      const original = {
        issueId: "local-1",
        nested: { assigneeId: "local-2" },
      };
      const result = idMap.translateArgs(original);

      expect(result).not.toBe(original);
      expect(original.issueId).toBe("local-1");
      expect(original.nested.assigneeId).toBe("local-2");
    });

    it("does not rewrite non-id string fields that happen to match local ids", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({
        title: "local-1",
        nested: { note: "local-2" },
      });

      expect(result).toEqual({
        title: "local-1",
        nested: { note: "local-2" },
      });
    });

    it("handles empty args", async () => {
      const { idMap } = await seededIdMap();
      const result = idMap.translateArgs({});

      expect(result).toEqual({});
    });
  });
});
