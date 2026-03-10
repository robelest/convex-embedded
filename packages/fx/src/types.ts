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

/**
 * A lazy, composable computation that produces a success value `A` or fails
 * with a typed error `E`.
 *
 * `Fx` is the core type of the `@robelest/fx` library. It represents a
 * **deferred** computation — nothing executes until {@link Fx.run} is called.
 * This allows building complex pipelines by composing small, focused
 * computations.
 *
 * @remarks
 * **Laziness**: An `Fx` value is a description of a computation, not its
 * result. The same `Fx` can be run multiple times, producing fresh results
 * each time. This is critical for {@link Fx.retry}, which re-executes the
 * computation on each attempt.
 *
 * **Error typing**: The `E` type parameter tracks all possible error types
 * through the pipeline. When `E` is `never`, the computation cannot fail
 * with a typed error (though it can still throw unrecoverable defects via
 * {@link Fx.fatal}).
 *
 * **Two composition styles**:
 *
 * 1. **`.pipe()` chaining** — fluent, data-last combinators:
 *    ```ts
 *    const result = Fx.from({ ok: () => fetchUser(id), err: toAppError })
 *      .pipe(
 *        Fx.map(user => user.name),
 *        Fx.recover(() => Fx.succeed("anonymous")),
 *      );
 *    ```
 *
 * 2. **`Fx.gen` generators** — imperative-looking, sequential:
 *    ```ts
 *    const result = Fx.gen(function* () {
 *      const user = yield* Fx.from({ ok: () => fetchUser(id), err: toAppError });
 *      return user.name;
 *    });
 *    ```
 *
 * **No environment type**: Unlike Effect's `R` parameter, `Fx` has no
 * built-in dependency injection. Pass dependencies explicitly via function
 * arguments or closures.
 *
 * @typeParam A - The success value type produced when the computation succeeds.
 * @typeParam E - The typed error type produced when the computation fails.
 *              Defaults to `never` (computation cannot fail).
 *
 * @example
 * ```ts
 * // Create an Fx that fetches a user, map the result, run it
 * const getName: Fx<string, FetchError> = Fx.from({
 *   ok: () => fetch("/api/user").then(r => r.json()),
 *   err: (e) => new FetchError(e),
 * }).pipe(
 *   Fx.map(user => user.name),
 * );
 *
 * const name: string = await Fx.run(getName);
 * ```
 *
 * @example
 * ```ts
 * // Using generators for sequential composition
 * const pipeline = Fx.gen(function* () {
 *   const user = yield* fetchUserFx(id);
 *   const posts = yield* fetchPostsFx(user.id);
 *   return { user, posts };
 * });
 * ```
 *
 * @see {@link Fx.run} — Execute the computation and get a `Promise<A>`.
 * @see {@link Fx.gen} — Generator-based sequential composition.
 * @see {@link Fx.from} — The primary constructor for fallible operations.
 *
 * @category Type
 */
export interface Fx<A, E = never> {
  /**
   * Execute the computation and return its {@link Result}.
   *
   * @remarks
   * **Internal API** — This is the low-level execution mechanism used by
   * combinators and the runtime. Application code should use {@link Fx.run}
   * instead, which provides proper error handling and `FxFatal` unwrapping.
   *
   * Each call to `_run()` produces a fresh execution. For retry scenarios,
   * this means the computation runs from scratch on each attempt.
   *
   * @returns A Promise resolving to `Result<A, E>` — either `{ _tag: "Success", value: A }`
   *          or `{ _tag: "Failure", error: E }`. May also throw `FxFatal` for
   *          unrecoverable defects.
   *
   * @see {@link Fx.run} — The public execution API.
   */
  readonly _run: () => Promise<Result<A, E>>;

  /**
   * Chain combinators fluently using data-last function composition.
   *
   * Each overload accepts 1–4 functions that are applied left-to-right.
   * The first function receives `this` (the `Fx` instance), and each
   * subsequent function receives the return value of the previous one.
   *
   * @remarks
   * `.pipe()` is the primary way to compose Fx operations. All combinators
   * in the `Fx` namespace (`Fx.map`, `Fx.then`, `Fx.recover`, etc.) are
   * designed as data-last functions that return a function, making them
   * directly usable with `.pipe()`.
   *
   * @example
   * ```ts
   * // Single combinator
   * const doubled = Fx.succeed(21).pipe(Fx.map(x => x * 2));
   *
   * // Multiple combinators chained
   * const result = Fx.from({ ok: () => fetchData(), err: toAppError }).pipe(
   *   Fx.map(data => data.items),
   *   Fx.tap(items => Fx.sync(() => console.log(`Got ${items.length} items`))),
   *   Fx.recover(() => Fx.succeed([])),
   * );
   * ```
   *
   * @example
   * ```ts
   * // Combining with retry and timeout
   * const robust = fetchFx.pipe(
   *   Fx.timeout(5000),
   *   Fx.retry(Fx.retry.compose(
   *     Fx.retry.jittered(Fx.retry.exponential(100)),
   *     Fx.retry.recurs(3),
   *   )),
   * );
   * ```
   *
   * @see {@link Fx.map} — Transform the success value.
   * @see {@link Fx.then} — Chain to another `Fx`.
   * @see {@link Fx.recover} — Handle errors.
   */
  pipe<B>(ab: (self: Fx<A, E>) => B): B;
  pipe<B, C>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C): C;
  pipe<B, C, D>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  pipe<B, C, D, F>(
    ab: (self: Fx<A, E>) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => F,
  ): F;

  /**
   * Enable `yield*` syntax inside {@link Fx.gen} generator functions.
   *
   * When you write `yield* someFx` inside an `Fx.gen` block, TypeScript
   * calls this iterator. The generator runner intercepts the yielded `Fx`,
   * executes it, and resumes the generator with the success value (or
   * short-circuits on failure).
   *
   * @remarks
   * You never call this method directly. It exists solely to make `yield*`
   * work with `Fx` values inside generator functions.
   *
   * @returns A generator that yields `this` and returns the unwrapped value `A`.
   *
   * @example
   * ```ts
   * const pipeline = Fx.gen(function* () {
   *   // yield* uses [Symbol.iterator] under the hood
   *   const a = yield* Fx.succeed(1);
   *   const b = yield* Fx.succeed(2);
   *   return a + b; // 3
   * });
   * ```
   *
   * @see {@link Fx.gen} — The generator runner that consumes this iterator.
   */
  [Symbol.iterator](): Generator<Fx<A, E>, A, A>;
}
