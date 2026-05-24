import { vi } from "vitest";

/**
 * Flush the microtask queue so queued promise callbacks settle deterministically.
 * Replaces `await new Promise((r) => setTimeout(r, 0))` for microtask-deferred work.
 */
export async function flushMicrotasks(iterations = 2): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Run `fn` with fake timers installed, restoring real timers afterward even on
 * throw. Use `vi.advanceTimersByTimeAsync` / `vi.runAllTimersAsync` inside.
 */
export async function withFakeTimers<T>(fn: () => Promise<T> | T): Promise<T> {
  vi.useFakeTimers();
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}
