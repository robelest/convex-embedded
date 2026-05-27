import { createLogger } from "@/shared/logger";

const log = createLogger("scope");

/**
 * A disposable scope that runs registered finalizers in LIFO order on close.
 * Implements `Symbol.asyncDispose` so callers can use `await using`:
 *
 * ```ts
 * {
 *   await using scope = createDisposableScope();
 *   scope.addFinalizer(() => stream.close());
 * } // scope.close() runs automatically here
 * ```
 */
export interface DisposableScope {
  addFinalizer(fn: () => void | Promise<void>): void;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function createDisposableScope(): DisposableScope {
  const finalizers: Array<() => void | Promise<void>> = [];
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const reversed = [...finalizers].reverse();
    finalizers.length = 0;
    for (const fn of reversed) {
      try {
        await fn();
      } catch (error) {
        log.error("finalizer error:", error);
      }
    }
  }

  return {
    addFinalizer(fn: () => void | Promise<void>): void {
      if (closed) {
        throw new Error("Cannot add finalizer to a closed scope.");
      }
      finalizers.push(fn);
    },
    close,
    async [Symbol.asyncDispose](): Promise<void> {
      await close();
    },
  };
}
