/**
 * Pluggable cooperative work scheduler. The runtime defers CPU-heavy
 * background work (cache extraction, doc-store hydration, mid-batch
 * SQLite yields) through a {@link WorkScheduler} so each platform can
 * pick the right primitive — Web Scheduler API in browsers,
 * `InteractionManager` in Expo, `setImmediate` in Node — without the
 * core runtime needing to know.
 *
 * @packageDocumentation
 */

/**
 * Three priority lanes mirroring the Web Scheduler API.
 *
 * - `"user-blocking"` — runs on the next microtask. Use when delaying
 *   the work would visibly stall the UI (e.g. an optimistic apply).
 * - `"user-visible"` — runs on the next macrotask. Use for work the
 *   user will see soon but doesn't block the current click.
 * - `"background"` — runs during browser idle time when available, or
 *   the next macrotask otherwise. Use for cache hydration, doc-store
 *   extraction, telemetry flushes — work that should never compete
 *   with input.
 *
 * @public
 */
export type WorkPriority = "user-blocking" | "user-visible" | "background";

/**
 * Cooperative scheduler interface implemented per platform.
 *
 * Platform implementations live next to each entry-point adapter
 * (`createBrowserWorkScheduler` / `createExpoWorkScheduler` /
 * `createNodeWorkScheduler`) and are auto-installed by the
 * corresponding `createXxxPlatformAdapter` factory. Apps with custom
 * platform adapters can swap in their own implementation.
 *
 * @public
 */
export interface WorkScheduler {
  /** Schedule `work` to run at the given priority. */
  post(priority: WorkPriority, work: () => void): void;
  /**
   * Yield to the platform: returns a promise that resolves on the next
   * macrotask, letting the runtime cooperatively break long loops.
   * Pair with {@link shouldYield} for budget-based yielding.
   */
  yield(): Promise<void>;
  /**
   * Whether the runtime should yield now. Platform implementations
   * typically return `true` when input is pending or when the JS frame
   * budget (~5ms) has been exceeded since the last yield.
   */
  shouldYield(): boolean;
}

const microtask = (work: () => void): void => {
  queueMicrotask(work);
};

const macrotask: (work: () => void) => void =
  typeof globalThis !== "undefined" && typeof MessageChannel === "function"
    ? (() => {
        const channel = new MessageChannel();
        const queue: Array<() => void> = [];
        channel.port1.onmessage = () => {
          const next = queue.shift();
          if (next) next();
        };
        return (work: () => void) => {
          queue.push(work);
          channel.port2.postMessage(null);
        };
      })()
    : (work: () => void) => {
        setTimeout(work, 0);
      };

const idle: (work: () => void) => void =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback ===
    "function"
    ? (work) => {
        (
          globalThis as {
            requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void;
          }
        ).requestIdleCallback(work, { timeout: 100 });
      }
    : macrotask;

/**
 * Build a {@link WorkScheduler} that uses the most efficient
 * platform-agnostic primitives available — `queueMicrotask` for
 * user-blocking, `MessageChannel.postMessage` for user-visible (avoids
 * the `setTimeout(0)` 4ms minimum on browsers), `requestIdleCallback`
 * for background where supported.
 *
 * Platform adapters typically call this and override only the parts
 * they need (e.g. Expo wraps the macrotask lane with
 * `InteractionManager.runAfterInteractions`).
 *
 * @public
 */
export function createDefaultWorkScheduler(): WorkScheduler {
  let lastYieldMs =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const FRAME_BUDGET_MS = 5;
  return {
    post(priority, work) {
      switch (priority) {
        case "user-blocking":
          microtask(work);
          return;
        case "user-visible":
          macrotask(work);
          return;
        case "background":
          idle(work);
          return;
      }
    },
    yield(): Promise<void> {
      lastYieldMs =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      return new Promise((resolve) => macrotask(resolve));
    },
    shouldYield(): boolean {
      const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      if (now - lastYieldMs >= FRAME_BUDGET_MS) {
        return true;
      }
      return false;
    },
  };
}

