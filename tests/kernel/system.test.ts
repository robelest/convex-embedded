import { SYSTEM_FUNCTIONS, SystemPaths } from "@embedded/kernel/system";
import { Database } from "@embedded/runtime/db/database";
import { describe, it, expect, beforeEach } from "@tests/testkit";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database;

beforeEach(() => {
  db = new Database(null);
});

// ---------------------------------------------------------------------------
// ID Map functions (_resolve_id_map table)
// ---------------------------------------------------------------------------

describe("ID Map", () => {
  it("idMapSet inserts a new mapping and returns null", async () => {
    db.startTransaction();
    const result = await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "local-1",
      remoteId: "remote-1",
      table: "tasks",
    });
    db.commit();

    expect(result).toBeNull();

    // Verify the mapping was persisted by reading it back.
    db.startTransaction();
    const remoteId = await SYSTEM_FUNCTIONS[SystemPaths.idMapGet].handler(db, {
      localId: "local-1",
    });
    db.rollbackWrites();

    expect(remoteId).toBe("remote-1");
  });

  it("idMapSet updates an existing mapping when the same localId is set again", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "local-1",
      remoteId: "remote-1",
      table: "tasks",
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "local-1",
      remoteId: "remote-2",
      table: "notes",
    });
    db.commit();

    db.startTransaction();
    const remoteId = await SYSTEM_FUNCTIONS[SystemPaths.idMapGet].handler(db, {
      localId: "local-1",
    });
    db.rollbackWrites();

    expect(remoteId).toBe("remote-2");

    // Should still be a single mapping, not two.
    db.startTransaction();
    const all = (await SYSTEM_FUNCTIONS[SystemPaths.idMapGetAll].handler(
      db,
      {},
    )) as Array<{
      localId: string;
      remoteId: string;
      table: string;
    }>;
    db.rollbackWrites();

    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      localId: "local-1",
      remoteId: "remote-2",
      table: "notes",
    });
  });

  it("idMapGet returns remoteId for a known localId", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "local-a",
      remoteId: "remote-a",
      table: "items",
    });
    db.commit();

    db.startTransaction();
    const result = await SYSTEM_FUNCTIONS[SystemPaths.idMapGet].handler(db, {
      localId: "local-a",
    });
    db.rollbackWrites();

    expect(result).toBe("remote-a");
  });

  it("idMapGet returns null for an unknown localId", async () => {
    db.startTransaction();
    const result = await SYSTEM_FUNCTIONS[SystemPaths.idMapGet].handler(db, {
      localId: "does-not-exist",
    });
    db.rollbackWrites();

    expect(result).toBeNull();
  });

  it("idMapGetAll returns all mappings", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "l1",
      remoteId: "r1",
      table: "tasks",
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "l2",
      remoteId: "r2",
      table: "notes",
    });
    db.commit();

    db.startTransaction();
    const all = (await SYSTEM_FUNCTIONS[SystemPaths.idMapGetAll].handler(
      db,
      {},
    )) as Array<{
      localId: string;
      remoteId: string;
      table: string;
    }>;
    db.rollbackWrites();

    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        { localId: "l1", remoteId: "r1", table: "tasks" },
        { localId: "l2", remoteId: "r2", table: "notes" },
      ]),
    );
  });

  it("idMapGetAll returns an empty array when no mappings exist", async () => {
    db.startTransaction();
    const all = await SYSTEM_FUNCTIONS[SystemPaths.idMapGetAll].handler(db, {});
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("idMapDelete removes a mapping by localId", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "local-x",
      remoteId: "remote-x",
      table: "tasks",
    });
    db.commit();

    db.startTransaction();
    const deleteResult = await SYSTEM_FUNCTIONS[
      SystemPaths.idMapDelete
    ].handler(db, {
      localId: "local-x",
    });
    db.commit();

    expect(deleteResult).toBeNull();

    // Confirm it was removed.
    db.startTransaction();
    const lookup = await SYSTEM_FUNCTIONS[SystemPaths.idMapGet].handler(db, {
      localId: "local-x",
    });
    db.rollbackWrites();

    expect(lookup).toBeNull();
  });

  it("idMapDelete is a no-op for an unknown localId", async () => {
    db.startTransaction();
    const result = await SYSTEM_FUNCTIONS[SystemPaths.idMapDelete].handler(db, {
      localId: "nonexistent",
    });
    db.commit();

    expect(result).toBeNull();
  });

  it("idMap functions are scoped by identityKey", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "shared-local",
      remoteId: "remote-a",
      table: "tasks",
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "shared-local",
      remoteId: "remote-b",
      table: "tasks",
      identityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const allA = await SYSTEM_FUNCTIONS[SystemPaths.idMapGetAll].handler(db, {
      identityKey: "user:a",
    });
    const allB = await SYSTEM_FUNCTIONS[SystemPaths.idMapGetAll].handler(db, {
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

// ---------------------------------------------------------------------------
// Pending Queue functions (_resolve_pending table)
// ---------------------------------------------------------------------------

describe("Pending Queue", () => {
  const sampleEntry = {
    ref: "mutations:addTask",
    args: '{"text":"hello"}',
    localResult: '{"_id":"abc"}',
    table: "tasks",
  };

  it("pendingPush inserts an entry and returns the document ID", async () => {
    db.startTransaction();
    const id = await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(
      db,
      sampleEntry,
    );
    db.commit();

    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });

  it("pendingGetAll returns all entries with expected fields", async () => {
    db.startTransaction();
    const id = await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(
      db,
      sampleEntry,
    );
    db.commit();

    db.startTransaction();
    const all = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {},
    )) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect(all).toHaveLength(1);

    const entry = all[0];
    expect(entry._id).toBe(id);
    expect(entry.ref).toBe(sampleEntry.ref);
    expect(entry.args).toBe(sampleEntry.args);
    expect(entry.localResult).toBe(sampleEntry.localResult);
    expect(entry.table).toBe(sampleEntry.table);
    expect(typeof entry.createdAt).toBe("number");
  });

  it("pendingGetAll returns an empty array when no entries exist", async () => {
    db.startTransaction();
    const all = await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {},
    );
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("pendingRemove removes an entry by ID", async () => {
    db.startTransaction();
    const id = (await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(
      db,
      sampleEntry,
    )) as string;
    db.commit();

    db.startTransaction();
    const removeResult = await SYSTEM_FUNCTIONS[
      SystemPaths.pendingRemove
    ].handler(db, { id });
    db.commit();

    expect(removeResult).toBeNull();

    db.startTransaction();
    const all = await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {},
    );
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("pendingRemove is a no-op for an unknown ID", async () => {
    db.startTransaction();
    const result = await SYSTEM_FUNCTIONS[SystemPaths.pendingRemove].handler(
      db,
      {
        id: "00000000-0000-0000-0000-000000000000",
      },
    );
    db.commit();

    expect(result).toBeNull();
  });

  it("pendingClear removes all entries", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, sampleEntry);
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      ref: "mutations:deleteTask",
    });
    db.commit();

    // Confirm two entries exist.
    db.startTransaction();
    const before = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {},
    )) as Array<unknown>;
    db.rollbackWrites();
    expect(before).toHaveLength(2);

    db.startTransaction();
    const clearResult = await SYSTEM_FUNCTIONS[
      SystemPaths.pendingClear
    ].handler(db, {});
    db.commit();

    expect(clearResult).toBeNull();

    db.startTransaction();
    const after = await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {},
    );
    db.rollbackWrites();

    expect(after).toEqual([]);
  });

  it("pendingClear is a no-op when the queue is empty", async () => {
    db.startTransaction();
    const result = await SYSTEM_FUNCTIONS[SystemPaths.pendingClear].handler(
      db,
      {},
    );
    db.commit();

    expect(result).toBeNull();

    db.startTransaction();
    const all = await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {},
    );
    db.rollbackWrites();

    expect(all).toEqual([]);
  });

  it("pending queue functions are scoped by identityKey", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      ref: "mutations:other",
      identityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const allA = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {
        identityKey: "user:a",
      },
    )) as Array<Record<string, unknown>>;
    const allB = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {
        identityKey: "user:b",
      },
    )) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect(allA).toHaveLength(1);
    expect(allA[0]?.identityKey).toBe("user:a");
    expect(allA[0]?.ref).toBe(sampleEntry.ref);
    expect(allB).toHaveLength(1);
    expect(allB[0]?.identityKey).toBe("user:b");
    expect(allB[0]?.ref).toBe("mutations:other");
  });

  it("pendingListIdentityKeys returns distinct pending identity keys", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:b",
    });
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      ref: "mutations:other",
      identityKey: "user:a",
    });
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      ref: "mutations:third",
      identityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const keys = await SYSTEM_FUNCTIONS[
      SystemPaths.pendingListIdentityKeys
    ].handler(db, {});
    db.rollbackWrites();

    expect(keys).toEqual(["user:a", "user:b"]);
  });

  it("identityMoveAnonymousToIdentity migrates anonymous pending and id map state", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: null,
    });
    await SYSTEM_FUNCTIONS[SystemPaths.idMapSet].handler(db, {
      localId: "local-anon",
      remoteId: "remote-anon",
      table: "tasks",
      identityKey: null,
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.identityMoveAnonymousToIdentity].handler(
      db,
      {
        identityKey: "user:a",
      },
    );
    db.commit();

    db.startTransaction();
    const pending = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {
        identityKey: "user:a",
      },
    )) as Array<Record<string, unknown>>;
    const idMap = (await SYSTEM_FUNCTIONS[SystemPaths.idMapGetAll].handler(db, {
      identityKey: "user:a",
    })) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.identityKey).toBe("user:a");
    expect(idMap).toHaveLength(1);
    expect(idMap[0]?.identityKey).toBe("user:a");
  });

  it("pendingBlock and pendingUnblockAll update replay state", async () => {
    db.startTransaction();
    const id = (await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:a",
    })) as string;
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingBlock].handler(db, {
      id,
      reason: "authorizationDenied",
    });
    db.commit();

    db.startTransaction();
    let pending = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {
        identityKey: "user:a",
      },
    )) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect(pending[0]?.state).toBe("blocked");
    expect(pending[0]?.blockedReason).toBe("authorizationDenied");

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingUnblockAll].handler(db, {
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    pending = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(db, {
      identityKey: "user:a",
    })) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect(pending[0]?.state).toBe("pending");
    expect(pending[0]?.blockedReason).toBeUndefined();
  });

  it("pendingClaimNext claims the next pending entry with a lease", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    const claimed = (await SYSTEM_FUNCTIONS[
      SystemPaths.pendingClaimNext
    ].handler(db, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 1_000,
    })) as Record<string, unknown>;
    db.commit();

    expect(claimed.owner).toBe("processor-a");
    expect(claimed.state).toBe("processing");
    expect(typeof claimed.leaseExpiresAt).toBe("number");
  });

  it("pendingRenewLease extends an owned processing lease", async () => {
    db.startTransaction();
    const id = (await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:a",
    })) as string;
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingClaimNext].handler(db, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 100,
    });
    db.commit();

    db.startTransaction();
    let pending = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {
        identityKey: "user:a",
      },
    )) as Array<Record<string, unknown>>;
    db.rollbackWrites();
    const before = pending[0]?.leaseExpiresAt as number;

    db.startTransaction();
    const renewed = await SYSTEM_FUNCTIONS[
      SystemPaths.pendingRenewLease
    ].handler(db, {
      id,
      owner: "processor-a",
      leaseMs: 5_000,
    });
    db.commit();

    expect(renewed).toBe(true);

    db.startTransaction();
    pending = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(db, {
      identityKey: "user:a",
    })) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect((pending[0]?.leaseExpiresAt as number) > before).toBe(true);
  });

  it("pendingRenewLease returns false for a non-owner", async () => {
    db.startTransaction();
    const id = (await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:a",
    })) as string;
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingClaimNext].handler(db, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 100,
    });
    db.commit();

    db.startTransaction();
    const renewed = await SYSTEM_FUNCTIONS[
      SystemPaths.pendingRenewLease
    ].handler(db, {
      id,
      owner: "processor-b",
      leaseMs: 5_000,
    });
    db.commit();

    expect(renewed).toBe(false);
  });

  it("pendingRelease clears processing ownership and lease", async () => {
    db.startTransaction();
    const id = (await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
      ...sampleEntry,
      identityKey: "user:a",
    })) as string;
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingClaimNext].handler(db, {
      identityKey: "user:a",
      owner: "processor-a",
      leaseMs: 1_000,
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.pendingRelease].handler(db, {
      id,
      owner: "processor-a",
    });
    db.commit();

    db.startTransaction();
    const pending = (await SYSTEM_FUNCTIONS[SystemPaths.pendingGetAll].handler(
      db,
      {
        identityKey: "user:a",
      },
    )) as Array<Record<string, unknown>>;
    db.rollbackWrites();

    expect(pending[0]?.state).toBe("pending");
    expect(pending[0]?.owner).toBeUndefined();
    expect(pending[0]?.leaseExpiresAt).toBeUndefined();
  });

  it("pendingClaimNext can reclaim an expired processing lease", async () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      db.startTransaction();
      await SYSTEM_FUNCTIONS[SystemPaths.pendingPush].handler(db, {
        ...sampleEntry,
        identityKey: "user:a",
      });
      db.commit();

      db.startTransaction();
      await SYSTEM_FUNCTIONS[SystemPaths.pendingClaimNext].handler(db, {
        identityKey: "user:a",
        owner: "processor-a",
        leaseMs: 100,
      });
      db.commit();

      now += 200;

      db.startTransaction();
      const claimed = (await SYSTEM_FUNCTIONS[
        SystemPaths.pendingClaimNext
      ].handler(db, {
        identityKey: "user:a",
        owner: "processor-b",
        leaseMs: 100,
      })) as Record<string, unknown>;
      db.commit();

      expect(claimed.owner).toBe("processor-b");
      expect(claimed.state).toBe("processing");
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("Auth State", () => {
  it("persists and returns the active identity key", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.authStateSetActive].handler(db, {
      activeIdentityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    const key = await SYSTEM_FUNCTIONS[SystemPaths.authStateGetActive].handler(
      db,
      {},
    );
    db.rollbackWrites();

    expect(key).toBe("user:a");
  });

  it("updates the active identity key in place", async () => {
    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.authStateSetActive].handler(db, {
      activeIdentityKey: "user:a",
    });
    db.commit();

    db.startTransaction();
    await SYSTEM_FUNCTIONS[SystemPaths.authStateSetActive].handler(db, {
      activeIdentityKey: "user:b",
    });
    db.commit();

    db.startTransaction();
    const key = await SYSTEM_FUNCTIONS[SystemPaths.authStateGetActive].handler(
      db,
      {},
    );
    db.rollbackWrites();

    expect(key).toBe("user:b");
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("SYSTEM_FUNCTIONS registry", () => {
  it("contains exactly 25 entries", () => {
    expect(Object.keys(SYSTEM_FUNCTIONS)).toHaveLength(25);
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

  it("SystemPaths constants match the SYSTEM_FUNCTIONS keys", () => {
    for (const path of Object.values(SystemPaths)) {
      expect(SYSTEM_FUNCTIONS).toHaveProperty(path);
    }

    // And the reverse: every key in SYSTEM_FUNCTIONS corresponds to a SystemPaths value.
    const pathValues = new Set(Object.values(SystemPaths));
    for (const key of Object.keys(SYSTEM_FUNCTIONS)) {
      expect(
        pathValues.has(key as (typeof SystemPaths)[keyof typeof SystemPaths]),
      ).toBe(true);
    }
  });

  it("types are correct: mutations are 'mutation', queries are 'query'", () => {
    const expectedMutations = [
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

    const expectedQueries = [
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
