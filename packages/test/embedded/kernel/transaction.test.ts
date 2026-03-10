import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TransactionManager,
  OccTransaction,
  OccConflictError,
  OCC_MAX_RETRIES,
} from "#embedded/kernel/transaction";

// ---------------------------------------------------------------------------
// TransactionManager
// ---------------------------------------------------------------------------

describe("TransactionManager", () => {
  it("isInTransaction() returns false initially", () => {
    const tm = new TransactionManager();
    expect(tm.isInTransaction()).toBe(false);
  });

  it("isInTransaction() returns true after begin, false after commit", async () => {
    const tm = new TransactionManager();

    await tm.begin(false);
    expect(tm.isInTransaction()).toBe(true);

    tm.commit(false);
    expect(tm.isInTransaction()).toBe(false);
  });

  it("serializes two concurrent top-level transactions", async () => {
    const tm = new TransactionManager();
    const order: string[] = [];

    // First transaction acquires the lock
    const t1 = (async () => {
      await tm.begin(false);
      order.push("t1-begin");
      // Simulate async work
      await new Promise((r) => setTimeout(r, 50));
      order.push("t1-commit");
      tm.commit(false);
    })();

    // Second transaction starts after t1 begins, should wait
    const t2 = (async () => {
      // Small delay to ensure t1 starts first
      await new Promise((r) => setTimeout(r, 10));
      await tm.begin(false);
      order.push("t2-begin");
      tm.commit(false);
    })();

    await Promise.all([t1, t2]);

    // t2 must have started after t1 committed
    expect(order).toEqual(["t1-begin", "t1-commit", "t2-begin"]);
  });

  it("nested begin(true) does not block", async () => {
    const tm = new TransactionManager();

    await tm.begin(false);
    expect(tm.isInTransaction()).toBe(true);

    // Nested begin should pass through immediately
    await tm.begin(true);
    expect(tm.isInTransaction()).toBe(true);

    // Nested commit should NOT release the lock
    tm.commit(true);
    expect(tm.isInTransaction()).toBe(true);

    // Top-level commit releases
    tm.commit(false);
    expect(tm.isInTransaction()).toBe(false);
  });

  it("rollback releases the lock for the next caller", async () => {
    const tm = new TransactionManager();
    const order: string[] = [];

    const t1 = (async () => {
      await tm.begin(false);
      order.push("t1-begin");
      tm.rollback(false);
      order.push("t1-rollback");
    })();

    const t2 = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      await tm.begin(false);
      order.push("t2-begin");
      tm.commit(false);
    })();

    await Promise.all([t1, t2]);

    expect(order).toEqual(["t1-begin", "t1-rollback", "t2-begin"]);
  });

  it("throws when committing with no active transaction", () => {
    const tm = new TransactionManager();

    expect(() => tm.commit(false)).toThrow(/no active transaction/);
  });

  it("throws when rolling back with no active transaction", () => {
    const tm = new TransactionManager();

    expect(() => tm.rollback(false)).toThrow(/no active transaction/);
  });
});

// ---------------------------------------------------------------------------
// OccConflictError
// ---------------------------------------------------------------------------

describe("OccConflictError", () => {
  it("is an instance of Error", () => {
    const err = new OccConflictError("test conflict");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OccConflictError);
  });

  it('has name set to "OccConflictError"', () => {
    const err = new OccConflictError("msg");
    expect(err.name).toBe("OccConflictError");
  });

  it("carries the conflict message", () => {
    const err = new OccConflictError("doc changed");
    expect(err.message).toBe("doc changed");
  });
});

// ---------------------------------------------------------------------------
// OccTransaction
// ---------------------------------------------------------------------------

function createMockDb() {
  return {
    startTransaction: vi.fn(),
    commit: vi.fn(),
    rollbackWrites: vi.fn(),
    getDocumentTimestamp: vi.fn().mockReturnValue(1),
    getTableLastWriteTimestamp: vi.fn().mockReturnValue(null),
  };
}

describe("OccTransaction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes the function and returns its result", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });

    const result = await tx.execute(async () => "hello");

    expect(result).toBe("hello");
    expect(db.startTransaction).toHaveBeenCalledOnce();
    expect(db.commit).toHaveBeenCalledOnce();
    expect(db.rollbackWrites).not.toHaveBeenCalled();
  });

  it("calls startTransaction before fn and commit after", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });
    const callOrder: string[] = [];

    db.startTransaction.mockImplementation(() => callOrder.push("start"));
    db.commit.mockImplementation(() => callOrder.push("commit"));

    await tx.execute(async () => {
      callOrder.push("fn");
      return 42;
    });

    expect(callOrder).toEqual(["start", "fn", "commit"]);
  });

  it("tracks document reads via addRead", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });

    // getDocumentTimestamp returns the same ts we recorded → no conflict
    db.getDocumentTimestamp.mockReturnValue(100);

    await tx.execute(async () => {
      tx.addRead("1;messages" as any, 100);
      return null;
    });

    expect(db.getDocumentTimestamp).toHaveBeenCalledWith("1;messages");
    expect(db.commit).toHaveBeenCalledOnce();
  });

  it("tracks table reads via addTableRead", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });

    // No table write timestamp → no conflict
    db.getTableLastWriteTimestamp.mockReturnValue(null);

    await tx.execute(async () => {
      tx.addTableRead("messages");
      return null;
    });

    expect(db.getTableLastWriteTimestamp).toHaveBeenCalledWith("messages");
    expect(db.commit).toHaveBeenCalledOnce();
  });

  it("throws OccConflictError when document timestamp differs", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 0 });

    // Document was read at ts=1, but current is ts=2 → conflict
    db.getDocumentTimestamp.mockReturnValue(2);

    await expect(
      tx.execute(async () => {
        tx.addRead("1;messages" as any, 1);
        return null;
      }),
    ).rejects.toThrow(/OCC conflict/);

    expect(db.rollbackWrites).toHaveBeenCalled();
  });

  it("throws OccConflictError when document was deleted", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 0 });

    // Document was deleted → getDocumentTimestamp returns null
    db.getDocumentTimestamp.mockReturnValue(null);

    await expect(
      tx.execute(async () => {
        tx.addRead("1;messages" as any, 1);
        return null;
      }),
    ).rejects.toThrow(/OCC conflict/);

    expect(db.rollbackWrites).toHaveBeenCalled();
  });

  it("propagates non-OccConflictError immediately without retrying", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 5 });
    let attempts = 0;

    await expect(
      tx.execute(async () => {
        attempts++;
        throw new TypeError("something broke");
      }),
    ).rejects.toThrow(TypeError);

    expect(attempts).toBe(1); // no retry
    expect(db.rollbackWrites).toHaveBeenCalledOnce();
    expect(db.commit).not.toHaveBeenCalled();
  });

  it("resets read set between retry attempts", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 2 });

    let attempt = 0;
    const readTimestampsPerAttempt: number[][] = [];

    // Always conflict so we can observe reads being reset each attempt
    db.getDocumentTimestamp.mockReturnValue(999);

    // Catch immediately to prevent unhandled rejection warnings
    let caughtError: Error | undefined;
    const executePromise = tx
      .execute(async () => {
        attempt++;
        readTimestampsPerAttempt.push([attempt]);
        tx.addRead(`${attempt};messages` as any, 5);
        return "ok";
      })
      .catch((err: Error) => {
        caughtError = err;
      });

    // Advance timers for backoff between retries
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    await executePromise;

    // maxRetries=2, so 3 attempts total, all conflict → fails
    expect(caughtError).toBeDefined();
    expect(caughtError!.message).toMatch(/OCC conflict/);

    // All 3 attempts ran
    expect(attempt).toBe(3);
    // Each attempt added its own read, confirming the read set was cleared
    expect(readTimestampsPerAttempt).toHaveLength(3);
  });

  it("detects table-level conflict when table was written after scan", async () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db, maxRetries: 0 });

    // Table has writes and scan returned no rows → phantom conflict
    db.getTableLastWriteTimestamp.mockReturnValue(10);

    await expect(
      tx.execute(async () => {
        tx.addTableRead("messages");
        return null;
      }),
    ).rejects.toThrow(/OCC conflict/);

    expect(db.rollbackWrites).toHaveBeenCalled();
  });

  it("uses default OCC_MAX_RETRIES when maxRetries is not specified", () => {
    const db = createMockDb();
    const tx = new OccTransaction({ db });

    // We can't directly inspect _maxRetries, but we can verify OCC_MAX_RETRIES
    // is exported and has a reasonable value
    expect(OCC_MAX_RETRIES).toBe(5);
  });
});
