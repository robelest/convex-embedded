import { createLogger } from "@/shared/logger";

const log = createLogger("scope");

/**
 * A disposable scope that runs registered finalizers in LIFO order on close.
 * Implements `Symbol.asyncDispose` so callers can use `await using`:
 *
 * ```ts
 * {
 *   await using scope = new DisposableScope();
 *   scope.addFinalizer(() => stream.close());
 * } // scope.close() runs automatically here
 * ```
 */
export class DisposableScope {
  private finalizers: Array<() => void | Promise<void>> = [];
  private closed = false;

  addFinalizer(fn: () => void | Promise<void>): void {
    if (this.closed) {
      throw new Error("Cannot add finalizer to a closed scope.");
    }
    this.finalizers.push(fn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const reversed = [...this.finalizers].reverse();
    this.finalizers.length = 0;
    for (const fn of reversed) {
      try {
        await fn();
      } catch (error) {
        log.error("finalizer error:", error);
      }
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
