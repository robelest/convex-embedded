/**
 * Serializes function execution so that only one top-level mutation / query
 * runs at a time. Actions may invoke mutations concurrently, but each
 * mutation acquires this lock before touching the database.
 *
 * Nested transactions (e.g. `ctx.runQuery` inside a mutation) share the
 * parent's lock and are *not* independently isolated.
 *
 * This follows the standard condition-variable pattern used in convex-test:
 * a loop that awaits the current promise ensures correctness even when
 * multiple waiters are woken simultaneously.
 */
export interface TransactionManager {
  begin(isNested: boolean): Promise<void>;
  commit(isNested: boolean): void;
  rollback(isNested: boolean): void;
  isInTransaction(): boolean;
}

export function createTransactionManager(): TransactionManager {
  let waitOnCurrentFunction: Promise<void> | null = null;
  let markTransactionDone: (() => void) | null = null;

  function endTransaction(isNested: boolean): void {
    if (!isNested) {
      if (markTransactionDone === null) {
        throw new Error("TransactionManager: no active transaction to end");
      }
      const done = markTransactionDone;
      waitOnCurrentFunction = null;
      markTransactionDone = null;
      done();
    }
  }

  return {
    async begin(isNested: boolean): Promise<void> {
      if (!isNested) {
        while (waitOnCurrentFunction !== null) {
          await waitOnCurrentFunction;
        }
        waitOnCurrentFunction = new Promise<void>((resolve) => {
          markTransactionDone = resolve;
        });
      }
    },
    commit(isNested: boolean): void {
      endTransaction(isNested);
    },
    rollback(isNested: boolean): void {
      endTransaction(isNested);
    },
    isInTransaction(): boolean {
      return waitOnCurrentFunction !== null;
    },
  };
}
