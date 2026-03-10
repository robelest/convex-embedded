/**
 * Fire-and-forget an async function, logging any errors instead of rejecting.
 *
 * `detach` executes `fn()` immediately, catches any thrown or rejected error,
 * and logs it via `console.error(label, err)`. It returns `void` synchronously
 * — the caller never awaits the result and never sees the error.
 *
 * @remarks
 * Use `detach` for background tasks where the caller does not need the result
 * and must not be blocked by the outcome. It prevents unhandled promise
 * rejections by unconditionally catching all errors and routing them to
 * `console.error`.
 *
 * The {@link label} string is prepended to every error log, making it easy to
 * identify which fire-and-forget call failed when scanning logs.
 *
 * `detach` does **not** participate in the `Fx` type system — it is a raw
 * utility for cases where you explicitly want to discard the result and opt
 * out of typed error tracking. If you need composable error handling, use
 * `Fx.from` / `Fx.inspectErr` instead.
 *
 * Common use cases include cache invalidation, background persistence,
 * fire-and-forget notifications, deferred scheduling, and graceful cleanup
 * during shutdown.
 *
 * @param fn - A zero-argument async function to execute. Its return value is
 *   discarded; only errors are observed (and logged).
 * @param label - A descriptive string prepended to `console.error` when `fn`
 *   rejects. Use it to identify the call site (e.g.
 *   `"[myModule] background sync failed:"`).
 * @returns `void` — returns synchronously before `fn` settles.
 *
 * @example
 * **Background persistence after an in-memory commit (database.ts):**
 * ```ts
 * import { detach } from "@robelest/fx";
 *
 * // After applying writes to the in-memory store, persist to durable
 * // storage without blocking the caller.
 * if (storage !== null && (puts.length > 0 || deletes.length > 0)) {
 *   detach(
 *     () => storage.commit({ puts, deletes, meta }),
 *     "[convex-embedded] storage commit failed:",
 *   );
 * }
 * ```
 *
 * @example
 * **Fire-and-forget scheduled function execution (executor.ts):**
 * ```ts
 * import { detach } from "@robelest/fx";
 *
 * const timerId = setTimeout(() => {
 *   // Errors are logged, not thrown — matches Convex's scheduled
 *   // function semantics where failures don't propagate to the caller.
 *   detach(
 *     () => runFunction(functionPath, args),
 *     `[SchedulerExecutor] Scheduled function "${functionPath}" failed:`,
 *   );
 * }, delayMs);
 * ```
 *
 * @example
 * **Graceful storage cleanup during runtime shutdown (embedded.ts):**
 * ```ts
 * import { detach } from "@robelest/fx";
 *
 * shutdown(): void {
 *   // Best-effort close — don't let a storage error prevent teardown.
 *   if (storageAdapter?.close) {
 *     detach(
 *       () => storageAdapter.close(),
 *       "[convex-embedded] storage close failed:",
 *     );
 *   }
 * }
 * ```
 *
 * @see {@link Fx.inspect} for composable error observation within the Fx pipeline.
 * @see {@link Fx.from} for wrapping async operations with typed error tracking.
 *
 * @category Helper
 */
export function detach(fn: () => Promise<unknown>, label: string): void {
  fn().catch((err) => {
    console.error(label, err);
  });
}
