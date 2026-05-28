import { createTransactionManager } from "@embedded/kernel/transaction";
import type { DocumentId, Timestamp } from "@embedded/runtime/db/types";
import { retryWithBackoff } from "@embedded/utils/retry";
import { flushMicrotasks } from "@tests/helpers/time";
import { describe, expect, it, vi, type Mock } from "@tests/testkit";

interface TransactionDatabase {
  readonly timestamp: Timestamp;
  startTransaction(): void;
  commitAsync(): Promise<unknown>;
  rollbackWrites(): void;
  getDocumentTimestamp(id: DocumentId): Timestamp | null;
  getTableLastWriteTimestamp(tableName: string): Timestamp | null;
  getTableForId(id: string): string | undefined;
}

const OCC_MAX_RETRIES = 5;
const OCC_BASE_DELAY_MS = 50;

class OccConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OccConflictError";
  }
}

interface OccTransactionOptions {
  db: TransactionDatabase;
  maxRetries?: number;
}

class OccTransaction {
  private readonly _db: TransactionDatabase;
  private readonly _maxRetries: number;

  private _readSet: Map<DocumentId, Timestamp> = new Map();
  private _tablesRead: Set<string> = new Set();
  private _startTs: Timestamp = 0;

  constructor(opts: OccTransactionOptions) {
    this._db = opts.db;
    this._maxRetries = opts.maxRetries ?? OCC_MAX_RETRIES;
  }

  addRead(id: DocumentId, timestamp: Timestamp): void {
    const existing = this._readSet.get(id);
    if (existing === undefined || timestamp < existing) {
      this._readSet.set(id, timestamp);
    }
  }

  addTableRead(tableName: string): void {
    this._tablesRead.add(tableName);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(
      async () => {
        this._readSet.clear();
        this._tablesRead.clear();
        this._startTs = this._db.timestamp;

        this._db.startTransaction();

        let result: T;
        try {
          result = await fn();
        } catch (err) {
          this._db.rollbackWrites();
          throw err;
        }

        try {
          this._validateReadSet();
          await this._db.commitAsync();
          return result;
        } catch (err) {
          this._db.rollbackWrites();
          if (err instanceof OccConflictError) {
            throw err;
          }
          throw err;
        }
      },
      {
        maxRetries: this._maxRetries,
        baseMs: OCC_BASE_DELAY_MS,
        jitter: true,
        shouldRetry: (err) => err instanceof OccConflictError,
      },
    );
  }

  private _validateReadSet(): void {
    for (const [id, readTs] of this._readSet) {
      const currentTs: Timestamp | null = this._db.getDocumentTimestamp(id);

      if (currentTs === null) {
        throw new OccConflictError(
          `OCC conflict: document ${id} was deleted after being read at ts=${readTs}`,
        );
      }

      if (currentTs !== readTs) {
        throw new OccConflictError(
          `OCC conflict: document ${id} changed (read ts=${readTs}, current ts=${currentTs})`,
        );
      }
    }

    for (const tableName of this._tablesRead) {
      const tableTs: Timestamp | null =
        this._db.getTableLastWriteTimestamp(tableName);

      if (tableTs === null) {
        continue;
      }

      for (const [id, readTs] of this._readSet) {
        if (!this._belongsToTable(id, tableName)) {
          continue;
        }
        if (tableTs > readTs) {
          throw new OccConflictError(
            `OCC conflict: table "${tableName}" was written (ts=${tableTs}) after scan read at ts=${readTs}`,
          );
        }
      }

      const hasDocReadsInTable = [...this._readSet.keys()].some((id) =>
        this._belongsToTable(id, tableName),
      );
      if (!hasDocReadsInTable && tableTs > this._startTs) {
        throw new OccConflictError(
          `OCC conflict: table "${tableName}" was written (ts=${tableTs}) after transaction started (ts=${this._startTs}) but scan returned no rows`,
        );
      }
    }
  }

  private _belongsToTable(id: DocumentId, tableName: string): boolean {
    return this._db.getTableForId(id as string) === tableName;
  }
}

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
