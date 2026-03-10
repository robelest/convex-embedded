/**
 * Discriminated union representing the outcome of an {@link Fx} computation.
 *
 * Every `Fx` computation, when executed, produces a `Result` — either a
 * `Success` carrying the value of type `A`, or a `Failure` carrying a
 * typed error of type `E`.
 *
 * @remarks
 * Pattern-match on the `_tag` field to distinguish outcomes:
 *
 * ```ts
 * if (result._tag === "Success") {
 *   console.log(result.value);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 *
 * `Result` is the **internal** representation returned by {@link Fx._run}.
 * Most code should use higher-level combinators ({@link Fx.map},
 * {@link Fx.recover}, {@link Fx.fold}) instead of inspecting `Result`
 * directly.
 *
 * @typeParam A - The success value type.
 * @typeParam E - The typed error type.
 *
 * @example
 * ```ts
 * // A successful result
 * const success: Result<number, never> = { _tag: "Success", value: 42 };
 *
 * // A failed result
 * const failure: Result<never, Error> = { _tag: "Failure", error: new Error("boom") };
 * ```
 *
 * @see {@link Exit} — A variant of `Result` that also accounts for unrecoverable defects.
 * @see {@link Fx._run} — Returns a `Promise<Result<A, E>>`.
 *
 * @category Type
 */
export type Result<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E };

/**
 * The exit value from a computation that may produce unrecoverable defects.
 *
 * `Exit` extends {@link Result} by widening the error channel to include
 * {@link FxFatal}. This is used by {@link Fx.bracket}'s `release` callback,
 * which receives the `Exit` so it can distinguish between:
 *
 * - **Success** — the `use` phase completed normally.
 * - **Failure with typed error** — the `use` phase failed with a known error `E`.
 * - **Failure with FxFatal** — the `use` phase threw an unrecoverable defect
 *   (created via {@link Fx.fatal}).
 *
 * @typeParam A - The success value type.
 * @typeParam E - The typed error type (excluding defects).
 *
 * @remarks
 * In the `release` callback of `bracket`, check for `FxFatal` to handle
 * defects differently from typed errors:
 *
 * ```ts
 * Fx.bracket(
 *   acquire,
 *   use,
 *   (resource, exit) => {
 *     if (exit._tag === "Failure" && exit.error instanceof FxFatal) {
 *       // Unrecoverable defect — emergency cleanup
 *     }
 *     return cleanup(resource);
 *   },
 * );
 * ```
 *
 * @see {@link Result} — The simpler variant without `FxFatal` in the error channel.
 * @see {@link FxFatal} — The wrapper type for unrecoverable defects.
 * @see {@link Fx.bracket} — The primary consumer of `Exit`.
 *
 * @category Type
 */
export type Exit<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E | FxFatal };

/**
 * Marker wrapper for unrecoverable errors (defects) thrown via {@link Fx.fatal}.
 *
 * `FxFatal` represents a defect — an error that should **not** be caught by
 * normal error-handling combinators like {@link Fx.recover} or {@link Fx.fold}.
 * It signals a programming error, violated invariant, or otherwise
 * unrecoverable situation.
 *
 * @remarks
 * **Creation**: Use {@link Fx.fatal} to create an `Fx` that throws `FxFatal`.
 * Never construct `FxFatal` directly in application code.
 *
 * **Propagation**: `FxFatal` is thrown as an exception internally, bypassing
 * the `Result` error channel. This means:
 * - {@link Fx.recover} does **not** catch it.
 * - {@link Fx.fold} does **not** catch it.
 * - {@link Fx.inspect} does **not** observe it.
 * - It propagates up through the entire Fx chain as an unhandled exception.
 *
 * **Unwrapping**: {@link Fx.run} catches `FxFatal` and re-throws the inner
 * `defect`, so callers see the original error (not the `FxFatal` wrapper).
 *
 * @example
 * ```ts
 * // Fx.fatal creates an FxFatal internally
 * const fx = Fx.fatal(new Error("invariant violated"));
 *
 * // Fx.run unwraps it — the Promise rejects with the original Error,
 * // not with FxFatal
 * await Fx.run(fx); // throws Error("invariant violated")
 * ```
 *
 * @example
 * ```ts
 * // FxFatal is NOT caught by recover
 * const fx = Fx.fatal("bug").pipe(
 *   Fx.recover(() => Fx.succeed("recovered")),
 * );
 * await Fx.run(fx); // still throws "bug" — recover is bypassed
 * ```
 *
 * @see {@link Fx.fatal} — Creates an `Fx` that throws `FxFatal`.
 * @see {@link Fx.run} — Unwraps `FxFatal` on execution.
 * @see {@link Exit} — Includes `FxFatal` in the error channel for `bracket` release.
 *
 * @category Type
 */
export class FxFatal {
  readonly _tag = "Fatal" as const;
  constructor(readonly defect: unknown) {}
}
