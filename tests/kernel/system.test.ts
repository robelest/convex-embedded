import {
  SYSTEM_FUNCTIONS,
  SystemPaths,
  type SystemFunctionDef,
} from "@embedded/kernel/system";
import type { Database } from "@embedded/runtime/db/database";
import { describe, expect, it, vi } from "@tests/testkit";

type SystemPath = (typeof SystemPaths)[keyof typeof SystemPaths];

interface IdMapRow {
  localId: string;
  remoteId: string;
  table: string;
  identityKey?: string | null;
}

interface PendingRow {
  _id: string;
  ref: string;
  args: string;
  localResult: string;
  table: string;
  createdAt?: number;
  identityKey?: string | null;
  state?: string;
  owner?: string;
  blockedReason?: string;
  leaseExpiresAt?: number;
}

function runSystem<T>(
  db: Database,
  path: SystemPath,
  args: Record<string, unknown> = {},
): Promise<T> {
  return Promise.resolve(SYSTEM_FUNCTIONS[path].handler(db, args) as T);
}

describe("ID map", () => {
  it("idMapSet inserts a new mapping and returns null", async ({ db }) => {
    db.startTransaction();
    const result = await runSystem(db, SystemPaths.idMapSet, {
      localId: "local-1",
      remoteId: "remote-1",
      table: "tasks",
    });
    db.commit();

    expect(result).toBeNull();

    db.startTransaction();
    const remoteId = await runSystem<string | null>(db, SystemPaths.idMapGet, {
      localId: "local-1",
    });
    db.rollbackWrites();

    expect(remoteId).toBe("remote-1");
  });

  it("idMapSet updates an existing mapping in place", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "local-1",
      remoteId: "remote-1",
      table: "tasks",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "local-1",
      remoteId: "remote-2",
      table: "notes",
    });
    db.commit();

    db.startTransaction();
    const remoteId = await runSystem<string | null>(db, SystemPaths.idMapGet, {
      localId: "local-1",
    });
    const all = await runSystem<IdMapRow[]>(db, SystemPaths.idMapGetAll);
    db.rollbackWrites();

    expect(remoteId).toBe("remote-2");
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      localId: "local-1",
      remoteId: "remote-2",
      table: "notes",
    });
  });

  it("idMapGet returns the remoteId for a known localId", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "local-a",
      remoteId: "remote-a",
      table: "items",
    });
    db.commit();

    db.startTransaction();
    const result = await runSystem<string | null>(db, SystemPaths.idMapGet, {
      localId: "local-a",
    });
    db.rollbackWrites();

    expect(result).toBe("remote-a");
  });

  it("idMapGet returns null for an unknown localId", async ({ db }) => {
    db.startTransaction();
    const result = await runSystem<string | null>(db, SystemPaths.idMapGet, {
      localId: "does-not-exist",
    });
    db.rollbackWrites();

    expect(result).toBeNull();
  });

  it("idMapGetAll returns all mappings", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "l1",
      remoteId: "r1",
      table: "tasks",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "l2",
      remoteId: "r2",
      table: "notes",
    });
    db.commit();

    db.startTransaction();
    const all = await runSystem<IdMapRow[]>(db, SystemPaths.idMapGetAll);
    db.rollbackWrites();

    expect(all).toEqual(
      expect.arrayContaining([
        { localId: "l1", remoteId: "r1", table: "tasks" },
        { localId: "l2", remoteId: "r2", table: "notes" },
      ]),
    );
    expect(all).toHaveLength(2);
  });

  it("idMapGetAll returns an empty array when no mappings exist", async ({
    db,
  }) => {
    db.startTransaction();
    const all = await runSystem<IdMapRow[]>(db, SystemPaths.idMapGetAll);
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("idMapDelete removes a mapping by localId", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "local-x",
      remoteId: "remote-x",
      table: "tasks",
    });
    db.commit();

    db.startTransaction();
    const deleteResult = await runSystem(db, SystemPaths.idMapDelete, {
      localId: "local-x",
    });
    db.commit();

    expect(deleteResult).toBeNull();

    db.startTransaction();
    const lookup = await runSystem<string | null>(db, SystemPaths.idMapGet, {
      localId: "local-x",
    });
    db.rollbackWrites();

    expect(lookup).toBeNull();
  });

  it("idMapDelete is a no-op for an unknown localId", async ({ db }) => {
    db.startTransaction();
    const result = await runSystem(db, SystemPaths.idMapDelete, {
      localId: "nonexistent",
    });
    db.commit();

    expect(result).toBeNull();
  });

  it("scopes mappings by identityKey", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "shared-local",
      remoteId: "remote-a",
      table: "tasks",
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "shared-local",
      remoteId: "remote-b",
      table: "tasks",
      identityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const allA = await runSystem<IdMapRow[]>(db, SystemPaths.idMapGetAll, {
      identityKey: "user:a",
    });
    const allB = await runSystem<IdMapRow[]>(db, SystemPaths.idMapGetAll, {
      identityKey: "user:b",
    });
    db.rollbackWrites();

    expect(allA).toEqual([
      {
        localId: "shared-local",
        remoteId: "remote-a",
        table: "tasks",
        identityKey: "user:a",
      },
    ]);
    expect(allB).toEqual([
      {
        localId: "shared-local",
        remoteId: "remote-b",
        table: "tasks",
        identityKey: "user:b",
      },
    ]);
  });
});

describe("pending queue", () => {
  const sampleEntry = {
    ref: "mutations:addTask",
    args: '{"text":"hello"}',
    localResult: '{"_id":"abc"}',
    table: "tasks",
  };

  it("pendingPush inserts an entry and returns its document id", async ({
    db,
  }) => {
    db.startTransaction();
    const id = await runSystem<string>(
      db,
      SystemPaths.pendingPush,
      sampleEntry,
    );
    db.commit();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("pendingGetAll returns all entries with the expected fields", async ({
    db,
  }) => {
    db.startTransaction();
    const id = await runSystem<string>(
      db,
      SystemPaths.pendingPush,
      sampleEntry,
    );
    db.commit();

    db.startTransaction();
    const all = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll);
    db.rollbackWrites();

    expect(all).toHaveLength(1);
    const entry = all[0];
    expect(entry?._id).toBe(id);
    expect(entry?.ref).toBe(sampleEntry.ref);
    expect(entry?.args).toBe(sampleEntry.args);
    expect(entry?.localResult).toBe(sampleEntry.localResult);
    expect(entry?.table).toBe(sampleEntry.table);
    expect(typeof entry?.createdAt).toBe("number");
  });

  it("pendingGetAll returns an empty array when no entries exist", async ({
    db,
  }) => {
    db.startTransaction();
    const all = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll);
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("pendingRemove removes an entry by id", async ({ db }) => {
    db.startTransaction();
    const id = await runSystem<string>(
      db,
      SystemPaths.pendingPush,
      sampleEntry,
    );
    db.commit();

    db.startTransaction();
    const removeResult = await runSystem<boolean>(
      db,
      SystemPaths.pendingRemove,
      {
        id,
      },
    );
    db.commit();

    expect(removeResult).toBe(true);

    db.startTransaction();
    const all = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll);
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("pendingRemove is a no-op for an unknown id", async ({ db }) => {
    db.startTransaction();
    const result = await runSystem<boolean>(db, SystemPaths.pendingRemove, {
      id: "00000000-0000-0000-0000-000000000000",
    });
    db.commit();

    expect(result).toBe(false);
  });

  it("pendingClear removes all entries", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, sampleEntry);
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      ref: "mutations:deleteTask",
    });
    db.commit();

    db.startTransaction();
    const before = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll);
    db.rollbackWrites();
    expect(before).toHaveLength(2);

    db.startTransaction();
    const clearResult = await runSystem(db, SystemPaths.pendingClear);
    db.commit();

    expect(clearResult).toBeNull();

    db.startTransaction();
    const after = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll);
    db.rollbackWrites();

    expect(after).toEqual([]);
  });

  it("pendingClear is a no-op when the queue is empty", async ({ db }) => {
    db.startTransaction();
    const result = await runSystem(db, SystemPaths.pendingClear);
    db.commit();

    expect(result).toBeNull();

    db.startTransaction();
    const all = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll);
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("scopes pending entries by identityKey", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      ref: "mutations:other",
      identityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const allA = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll, {
      identityKey: "user:a",
    });
    const allB = await runSystem<PendingRow[]>(db, SystemPaths.pendingGetAll, {
      identityKey: "user:b",
    });
    db.rollbackWrites();

    expect(allA).toHaveLength(1);
    expect(allA[0]?.identityKey).toBe("user:a");
    expect(allA[0]?.ref).toBe(sampleEntry.ref);
    expect(allB).toHaveLength(1);
    expect(allB[0]?.identityKey).toBe("user:b");
    expect(allB[0]?.ref).toBe("mutations:other");
  });

  it("pendingListIdentityKeys returns distinct pending identity keys", async ({
    db,
  }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:b",
    });
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      ref: "mutations:other",
      identityKey: "user:a",
    });
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      ref: "mutations:third",
      identityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const keys = await runSystem<string[]>(
      db,
      SystemPaths.pendingListIdentityKeys,
    );
    db.rollbackWrites();

    expect(keys).toEqual(["user:a", "user:b"]);
  });

  it("identityMoveAnonymousToIdentity migrates anonymous pending and id map state", async ({
    db,
  }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: null,
    });
    await runSystem(db, SystemPaths.idMapSet, {
      localId: "local-anon",
      remoteId: "remote-anon",
      table: "tasks",
      identityKey: null,
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.identityMoveAnonymousToIdentity, {
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    const pending = await runSystem<PendingRow[]>(
      db,
      SystemPaths.pendingGetAll,
      {
        identityKey: "user:a",
      },
    );
    const idMap = await runSystem<IdMapRow[]>(db, SystemPaths.idMapGetAll, {
      identityKey: "user:a",
    });
    db.rollbackWrites();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.identityKey).toBe("user:a");
    expect(idMap).toHaveLength(1);
    expect(idMap[0]?.identityKey).toBe("user:a");
  });

  it("pendingBlock and pendingUnblockAll update replay state", async ({
    db,
  }) => {
    db.startTransaction();
    const id = await runSystem<string>(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingBlock, {
      id,
      reason: "authorizationDenied",
    });
    db.commit();

    db.startTransaction();
    const blocked = await runSystem<PendingRow[]>(
      db,
      SystemPaths.pendingGetAll,
      {
        identityKey: "user:a",
      },
    );
    db.rollbackWrites();

    expect(blocked[0]?.state).toBe("blocked");
    expect(blocked[0]?.blockedReason).toBe("authorizationDenied");

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingUnblockAll, {
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    const unblocked = await runSystem<PendingRow[]>(
      db,
      SystemPaths.pendingGetAll,
      { identityKey: "user:a" },
    );
    db.rollbackWrites();

    expect(unblocked[0]?.state).toBe("pending");
    expect(unblocked[0]?.blockedReason).toBeUndefined();
  });

  it("pendingClaimNext claims the next pending entry with a lease", async ({
    db,
  }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    const claimed = await runSystem<PendingRow>(
      db,
      SystemPaths.pendingClaimNext,
      {
        identityKey: "user:a",
        owner: "processor-a",
        leaseMs: 1_000,
      },
    );
    db.commit();

    expect(claimed.owner).toBe("processor-a");
    expect(claimed.state).toBe("processing");
    expect(typeof claimed.leaseExpiresAt).toBe("number");
  });

  it("pendingRenewLease extends an owned processing lease", async ({ db }) => {
    db.startTransaction();
    const id = await runSystem<string>(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingClaimNext, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 100,
    });
    db.commit();

    db.startTransaction();
    const beforeRows = await runSystem<PendingRow[]>(
      db,
      SystemPaths.pendingGetAll,
      { identityKey: "user:a" },
    );
    db.rollbackWrites();
    const before = beforeRows[0]?.leaseExpiresAt ?? 0;

    db.startTransaction();
    const renewed = await runSystem<boolean>(
      db,
      SystemPaths.pendingRenewLease,
      {
        id,
        owner: "processor-a",
        leaseMs: 5_000,
      },
    );
    db.commit();

    expect(renewed).toBe(true);

    db.startTransaction();
    const afterRows = await runSystem<PendingRow[]>(
      db,
      SystemPaths.pendingGetAll,
      { identityKey: "user:a" },
    );
    db.rollbackWrites();

    expect(afterRows[0]?.leaseExpiresAt ?? 0).toBeGreaterThan(before);
  });

  it("pendingRenewLease returns false for a non-owner", async ({ db }) => {
    db.startTransaction();
    const id = await runSystem<string>(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingClaimNext, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 100,
    });
    db.commit();

    db.startTransaction();
    const renewed = await runSystem<boolean>(
      db,
      SystemPaths.pendingRenewLease,
      {
        id,
        owner: "processor-b",
        leaseMs: 5_000,
      },
    );
    db.commit();

    expect(renewed).toBe(false);
  });

  it("pendingRelease clears processing ownership and lease", async ({ db }) => {
    db.startTransaction();
    const id = await runSystem<string>(db, SystemPaths.pendingPush, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingClaimNext, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 1_000,
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.pendingRelease, {
      id,
      owner: "processor-a",
    });
    db.commit();

    db.startTransaction();
    const released = await runSystem<PendingRow[]>(
      db,
      SystemPaths.pendingGetAll,
      {
        identityKey: "user:a",
      },
    );
    db.rollbackWrites();

    expect(released[0]?.state).toBe("pending");
    expect(released[0]?.owner).toBeUndefined();
    expect(released[0]?.leaseExpiresAt).toBeUndefined();
  });

  it("pendingClaimNext can reclaim an expired processing lease", async ({
    db,
  }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);

      db.startTransaction();
      await runSystem(db, SystemPaths.pendingPush, {
        ...sampleEntry,
        identityKey: "user:a",
      });
      db.commit();

      db.startTransaction();
      await runSystem(db, SystemPaths.pendingClaimNext, {
        identityKey: "user:a",
        owner: "processor-a",
        leaseMs: 100,
      });
      db.commit();

      vi.setSystemTime(1_200);

      db.startTransaction();
      const claimed = await runSystem<PendingRow>(
        db,
        SystemPaths.pendingClaimNext,
        { identityKey: "user:a", owner: "processor-b", leaseMs: 100 },
      );
      db.commit();

      expect(claimed.owner).toBe("processor-b");
      expect(claimed.state).toBe("processing");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("auth state", () => {
  it("persists and returns the active identity key", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.authStateSetActive, {
      activeIdentityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    const key = await runSystem<string | null>(
      db,
      SystemPaths.authStateGetActive,
    );
    db.rollbackWrites();

    expect(key).toBe("user:a");
  });

  it("updates the active identity key in place", async ({ db }) => {
    db.startTransaction();
    await runSystem(db, SystemPaths.authStateSetActive, {
      activeIdentityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await runSystem(db, SystemPaths.authStateSetActive, {
      activeIdentityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const key = await runSystem<string | null>(
      db,
      SystemPaths.authStateGetActive,
    );
    db.rollbackWrites();

    expect(key).toBe("user:b");
  });
});

describe("SYSTEM_FUNCTIONS registry", () => {
  it("contains exactly 31 entries", () => {
    expect(Object.keys(SYSTEM_FUNCTIONS)).toHaveLength(31);
  });

  it("has all expected keys", () => {
    const expectedKeys = [
      "_system:idMapSet",
      "_system:idMapGet",
      "_system:idMapGetAll",
      "_system:idMapDelete",
      "_system:pendingPush",
      "_system:pendingGetAll",
      "_system:pendingClaimNext",
      "_system:pendingRenewLease",
      "_system:pendingRemove",
      "_system:pendingRelease",
      "_system:pendingClear",
      "_system:pendingBlock",
      "_system:pendingUnblockAll",
      "_system:pendingUploadPush",
      "_system:pendingUploadGetAll",
      "_system:pendingUploadClaimNext",
      "_system:pendingUploadRenewLease",
      "_system:pendingUploadRemove",
      "_system:pendingUploadRelease",
      "_system:authStateSetActive",
      "_system:authStateGetActive",
      "_system:pendingListIdentityKeys",
      "_system:identityMoveAnonymousToIdentity",
      "_system:processorHeartbeat",
      "_system:processorRemove",
      "_system:collectionMetadataGet",
      "_system:collectionMetadataSet",
      "_system:documentMetadataGetBatch",
      "_system:documentMetadataSetBatch",
      "_system:documentMetadataDeleteBatch",
      "_system:documentMetadataClearCollection",
    ];

    for (const key of expectedKeys) {
      expect(SYSTEM_FUNCTIONS).toHaveProperty(key);
    }
  });

  it("maps every SystemPaths value to a registered function", () => {
    for (const path of Object.values(SystemPaths)) {
      expect(SYSTEM_FUNCTIONS).toHaveProperty(path);
    }
  });

  it("registers no function outside the SystemPaths set", () => {
    const pathValues = new Set<string>(Object.values(SystemPaths));

    for (const key of Object.keys(SYSTEM_FUNCTIONS)) {
      expect(pathValues.has(key)).toBe(true);
    }
  });

  it("classifies mutations as 'mutation' and queries as 'query'", () => {
    const expectedMutations: SystemPath[] = [
      SystemPaths.idMapSet,
      SystemPaths.idMapDelete,
      SystemPaths.pendingPush,
      SystemPaths.pendingClaimNext,
      SystemPaths.pendingRenewLease,
      SystemPaths.pendingRemove,
      SystemPaths.pendingRelease,
      SystemPaths.pendingClear,
      SystemPaths.pendingBlock,
      SystemPaths.pendingUnblockAll,
      SystemPaths.processorHeartbeat,
      SystemPaths.processorRemove,
      SystemPaths.collectionMetadataSet,
      SystemPaths.documentMetadataSetBatch,
      SystemPaths.documentMetadataDeleteBatch,
      SystemPaths.documentMetadataClearCollection,
      SystemPaths.authStateSetActive,
      SystemPaths.identityMoveAnonymousToIdentity,
    ];

    const expectedQueries: SystemPath[] = [
      SystemPaths.idMapGet,
      SystemPaths.idMapGetAll,
      SystemPaths.pendingGetAll,
      SystemPaths.collectionMetadataGet,
      SystemPaths.documentMetadataGetBatch,
      SystemPaths.authStateGetActive,
      SystemPaths.pendingListIdentityKeys,
    ];

    for (const path of expectedMutations) {
      expect(SYSTEM_FUNCTIONS[path].type).toBe("mutation");
    }
    for (const path of expectedQueries) {
      expect(SYSTEM_FUNCTIONS[path].type).toBe("query");
    }
  });
});

describe("SystemFunctionDef shape", () => {
  it("exposes a type and a handler for every entry", () => {
    for (const def of Object.values<SystemFunctionDef>(SYSTEM_FUNCTIONS)) {
      expect(["query", "mutation"]).toContain(def.type);
      expect(typeof def.handler).toBe("function");
    }
  });
});
