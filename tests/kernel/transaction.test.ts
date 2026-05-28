import { createTransactionManager } from "@embedded/kernel/transaction";
import { flushMicrotasks } from "@tests/helpers/time";
import { describe, expect, it } from "@tests/testkit";

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
