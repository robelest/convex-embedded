import { IdMap } from "@resolve/client/id-map";
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";

describe("IdMap", () => {
  let mockClient: {
    query: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
  };
  let idMap: IdMap;
  let activeIdentityKey: string | null;

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutation: vi.fn(),
    };
    activeIdentityKey = null;
    idMap = new IdMap(
      mockClient as any,
      undefined,
      undefined,
      () => activeIdentityKey,
    );
  });

  // ---------------------------------------------------------------------------
  // Hydration
  // ---------------------------------------------------------------------------

  describe("hydrate()", () => {
    it("loads entries from client query into cache", async () => {
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
      mockClient.query.mockResolvedValue([]);

      await idMap.hydrate();

      expect(idMap.size).toBe(0);
    });

    it("recovers gracefully on error (cache stays empty, does not throw)", async () => {
      mockClient.query.mockRejectedValue(new Error("DB unavailable"));

      await idMap.hydrate();

      expect(idMap.size).toBe(0);
    });

    it("populates getRemoteId after hydration", async () => {
      mockClient.query.mockResolvedValue([
        { localId: "local-1", remoteId: "remote-1", table: "tasks" },
        { localId: "local-2", remoteId: "remote-2", table: "tasks" },
      ]);

      await idMap.hydrate();

      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
      expect(idMap.getRemoteId("local-2")).toBe("remote-2");
    });

    it("populates getLocalId (reverse mapping) after hydration", async () => {
      mockClient.query.mockResolvedValue([
        { localId: "local-1", remoteId: "remote-1", table: "tasks" },
        { localId: "local-2", remoteId: "remote-2", table: "tasks" },
      ]);

      await idMap.hydrate();

      expect(idMap.getLocalId("remote-1")).toBe("local-1");
      expect(idMap.getLocalId("remote-2")).toBe("local-2");
    });

    it("clears stale cache entries before rehydrating", async () => {
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

  // ---------------------------------------------------------------------------
  // Set
  // ---------------------------------------------------------------------------

  describe("set()", () => {
    beforeEach(() => {
      mockClient.mutation.mockResolvedValue(null);
    });

    it("updates in-memory cache immediately", async () => {
      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
    });

    it("calls client mutation with correct args", async () => {
      activeIdentityKey = "user:alice";
      await idMap.set("local-1", "remote-1", "tasks");

      expect(mockClient.mutation).toHaveBeenCalledWith("_system:idMapSet", {
        localId: "local-1",
        remoteId: "remote-1",
        table: "tasks",
        identityKey: "user:alice",
      });
    });

    it("updates reverse cache", async () => {
      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.getLocalId("remote-1")).toBe("local-1");
    });

    it("overwrites existing mapping for same localId", async () => {
      await idMap.set("local-1", "remote-1", "tasks");
      await idMap.set("local-1", "remote-2", "tasks");

      expect(idMap.getRemoteId("local-1")).toBe("remote-2");
      expect(idMap.size).toBe(1);
    });

    it("removes the stale reverse mapping when overwriting a localId", async () => {
      await idMap.set("local-1", "remote-1", "tasks");
      await idMap.set("local-1", "remote-2", "tasks");

      expect(idMap.getLocalId("remote-1")).toBeNull();
      expect(idMap.getLocalId("remote-2")).toBe("local-1");
    });

    it("recovers gracefully on persistence failure (cache still updated)", async () => {
      mockClient.mutation.mockRejectedValue(new Error("persist failed"));

      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.getRemoteId("local-1")).toBe("remote-1");
      expect(idMap.getLocalId("remote-1")).toBe("local-1");
    });
  });

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------

  describe("delete()", () => {
    beforeEach(async () => {
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");
      mockClient.mutation.mockClear();
      mockClient.mutation.mockResolvedValue(null);
    });

    it("removes from forward cache", async () => {
      await idMap.delete("local-1");

      expect(idMap.getRemoteId("local-1")).toBeNull();
    });

    it("removes from reverse cache", async () => {
      await idMap.delete("local-1");

      expect(idMap.getLocalId("remote-1")).toBeNull();
    });

    it("calls client mutation with correct args", async () => {
      await idMap.delete("local-1");

      expect(mockClient.mutation).toHaveBeenCalledWith("_system:idMapDelete", {
        localId: "local-1",
        identityKey: null,
      });
    });

    it("is safe for unknown localId (no error)", async () => {
      await idMap.delete("nonexistent");

      expect(mockClient.mutation).toHaveBeenCalledWith("_system:idMapDelete", {
        localId: "nonexistent",
        identityKey: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  describe("read helpers", () => {
    it("getRemoteId returns null for unknown id", () => {
      expect(idMap.getRemoteId("unknown")).toBeNull();
    });

    it("getLocalId returns null for unknown id", () => {
      expect(idMap.getLocalId("unknown")).toBeNull();
    });

    it("hasLocalId returns true for known id", async () => {
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");

      expect(idMap.hasLocalId("local-1")).toBe(true);
    });

    it("hasLocalId returns false for unknown id", () => {
      expect(idMap.hasLocalId("unknown")).toBe(false);
    });

    it("size reflects cache size", async () => {
      expect(idMap.size).toBe(0);

      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");
      expect(idMap.size).toBe(1);

      await idMap.set("local-2", "remote-2", "tasks");
      expect(idMap.size).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // translateArgs
  // ---------------------------------------------------------------------------

  describe("translateArgs()", () => {
    beforeEach(async () => {
      mockClient.mutation.mockResolvedValue(null);
      await idMap.set("local-1", "remote-1", "tasks");
      await idMap.set("local-2", "remote-2", "tasks");
    });

    it("translates string values that are known local IDs", () => {
      const result = idMap.translateArgs({ id: "local-1" });

      expect(result).toEqual({ id: "remote-1" });
    });

    it("leaves unknown strings unchanged", () => {
      const result = idMap.translateArgs({ name: "hello" });

      expect(result).toEqual({ name: "hello" });
    });

    it("deep-walks nested objects", () => {
      const result = idMap.translateArgs({
        outer: { inner: { ref: "local-2" } },
      });

      expect(result).toEqual({
        outer: { inner: { ref: "remote-2" } },
      });
    });

    it("deep-walks arrays", () => {
      const result = idMap.translateArgs({
        ids: ["local-1", "local-2", "unrelated"],
      });

      expect(result).toEqual({
        ids: ["remote-1", "remote-2", "unrelated"],
      });
    });

    it("leaves non-string primitives unchanged", () => {
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

    it("returns a new object (does not mutate original)", () => {
      const original = { ref: "local-1", nested: { ref: "local-2" } };
      const result = idMap.translateArgs(original);

      expect(result).not.toBe(original);
      expect(original.ref).toBe("local-1");
      expect((original.nested as any).ref).toBe("local-2");
    });

    it("handles empty args", () => {
      const result = idMap.translateArgs({});

      expect(result).toEqual({});
    });
  });
});
