import {
  OCC_MAX_RETRIES,
  OccConflictError,
  OccTransaction,
  createTransactionManager,
  type TransactionDatabase,
} from "@embedded/kernel/transaction";
import type { DocumentId, Timestamp } from "@embedded/runtime/db/types";
import { flushMicrotasks } from "@tests/helpers/time";
import { describe, expect, it, vi, type Mock } from "@tests/testkit";

function docId(value: string): DocumentId {
  return value as unknown as DocumentId;
}

interface MockTransactionDb {
  readonly timestamp: Timestamp;
  startTransaction: Mock<TransactionDatabase["startTransaction"]>;
  commitAsync: Mock<TransactionDatabase["commitAsync"]>;
  rollbackWrites: Mock<TransactionDatabase["rollbackWrites"]>;
  getDocumentTimestamp: Mock<TransactionDatabase["getDocumentTimestamp"]>;
  getTableLastWriteTimestamp: Mock<
    TransactionDatabase["getTableLastWriteTimestamp"]
  >;
  getTableForId: Mock<TransactionDatabase["getTableForId"]>;
}

function createMockDb(): MockTransactionDb {
  return {
    timestamp: 0,
    startTransaction: vi.fn<TransactionDatabase["startTransaction"]>(),
    commitAsync: vi.fn<TransactionDatabase["commitAsync"]>(
      async () => undefined,
    ),
    rollbackWrites: vi.fn<TransactionDatabase["rollbackWrites"]>(),
    getDocumentTimestamp: vi
      .fn<TransactionDatabase["getDocumentTimestamp"]>()
      .mockReturnValue(1),
    getTableLastWriteTimestamp: vi
      .fn<TransactionDatabase["getTableLastWriteTimestamp"]>()
      .mockReturnValue(null),
    getTableForId: vi
      .fn<TransactionDatabase["getTableForId"]>()
      .mockReturnValue("messages"),
  };
}

describe("TransactionManager", () => {
  it("isInTransaction() returns false initially", () => {
    const tm = createTransactionManager();

    expect(tm.isInTransaction()).toBe(false);
  });

  it("isInTransaction() flips true after begin and false after commit", async () => {
    const tm = createTransactionManager();

    await tm.begin(false);
    expect(tm.isInTransaction()).toBe(true);

    tm.commit(false);
    expect(tm.isInTransaction()).toBe(false);
  });

  it("serializes two concurrent top-level transactions", async () => {
    const tm = createTransactionManager();
    const order: string[] = [];

    await tm.begin(false);
    order.push("t1-begin");

    const t2 = (async () => {
      await tm.begin(false);
      order.push("t2-begin");
      tm.commit(false);
    })();

    await flushMicrotasks();
    expect(order).toEqual(["t1-begin"]);

    order.push("t1-commit");
    tm.commit(false);

    await t2;

    expect(order).toEqual(["t1-begin", "t1-commit", "t2-begin"]);
  });

  it("nested begin(true) does not block or release the lock", async () => {
    const tm = createTransactionManager();

    await tm.begin(false);
    expect(tm.isInTransaction()).toBe(true);

    await tm.begin(true);
    expect(tm.isInTransaction()).toBe(true);

    tm.commit(true);
    expect(tm.isInTransaction()).toBe(true);

    tm.commit(false);
    expect(tm.isInTransaction()).toBe(false);
  });

  it("rollback releases the lock for the next caller", async () => {
    const tm = createTransactionManager();
    const order: string[] = [];

    await tm.begin(false);
    order.push("t1-begin");

    const t2 = (async () => {
      await tm.begin(false);
      order.push("t2-begin");
      tm.commit(false);
    })();

    await flushMicrotasks();
    expect(order).toEqual(["t1-begin"]);

    order.push("t1-rollback");
    tm.rollback(false);

    await t2;

    expect(order).toEqual(["t1-begin", "t1-rollback", "t2-begin"]);
  });

  it("throws when committing with no active transaction", () => {
    const tm = createTransactionManager();

    expect(() => tm.commit(false)).toThrow(/no active transaction/);
  });

  it("throws when rolling back with no active transaction", () => {
    const tm = createTransactionManager();

    expect(() => tm.rollback(false)).toThrow(/no active transaction/);
  });
});

describe.concurrent("OccConflictError", () => {
  it("is an instance of Error and OccConflictError", () => {
    const err = new OccConflictError("test conflict");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OccConflictError);
  });

  it('has name set to "OccConflictError"', () => {
    expect(new OccConflictError("msg").name).toBe("OccConflictError");
  });

  it("carries the conflict message", () => {
    expect(new OccConflictError("doc changed").message).toBe("doc changed");
  });
});

describe("OccTransaction", () => {
  it("executes the function and returns its result", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });

    const result = await tx.execute(async () => "hello");

    expect(result).toBe("hello");
    expect(db.startTransaction).toHaveBeenCalledOnce();
    expect(db.commitAsync).toHaveBeenCalledOnce();
    expect(db.rollbackWrites).not.toHaveBeenCalled();
  });

  it("calls startTransaction before fn and commit after", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });
    const callOrder: string[] = [];

    db.startTransaction.mockImplementation(() => {
      callOrder.push("start");
    });
    db.commitAsync.mockImplementation(async () => {
      callOrder.push("commit");
    });

    await tx.execute(async () => {
      callOrder.push("fn");
      return 42;
    });

    expect(callOrder).toEqual(["start", "fn", "commit"]);
  });

  it("commits when a tracked document read is unchanged", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });
    db.getDocumentTimestamp.mockReturnValue(100);

    await tx.execute(async () => {
      tx.addRead(docId("aaaaaaaa-0000-4000-8000-000000000001"), 100);
      return null;
    });

    expect(db.getDocumentTimestamp).toHaveBeenCalledWith(
      docId("aaaaaaaa-0000-4000-8000-000000000001"),
    );
    expect(db.commitAsync).toHaveBeenCalledOnce();
  });

  it("commits when a tracked table read has no later writes", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });
    db.getTableLastWriteTimestamp.mockReturnValue(null);

    await tx.execute(async () => {
      tx.addTableRead("messages");
      return null;
    });

    expect(db.getTableLastWriteTimestamp).toHaveBeenCalledWith("messages");
    expect(db.commitAsync).toHaveBeenCalledOnce();
  });

  it("throws OccConflictError when a read document's timestamp differs", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 0 });
    db.getDocumentTimestamp.mockReturnValue(2);

    await expect(
      tx.execute(async () => {
        tx.addRead(docId("aaaaaaaa-0000-4000-8000-000000000001"), 1);
        return null;
      }),
    ).rejects.toThrow(/OCC conflict/);

    expect(db.rollbackWrites).toHaveBeenCalled();
  });

  it("throws OccConflictError when a read document was deleted", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 0 });
    db.getDocumentTimestamp.mockReturnValue(null);

    await expect(
      tx.execute(async () => {
        tx.addRead(docId("aaaaaaaa-0000-4000-8000-000000000001"), 1);
        return null;
      }),
    ).rejects.toThrow(/OCC conflict/);

    expect(db.rollbackWrites).toHaveBeenCalled();
  });

  it("detects a table-level conflict when the table was written after a scan", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 0 });
    db.getTableLastWriteTimestamp.mockReturnValue(10);

    await expect(
      tx.execute(async () => {
        tx.addTableRead("messages");
        return null;
      }),
    ).rejects.toThrow(/OCC conflict/);

    expect(db.rollbackWrites).toHaveBeenCalled();
  });

  it("propagates a non-OccConflictError immediately without retrying", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 5 });
    let attempts = 0;

    await expect(
      tx.execute(async () => {
        attempts += 1;
        throw new TypeError("something broke");
      }),
    ).rejects.toThrow(TypeError);

    expect(attempts).toBe(1);
    expect(db.rollbackWrites).toHaveBeenCalledOnce();
    expect(db.commitAsync).not.toHaveBeenCalled();
  });

  it("resets the read set between retry attempts", async () => {
    vi.useFakeTimers();
    try {
      const db = createMockDb();
      const tx = new OccTransaction({ db, maxRetries: 2 });
      db.getDocumentTimestamp.mockReturnValue(999);

      let attempt = 0;
      const readsPerAttempt: number[] = [];

      const settled = expect(
        tx.execute(async () => {
          attempt += 1;
          readsPerAttempt.push(attempt);
          tx.addRead(docId(`aaaaaaaa-0000-4000-8000-00000000000${attempt}`), 5);
          return "ok";
        }),
      ).rejects.toThrow(/OCC conflict/);

      await vi.runAllTimersAsync();
      await settled;

      expect(attempt).toBe(3);
      expect(readsPerAttempt).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults maxRetries to OCC_MAX_RETRIES", () => {
    const db = createMockDb();

    expect(() => new OccTransaction({ db })).not.toThrow();
    expect(OCC_MAX_RETRIES).toBe(5);
  });
});
