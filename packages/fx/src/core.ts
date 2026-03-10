import type { RetryPolicy } from "./schedule.js";
import * as schedule from "./schedule.js";
import type { Result, Exit } from "./types.js";
import { FxFatal } from "./types.js";

// ---------------------------------------------------------------------------
// Core type
// ---------------------------------------------------------------------------

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
   * in the `Fx` namespace (`Fx.map`, `Fx.chain`, `Fx.recover`, etc.) are
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
   * @see {@link Fx.chain} — Chain to another `Fx`.
   * @see {@link Fx.recover} — Handle errors.
   */
  pipe<B>(ab: (self: Fx<A, E>) => B): B;
  pipe<B, C>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C): C;
  pipe<B, C, D>(
    ab: (self: Fx<A, E>) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
  ): D;
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

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

/** @internal */
class FxImpl<A, E = never> implements Fx<A, E> {
  constructor(readonly _run: () => Promise<Result<A, E>>) {}

  /** Construct with widened types — avoids casts at every combinator site. */
  static of<A, E>(run: () => Promise<Result<any, any>>): Fx<A, E> {
    return new FxImpl(run) as unknown as Fx<A, E>;
  }

  pipe<B>(ab: (self: Fx<A, E>) => B): B;
  pipe<B, C>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C): C;
  pipe<B, C, D>(
    ab: (self: Fx<A, E>) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
  ): D;
  pipe<B, C, D, F>(
    ab: (self: Fx<A, E>) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => F,
  ): F;
  pipe(...fns: Array<(x: any) => any>): any {
    return fns.reduce((result, fn) => fn(result), this as unknown);
  }

  *[Symbol.iterator](): Generator<Fx<A, E>, A, A> {
    return yield this;
  }
}

/** @internal */
function ok<A>(value: A): Result<A, never> {
  return { _tag: "Success", value };
}

/** @internal */
function err<E>(error: E): Result<never, E> {
  return { _tag: "Failure", error };
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Wrap a plain value into a successful computation.
 *
 * @remarks
 * `succeed` is the simplest constructor — it lifts an already-available value
 * into the `Fx` world so it can participate in pipelines and generators. The
 * computation is still lazy (a new `Promise` is created on each `_run()`), but
 * the value itself is captured eagerly at construction time.
 *
 * Use `succeed` when you already have the value in hand. If the value requires
 * computation (even synchronous), prefer {@link sync} to defer it. If the value
 * might come from a fallible operation, use {@link from} instead.
 *
 * @param value - The value to wrap. Can be any type, including `undefined`.
 *
 * @returns An `Fx<A, never>` that always succeeds with `value`.
 *
 * @example
 * ```ts
 * // Provide a default value in a recover branch
 * const pipeline = Fx.from({
 *   ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
 *   err: (e) => e as Error,
 * }).pipe(
 *   Fx.recover(() => Fx.succeed([])),
 * );
 * ```
 *
 * @see {@link sync} — For deferred synchronous computation.
 * @see {@link from} — For fallible sync/async operations with error mapping.
 * @see {@link unit} — Pre-built `Fx<void, never>` that succeeds with `undefined`.
 *
 * @category Constructor
 */
function succeed<A>(value: A): Fx<A, never> {
  return new FxImpl(async () => ok(value));
}

/**
 * Wrap a synchronous thunk into a deferred computation.
 *
 * @remarks
 * The thunk `f` is not called until the `Fx` is executed (via {@link run} or
 * as part of a pipeline). This makes `sync` suitable for capturing
 * side-effects that should only happen at execution time, such as logging,
 * reading mutable state, or constructing objects.
 *
 * `sync` does **not** have an error channel — if `f` throws, the exception
 * propagates as an unhandled defect (equivalent to {@link fatal}). If your
 * thunk can fail, use {@link from} with an `err` mapper instead.
 *
 * @param f - A synchronous function that produces the success value. Called
 *   once per execution.
 *
 * @returns An `Fx<A, never>` that succeeds with the return value of `f`.
 *
 * @example
 * ```ts
 * // Log a side-effect during a pipeline without altering the value
 * const attempt = Fx.defer(() =>
 *   Fx.from({
 *     ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
 *     err: (err) => err as Error,
 *   }),
 * ).pipe(
 *   Fx.inspect((err) =>
 *     Fx.sync(() => {
 *       log.warn(`resolve attempt failed for "${tableName}"`, err);
 *     }),
 *   ),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Spawn a Worker inside bracket's acquire phase
 * Fx.bracket(
 *   Fx.sync(() => new Worker(workerUrl, { type: "module" })),
 *   (worker) => Fx.from({ ok: async () => { ... }, err: toError }),
 *   (worker, exit) => {
 *     if (exit._tag === "Failure") worker.terminate();
 *     return Fx.unit;
 *   },
 * );
 * ```
 *
 * @see {@link from} — For fallible operations with error mapping.
 * @see {@link promise} — For infallible async thunks.
 * @see {@link succeed} — When you already have the value.
 *
 * @category Constructor
 */
function sync<A>(f: () => A): Fx<A, never> {
  return new FxImpl(async () => ok(f()));
}

/**
 * Wrap a Promise-returning thunk into a computation with no error channel.
 *
 * @remarks
 * Use `promise` **only** when the Promise cannot reject — for example,
 * when calling an API that signals errors in its return value rather than
 * by throwing. If the Promise can reject, the rejection propagates as an
 * unhandled defect (like {@link fatal}). For fallible async operations,
 * always prefer {@link from} which provides an `err` mapper.
 *
 * The thunk is deferred: the Promise is not created until execution time.
 *
 * @param f - A function returning a `Promise<A>` that is assumed to never
 *   reject.
 *
 * @returns An `Fx<A, never>` that succeeds with the resolved value.
 *
 * @example
 * ```ts
 * // Wait for an event that cannot fail
 * const waitForOnline = Fx.promise(
 *   () => new Promise<void>((resolve) => {
 *     window.addEventListener("online", () => resolve(), { once: true });
 *   }),
 * );
 * ```
 *
 * @see {@link from} — Preferred for fallible async operations with error mapping.
 * @see {@link sync} — For synchronous infallible thunks.
 *
 * @category Constructor
 */
function promise<A>(f: () => Promise<A>): Fx<A, never> {
  return new FxImpl(async () => ok(await f()));
}

/**
 * Lift a sync or async function that can throw into an `Fx` with typed error mapping.
 *
 * @remarks
 * `from` is **the workhorse constructor** for creating `Fx` values from real-world
 * operations. It replaces the older `tryPromise` and `try_` patterns by accepting an
 * `ok` callback that may return either `A` or `Promise<A>` — the result is always
 * `await`-ed internally, so both sync and async operations work identically.
 *
 * When `ok` throws (or the returned Promise rejects), the caught exception is passed
 * to `err`, which maps it to the typed error channel `E`. This ensures every possible
 * failure is captured in the type system.
 *
 * `from` does **not** catch {@link FxFatal} — defects thrown via `Fx.fatal()` inside
 * the `ok` callback propagate through without hitting the `err` mapper.
 *
 * This is the constructor you should reach for when wrapping:
 * - HTTP/RPC calls (e.g. `remoteClient.query(...)`)
 * - Database operations (e.g. OCC transaction body)
 * - File system or Worker initialization
 * - Any operation whose failure you want to type and handle
 *
 * @param opts - An object with two callbacks:
 * @param opts.ok - The operation to attempt. May return `A` (sync) or `Promise<A>`
 *   (async). Always awaited internally.
 * @param opts.err - Maps a caught exception (`unknown`) to the typed error `E`.
 *
 * @returns An `Fx<A, E>` that succeeds with the value from `ok` or fails with the
 *   mapped error from `err`.
 *
 * @example
 * ```ts
 * // Wrapping a remote query call with typed error mapping
 * const resolveTable = Fx.from({
 *   ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
 *   err: (err) => err as Error,
 * });
 * ```
 *
 * @example
 * ```ts
 * // Wrapping a fallible function in an OCC transaction, chaining with Fx.chain
 * const attempt = Fx.from({ ok: () => fn(), err: (e) => e }).pipe(
 *   Fx.chain((result) =>
 *     Fx.from({
 *       ok: () => {
 *         this._validateReadSet();
 *         this._db.commit();
 *         return result;
 *       },
 *       err: (e) => e,
 *     }),
 *   ),
 *   Fx.recover((err) => {
 *     this._db.rollbackWrites();
 *     return err instanceof OccConflictError
 *       ? Fx.fail(err)
 *       : Fx.fatal(err);
 *   }),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Wrapping Worker initialization inside bracket's use phase
 * Fx.bracket(
 *   Fx.sync(() => new Worker(workerUrl, { type: "module" })),
 *   (worker) =>
 *     Fx.from({
 *       ok: async () => {
 *         await rpc(worker, { method: "init", name, wasmModule });
 *         return buildAdapter(worker);
 *       },
 *       err: (err) =>
 *         new Error(`wa-sqlite worker init failed: ${
 *           err instanceof Error ? err.message : String(err)
 *         }`),
 *     }),
 *   (worker, exit) => {
 *     if (exit._tag === "Failure") worker.terminate();
 *     return Fx.unit;
 *   },
 * );
 * ```
 *
 * @see {@link succeed} — For values that cannot fail.
 * @see {@link fail} — For immediate typed failures.
 * @see {@link fatal} — For unrecoverable defects.
 *
 * @category Constructor
 */
function from<A, E>(opts: {
  ok: () => A | Promise<A>;
  err: (error: unknown) => E;
}): Fx<A, E> {
  return new FxImpl(async () => {
    try {
      return ok(await opts.ok());
    } catch (e) {
      return err(opts.err(e));
    }
  });
}

/**
 * Create an immediately-failed computation with a typed error.
 *
 * @remarks
 * `fail` produces an `Fx` that, when executed, immediately yields a `Failure`
 * result containing `error`. The error is captured in the type system as `E`,
 * making it visible to downstream combinators like {@link recover},
 * {@link inspect}, and {@link fold}.
 *
 * Unlike {@link fatal}, errors created with `fail` are **recoverable** — they
 * flow through the normal typed error channel and can be caught by
 * {@link recover} or collapsed by {@link fold}.
 *
 * Common uses include signaling domain-specific errors, providing fallback
 * errors in {@link guard} branches, and converting untyped exceptions into
 * typed failures via {@link recover}.
 *
 * @param error - The typed error value.
 *
 * @returns An `Fx<never, E>` that always fails with `error`.
 *
 * @example
 * ```ts
 * // Early return with guard on an empty condition
 * Fx.gen(function* () {
 *   yield* Fx.guard(items.length === 0, Fx.fail(new EmptyError()));
 *   // ... process items
 * });
 * ```
 *
 * @example
 * ```ts
 * // Routing recoverable vs unrecoverable errors after a transaction
 * Fx.recover((err) => {
 *   this._db.rollbackWrites();
 *   return err instanceof OccConflictError
 *     ? Fx.fail(err)    // Recoverable — retry will catch this
 *     : Fx.fatal(err);  // Unrecoverable — bypass retry
 * });
 * ```
 *
 * @see {@link fatal} — For unrecoverable defects that bypass error handling.
 * @see {@link recover} — Catches typed errors from `fail`.
 * @see {@link guard} — Often paired with `fail` for early returns.
 *
 * @category Constructor
 */
function fail<E>(error: E): Fx<never, E> {
  return new FxImpl(async () => err(error));
}

/**
 * Throw an unrecoverable defect that bypasses all error-handling combinators.
 *
 * @remarks
 * `fatal` creates an `Fx` that, when executed, throws an {@link FxFatal}
 * internally. This exception **is not caught** by {@link recover},
 * {@link fold}, or {@link inspect} — it propagates through the entire `Fx`
 * chain as an unhandled exception.
 *
 * When {@link run} encounters an `FxFatal`, it unwraps the inner `defect`
 * and re-throws it, so the caller sees the original error rather than the
 * `FxFatal` wrapper.
 *
 * Use `fatal` for programming errors, violated invariants, or situations
 * where continuing execution would be meaningless. For errors that callers
 * should handle, use {@link fail} instead.
 *
 * The only place that observes `FxFatal` is {@link bracket}'s `release`
 * callback, which receives an {@link Exit} containing the `FxFatal` so it
 * can perform emergency cleanup.
 *
 * @param defect - The underlying error or value representing the defect.
 *   Can be any type (Error, string, object, etc.).
 *
 * @returns An `Fx<never, never>` that always throws `FxFatal(defect)` on
 *   execution.
 *
 * @throws {FxFatal} Internally. Unwrapped by {@link run} into the raw `defect`.
 *
 * @example
 * ```ts
 * // In an OCC transaction: non-conflict errors are unrecoverable defects
 * Fx.recover((err) => {
 *   this._db.rollbackWrites();
 *   return err instanceof OccConflictError
 *     ? Fx.fail(err)
 *     : Fx.fatal(err);  // Programming error — don't retry
 * });
 * ```
 *
 * @see {@link fail} — For recoverable typed errors.
 * @see {@link FxFatal} — The wrapper class thrown internally.
 * @see {@link run} — Unwraps `FxFatal` on execution.
 * @see {@link bracket} — Release callback receives `FxFatal` in Exit.
 *
 * @category Constructor
 */
function fatal(defect: unknown): Fx<never, never> {
  return new FxImpl(async () => {
    throw new FxFatal(defect);
  });
}

/**
 * Lazily construct an `Fx` at execution time rather than at definition time.
 *
 * @remarks
 * `defer` delays the creation of the `Fx` itself until `_run()` is called.
 * This is critical for {@link retry} — without `defer`, each retry attempt
 * would re-execute the same `Fx` instance (which may have captured stale
 * closures or already-consumed resources). With `defer`, the factory `f` is
 * called fresh on every execution, producing a brand-new `Fx` each time.
 *
 * `defer` is also useful when construction has side-effects (like resetting
 * state or acquiring resources) that must happen at the start of each attempt,
 * not once at pipeline definition time.
 *
 * @param f - A factory that produces a fresh `Fx<A, E>` on each invocation.
 *
 * @returns An `Fx<A, E>` that, when executed, calls `f()` and runs the
 *   resulting `Fx`.
 *
 * @example
 * ```ts
 * // OCC transaction: defer ensures each retry gets a fresh attempt
 * // with reset read tracking and a new database transaction
 * const attempt = Fx.defer(() => {
 *   this._readSet.clear();
 *   this._tablesRead.clear();
 *   this._db.startTransaction();
 *
 *   return Fx.from({ ok: () => fn(), err: (e) => e }).pipe(
 *     Fx.chain((result) =>
 *       Fx.from({
 *         ok: () => {
 *           this._validateReadSet();
 *           this._db.commit();
 *           return result;
 *         },
 *         err: (e) => e,
 *       }),
 *     ),
 *   );
 * });
 *
 * return Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
 * ```
 *
 * @example
 * ```ts
 * // Check abort signal before each retry attempt
 * const attempt = Fx.defer(() => {
 *   if (signal?.aborted) {
 *     return Fx.fail(new DOMException("Aborted", "AbortError"));
 *   }
 *   return Fx.from({
 *     ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
 *     err: (err) => err as Error,
 *   });
 * });
 * ```
 *
 * @see {@link retry} — The primary consumer of `defer` for fresh attempts.
 * @see {@link sync} — For deferred synchronous values (not deferred Fx construction).
 *
 * @category Constructor
 */
function defer<A, E>(f: () => Fx<A, E>): Fx<A, E> {
  return new FxImpl(() => f()._run());
}

/**
 * A computation that succeeds with `undefined`.
 *
 * @remarks
 * `unit` is a pre-built `Fx<void, never>` representing a successful no-op.
 * Use it as a return value when a function signature requires an `Fx` but
 * there is nothing meaningful to return — for example, in {@link bracket}'s
 * `release` callback or as the "continue" branch of {@link guard}.
 *
 * `unit` is a singleton — every reference points to the same `Fx` instance.
 *
 * @example
 * ```ts
 * // bracket release: terminate worker on failure, do nothing on success
 * Fx.bracket(
 *   Fx.sync(() => new Worker(workerUrl, { type: "module" })),
 *   (worker) => Fx.from({ ok: () => init(worker), err: toError }),
 *   (worker, exit) => {
 *     if (exit._tag === "Failure") worker.terminate();
 *     return Fx.unit;
 *   },
 * );
 * ```
 *
 * @see {@link succeed} — For wrapping a specific value.
 * @see {@link guard} — Returns `unit` when the condition is false.
 *
 * @category Constructor
 */
const unit: Fx<void, never> = sync(() => undefined);

// ---------------------------------------------------------------------------
// Combinators (data-last, for `.pipe()`)
// ---------------------------------------------------------------------------

/**
 * Transform the success value of a computation, leaving failures unchanged.
 *
 * @remarks
 * `map` is data-last: it returns a function suitable for use with `.pipe()`.
 * If the upstream `Fx` fails, the failure passes through unchanged and `f`
 * is never called.
 *
 * For transformations that may themselves fail or produce another `Fx`, use
 * {@link chain} instead.
 *
 * @param f - A pure function that transforms the success value `A` into `B`.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<B, E>`.
 *
 * @example
 * ```ts
 * // Transform a user object to extract just the name
 * const getName = Fx.from({
 *   ok: () => fetchUser(id),
 *   err: (e) => new FetchError(e),
 * }).pipe(
 *   Fx.map((user) => user.name),
 * );
 * ```
 *
 * @see {@link chain} — FlatMap/chain when the transformation returns an Fx.
 * @see {@link fold} — Collapses both success and failure paths.
 * @see {@link tap} — Side-effects on success without changing the value.
 *
 * @category Combinator
 */
function map<A, B>(f: (a: A) => B) {
  return <E>(self: Fx<A, E>): Fx<B, E> =>
    new FxImpl(async () => {
      const r = await self._run();
      return r._tag === "Success" ? ok(f(r.value)) : r;
    });
}

/**
 * Chain a new computation from the success value (flatMap/bind).
 *
 * @remarks
 * `chain` is the monadic bind operation. When the upstream `Fx` succeeds,
 * `f` is called with the success value and must return a new `Fx`. If the
 * upstream fails, the failure short-circuits — `f` is never called and the
 * original error passes through.
 *
 * The error types are unioned: the resulting `Fx` may fail with either the
 * upstream error `E` or the chained computation's error `E2`.
 *
 * This is data-last for use with `.pipe()`.
 *
 * @param f - A function that takes the success value `A` and returns a new
 *   `Fx<B, E2>`.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<B, E | E2>`.
 *
 * @example
 * ```ts
 * // Chain validation after a database read in an OCC transaction
 * Fx.from({ ok: () => fn(), err: (e) => e }).pipe(
 *   Fx.chain((result) =>
 *     Fx.from({
 *       ok: () => {
 *         this._validateReadSet();
 *         this._db.commit();
 *         return result;
 *       },
 *       err: (e) => e,
 *     }),
 *   ),
 * );
 * ```
 *
 * @see {@link map} — When the transformation is pure (no new Fx).
 * @see {@link tap} — Side-effect that preserves the original value.
 * @see {@link gen} — Generator syntax for sequential chaining.
 *
 * @category Combinator
 */
function chain<A, B, E2>(f: (a: A) => Fx<B, E2>) {
  return <E>(self: Fx<A, E>): Fx<B, E | E2> =>
    FxImpl.of<B, E | E2>(async () => {
      const r = await self._run();
      if (r._tag === "Failure") return r;
      return f(r.value)._run();
    });
}

/**
 * Run a side-effecting computation on success, passing through the original value.
 *
 * @remarks
 * `tap` executes `f(value)` when the upstream succeeds, then discards `f`'s
 * success value and returns the original value. This is useful for logging,
 * metrics, or triggering secondary effects without altering the pipeline's
 * data flow.
 *
 * **Important**: If the `Fx` returned by `f` fails, that failure **propagates**
 * — it replaces the original success. This makes `tap` different from a simple
 * "fire and forget" — the side-effect can short-circuit the pipeline.
 *
 * If the upstream fails, `f` is never called and the failure passes through.
 *
 * @param f - A function that receives the success value and returns an `Fx`
 *   whose success value is ignored.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<A, E | E2>`.
 *
 * @example
 * ```ts
 * // Log success after resolving a table
 * const pipeline = attempt.pipe(
 *   Fx.retry(retrySchedule),
 *   Fx.tap(() =>
 *     Fx.sync(() =>
 *       log.debug(`monitor: resolved table "${tableName}"`),
 *     ),
 *   ),
 * );
 * ```
 *
 * @see {@link inspect} — The failure-side counterpart of `tap`.
 * @see {@link map} — Transform the value instead of side-effecting.
 * @see {@link chain} — Chain when you need to replace the value.
 *
 * @category Combinator
 */
function tap<A, E2>(f: (a: A) => Fx<unknown, E2>) {
  return <E>(self: Fx<A, E>): Fx<A, E | E2> =>
    FxImpl.of<A, E | E2>(async () => {
      const r = await self._run();
      if (r._tag === "Failure") return r;
      const r2 = await f(r.value)._run();
      if (r2._tag === "Failure") return r2;
      return r;
    });
}

/**
 * Run a side-effecting computation on failure, passing through the original error.
 *
 * @remarks
 * `inspect` is the failure-side counterpart of {@link tap}. When the upstream
 * fails, `f(error)` is called as a side-effect (e.g. logging). If `f`'s `Fx`
 * succeeds, the original error is returned unchanged. If `f`'s `Fx` **fails**,
 * that new failure replaces the original.
 *
 * `inspect` does **not** observe {@link FxFatal} defects — only typed errors
 * in the `E` channel trigger the callback.
 *
 * @param f - A function that receives the failure error and returns an `Fx`
 *   whose success value is ignored.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<A, E | E2>`.
 *
 * @example
 * ```ts
 * // Log failed resolve attempts before retry
 * const attempt = Fx.defer(() =>
 *   Fx.from({
 *     ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
 *     err: (err) => err as Error,
 *   }),
 * ).pipe(
 *   Fx.inspect((err) =>
 *     Fx.sync(() => {
 *       if (!(err instanceof DOMException && err.name === "AbortError")) {
 *         log.warn(`resolve attempt failed for "${tableName}"`, err);
 *       }
 *     }),
 *   ),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Log hydration failures, then recover
 * Fx.from({
 *   ok: () => this.db.hydrate(),
 *   err: (err) => err as Error,
 * }).pipe(
 *   Fx.inspect((err) =>
 *     Fx.sync(() => console.error("[convex-embedded] hydration failed:", err)),
 *   ),
 *   Fx.recover(() => Fx.unit),
 * );
 * ```
 *
 * @see {@link tap} — The success-side counterpart.
 * @see {@link recover} — Catches errors and produces a new Fx.
 *
 * @category Combinator
 */
function inspect<E, E2>(f: (e: E) => Fx<unknown, E2>) {
  return <A>(self: Fx<A, E>): Fx<A, E | E2> =>
    FxImpl.of<A, E | E2>(async () => {
      const r = await self._run();
      if (r._tag === "Success") return r;
      const r2 = await f(r.error)._run();
      if (r2._tag === "Failure") return r2;
      return r;
    });
}

/**
 * Recover from all typed errors by mapping to a new computation.
 *
 * @remarks
 * `recover` catches errors in the `E` channel and replaces them with a
 * new `Fx<B, E2>`. If the upstream succeeds, the value passes through
 * and `f` is never called.
 *
 * **`recover` does NOT catch {@link FxFatal}** defects. Fatal errors bypass
 * the typed error channel entirely and propagate as unhandled exceptions.
 * This is by design — defects represent unrecoverable situations.
 *
 * The result type is widened to `A | B` because the success value may come
 * from either the original computation or the recovery computation.
 *
 * @param f - A function that receives the typed error `E` and returns a
 *   new `Fx<B, E2>`.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<A | B, E2>`.
 *
 * @example
 * ```ts
 * // Recover from hydration failures by continuing with unit
 * Fx.from({
 *   ok: () => this.db.hydrate(),
 *   err: (err) => err as Error,
 * }).pipe(
 *   Fx.inspect((err) =>
 *     Fx.sync(() => console.error("[convex-embedded] hydration failed:", err)),
 *   ),
 *   Fx.recover(() => Fx.unit),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Route errors: conflict → retryable fail, other → unrecoverable fatal
 * Fx.recover((err) => {
 *   this._db.rollbackWrites();
 *   return err instanceof OccConflictError
 *     ? Fx.fail(err)
 *     : Fx.fatal(err);
 * });
 * ```
 *
 * @see {@link fold} — Collapses both paths into a single success value.
 * @see {@link inspect} — Observe errors without recovering.
 * @see {@link fatal} — The kind of defect that `recover` cannot catch.
 *
 * @category Combinator
 */
function recover<E, B, E2>(f: (e: E) => Fx<B, E2>) {
  return <A>(self: Fx<A, E>): Fx<A | B, E2> =>
    FxImpl.of<A | B, E2>(async () => {
      const r = await self._run();
      if (r._tag === "Success") return r;
      return f(r.error)._run();
    });
}

/**
 * Fold success and failure into a single successful computation.
 *
 * @remarks
 * `fold` collapses both the success and failure paths into a single value of
 * type `B`, producing an `Fx<B, never>` that always succeeds. This is useful
 * for converting an `Fx` into a "result" value that downstream code can
 * pattern-match on without needing error-handling combinators.
 *
 * Like {@link recover}, `fold` does **not** catch {@link FxFatal} defects.
 *
 * @param opts - An object with two mapping functions:
 * @param opts.ok - Maps the success value `A` to `B`.
 * @param opts.err - Maps the typed error `E` to `B`.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<B, never>`.
 *
 * @example
 * ```ts
 * // Fold a query attempt into a protocol state modification
 * const modification = Fx.attempt(
 *   () => executor.runQuery(q.udfPath, ...q.args),
 *   (value): StateModification => ({
 *     type: "QueryUpdated",
 *     queryId: q.queryId,
 *     value: value as JSONValue,
 *     logLines: [],
 *     journal: null,
 *   }),
 *   (err): StateModification => ({
 *     type: "QueryFailed",
 *     queryId: q.queryId,
 *     errorMessage: errorMessage(err),
 *     logLines: [errorMessage(err)],
 *     errorData: null,
 *     journal: null,
 *   }),
 * );
 * ```
 *
 * @see {@link recover} — Catches only errors, leaves success untouched.
 * @see {@link attempt} — Convenience that combines `from` + `fold`.
 *
 * @category Combinator
 */
function fold<A, E, B>(opts: { ok: (a: A) => B; err: (e: E) => B }) {
  return (self: Fx<A, E>): Fx<B, never> =>
    new FxImpl(async () => {
      const r = await self._run();
      return r._tag === "Success"
        ? ok(opts.ok(r.value))
        : ok(opts.err(r.error));
    });
}

/**
 * Add a delay (in milliseconds) before running the computation.
 *
 * @remarks
 * `delay` inserts a `setTimeout` pause **before** the upstream `Fx` starts
 * executing. The delay happens on every execution, including retries. This
 * is useful for rate-limiting, debouncing, or introducing artificial latency
 * in tests.
 *
 * The delay is not cancellable — once `_run()` is called, the timer runs to
 * completion. For time-bounded execution, use {@link timeout} instead.
 *
 * @param ms - The number of milliseconds to wait before execution.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<A, E>`.
 *
 * @example
 * ```ts
 * // Add a 500ms pause before a network call
 * const delayed = Fx.from({
 *   ok: () => fetch("/api/data"),
 *   err: (e) => new FetchError(e),
 * }).pipe(
 *   Fx.delay(500),
 * );
 * ```
 *
 * @see {@link timeout} — Fails if computation exceeds a duration.
 * @see {@link retry} — Policies handle inter-attempt delays internally.
 *
 * @category Combinator
 */
function delay(ms: number) {
  return <A, E>(self: Fx<A, E>): Fx<A, E> =>
    new FxImpl(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return self._run();
    });
}

/**
 * Fail with a {@link TimeoutError} if the computation takes longer than `ms`.
 *
 * @remarks
 * `timeout` races the upstream `Fx` against a timer using `Promise.race`.
 * If the timer fires first, the result is a `Failure` containing a
 * `TimeoutError`. If the computation completes first, its result is
 * returned as-is.
 *
 * **Note**: `timeout` does not cancel the underlying computation — the
 * `Promise` from `_run()` continues executing in the background. This is
 * a limitation of the JavaScript runtime. For cancellation, combine with
 * abort signals at the application level.
 *
 * Commonly paired with {@link retry} to retry timed-out operations.
 *
 * @param ms - The timeout duration in milliseconds.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<A, E | TimeoutError>`.
 *
 * @example
 * ```ts
 * // Timeout a query and retry with exponential backoff
 * const robust = Fx.from({
 *   ok: () => remoteClient.query(api.tasks.resolve, {}),
 *   err: (e) => e as Error,
 * }).pipe(
 *   Fx.timeout(5000),
 *   Fx.retry(Fx.retry.compose(
 *     Fx.retry.jittered(Fx.retry.exponential(100)),
 *     Fx.retry.recurs(3),
 *   )),
 * );
 * ```
 *
 * @see {@link TimeoutError} — The error type produced on timeout.
 * @see {@link delay} — Adds delay before computation (not a deadline).
 * @see {@link retry} — Retry failed/timed-out computations.
 *
 * @category Combinator
 */
function timeout(ms: number) {
  return <A, E>(self: Fx<A, E>): Fx<A, E | TimeoutError> =>
    FxImpl.of<A, E | TimeoutError>(() => {
      return Promise.race([
        self._run(),
        new Promise<Result<never, TimeoutError>>((resolve) =>
          setTimeout(() => resolve(err(new TimeoutError(ms))), ms),
        ),
      ]);
    });
}

/**
 * Retry a computation on failure according to a {@link RetryPolicy}.
 *
 * @remarks
 * `retry` re-executes the upstream `Fx`'s `_run()` method on each attempt. This
 * means the **same `Fx` instance** is re-run — if you need fresh state per attempt
 * (e.g. resetting read sets, checking abort signals), wrap the computation with
 * {@link defer} so a new `Fx` is constructed on each try.
 *
 * The retry loop works as follows:
 * 1. Execute `self._run()`.
 * 2. If success, return immediately.
 * 3. If failure, call `policy.next(attempt, error)`.
 * 4. If `next` returns `null`, stop retrying and return the failure.
 * 5. If `next` returns a delay (ms), wait that long and go to step 1.
 *
 * `retry` does **not** catch {@link FxFatal} defects — only typed errors
 * in the `E` channel trigger retries.
 *
 * **Attached namespace properties** for building retry policies:
 * - `retry.exponential(baseMs)` — Exponential backoff: `baseMs * 2^attempt`.
 * - `retry.jittered(policy)` — Add ±25% random jitter to delays.
 * - `retry.recurs(n)` — Limit to `n` retries (n+1 total attempts).
 * - `retry.compose(delay, limit)` — Take delay from first policy, stop when either returns null.
 * - `retry.while(policy, predicate)` — Continue retrying only while predicate returns true.
 *
 * @param policy - A {@link RetryPolicy} that determines delay between attempts
 *   and when to stop. Use the attached builder functions to construct policies.
 *
 * @returns A function that takes `Fx<A, E>` and returns `Fx<A, E>`.
 *
 * @example
 * ```ts
 * // OCC transaction with exponential backoff + jitter, max 5 retries
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(this._maxRetries),
 * );
 *
 * const attempt = Fx.defer(() => {
 *   this._readSet.clear();
 *   this._tablesRead.clear();
 *   this._db.startTransaction();
 *   return Fx.from({ ok: () => fn(), err: (e) => e }).pipe(
 *     Fx.chain((result) =>
 *       Fx.from({
 *         ok: () => { this._validateReadSet(); this._db.commit(); return result; },
 *         err: (e) => e,
 *       }),
 *     ),
 *     Fx.recover((err) => {
 *       this._db.rollbackWrites();
 *       return err instanceof OccConflictError ? Fx.fail(err) : Fx.fatal(err);
 *     }),
 *   );
 * });
 *
 * return Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
 * ```
 *
 * @example
 * ```ts
 * // Retry with abort-signal-aware predicate
 * const retrySchedule = Fx.retry.while(
 *   Fx.retry.compose(
 *     Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
 *     Fx.retry.recurs(maxRetries - 1),
 *   ),
 *   (meta) => {
 *     if (signal?.aborted) return false;
 *     const err = meta.input as Error;
 *     if (err instanceof DOMException && err.name === "AbortError") return false;
 *     return true;
 *   },
 * );
 *
 * await Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
 * ```
 *
 * @see {@link defer} — Critical companion for fresh state per retry attempt.
 * @see {@link timeout} — Often composed with retry for time-bounded attempts.
 * @see {@link RetryPolicy} — The policy interface.
 *
 * @category Combinator
 */
function _retry<E>(policy: RetryPolicy<E>) {
  return <A>(self: Fx<A, E>): Fx<A, E> =>
    new FxImpl(async () => {
      let attempt = 0;
      while (true) {
        const r = await self._run();
        if (r._tag === "Success") return r;
        const d = policy.next(attempt, r.error);
        if (d === null) return r;
        await new Promise<void>((resolve) => setTimeout(resolve, d));
        attempt++;
      }
    });
}

/**
 * `retry` is both a combinator and a namespace.
 *
 * - As a combinator: `Fx.retry(policy)` returns a function for `.pipe()`.
 * - As a namespace: `Fx.retry.exponential(100)`, `Fx.retry.jittered(...)`, etc.
 *
 * Merged via `Object.assign` to produce clean DTS output.
 */
const retry = Object.assign(_retry, {
  exponential: schedule.exponential,
  jittered: schedule.jittered,
  recurs: schedule.recurs,
  compose: schedule.compose,
  while: schedule.while_,
});

// ---------------------------------------------------------------------------
// Resource management
// ---------------------------------------------------------------------------

/**
 * Acquire a resource, use it, and guarantee release regardless of outcome.
 *
 * @remarks
 * `bracket` implements the acquire/use/release pattern (similar to RAII or
 * try-with-resources). The lifecycle is:
 *
 * 1. **Acquire**: Execute `acquire`. If it fails, stop — `release` is never called.
 * 2. **Use**: Execute `use(resource)`. The result (success or failure) is captured.
 * 3. **Release**: Execute `release(resource, exit)` **unconditionally** — even if
 *    `use` threw an {@link FxFatal} defect. The `exit` parameter carries the
 *    outcome of the `use` phase as an {@link Exit} value, allowing the release
 *    logic to distinguish success, typed error, and defect.
 *
 * Release errors are silently discarded (the `release` function returns
 * `Fx<void, never>`, so it cannot fail through the typed channel). If release
 * throws, the exception propagates as an unhandled defect.
 *
 * Use `bracket` when you have a resource (worker, connection, file handle)
 * that must be cleaned up even if the operation using it fails.
 *
 * @param acquire - An `Fx` that produces the resource. If this fails,
 *   `use` and `release` are skipped.
 * @param use - A function that receives the acquired resource and returns
 *   an `Fx` representing the operation to perform.
 * @param release - A function that receives the resource and the {@link Exit}
 *   from the `use` phase. Must return `Fx<void, never>`. Always called if
 *   `acquire` succeeded.
 *
 * @returns An `Fx<A, E>` that produces the result of `use`, with guaranteed cleanup.
 *
 * @example
 * ```ts
 * // Spawn a Worker, initialize wa-sqlite, terminate on failure
 * return Fx.run(
 *   Fx.bracket(
 *     // Acquire: spawn the Dedicated Worker
 *     Fx.sync(() => new Worker(workerUrl, { type: "module" })),
 *
 *     // Use: initialize wa-sqlite and build the StorageAdapter proxy
 *     (worker) =>
 *       Fx.from({
 *         ok: async () => {
 *           await rpc(worker, { method: "init", name, wasmModule });
 *           return buildAdapter(worker);
 *         },
 *         err: (err) =>
 *           new Error(`wa-sqlite worker init failed: ${
 *             err instanceof Error ? err.message : String(err)
 *           }`),
 *       }),
 *
 *     // Release: terminate the worker on failure only
 *     (worker, exit) => {
 *       if (exit._tag === "Failure") {
 *         worker.terminate();
 *       }
 *       return Fx.unit;
 *     },
 *   ),
 * );
 * ```
 *
 * @see {@link Exit} — The exit type received by `release`.
 * @see {@link FxFatal} — Defects that appear in Exit's error channel.
 *
 * @category Resource
 */
function bracket<R, A, E>(
  acquire: Fx<R, E>,
  use: (resource: R) => Fx<A, E>,
  release: (resource: R, exit: Exit<A, E>) => Fx<void, never>,
): Fx<A, E> {
  return FxImpl.of<A, E>(async () => {
    const acq = await acquire._run();
    if (acq._tag === "Failure") return acq;

    const resource = acq.value;
    let exit: Exit<A, E>;

    try {
      const result = await use(resource)._run();
      exit = result;
    } catch (e) {
      exit = { _tag: "Failure", error: e as E };
      await release(resource, exit)._run();
      throw e;
    }

    await release(resource, exit)._run();
    return exit;
  });
}

// ---------------------------------------------------------------------------
// Traversal & Parallel
// ---------------------------------------------------------------------------

/**
 * Run an effectful function over each item sequentially, collecting results.
 *
 * @remarks
 * `each` processes items one at a time, in order. If any invocation of `f`
 * fails, processing stops immediately (short-circuit) and the failure is
 * returned — remaining items are not processed.
 *
 * Use `each` when operations must be sequential (e.g. order-dependent writes)
 * or when you need to limit concurrency to one. For parallel execution, use
 * {@link all} instead.
 *
 * @param items - An iterable of input values to process.
 * @param f - A function that takes an item and returns an `Fx<B, E>`.
 *
 * @returns An `Fx<B[], E>` containing all success values in order, or the
 *   first failure encountered.
 *
 * @example
 * ```ts
 * // Re-evaluate all active queries sequentially, collecting state modifications
 * const modifications = await Fx.run(
 *   Fx.each(
 *     [...session.activeQueries.values()],
 *     (q) => evaluateQuery(q),
 *   ),
 * );
 * ```
 *
 * @see {@link all} — Parallel execution of pre-built Fx values.
 * @see {@link map} — Transform a single value (not a collection).
 *
 * @category Parallel
 */
function each<A, B, E>(items: Iterable<A>, f: (a: A) => Fx<B, E>): Fx<B[], E> {
  return new FxImpl(async () => {
    const results: B[] = [];
    for (const item of items) {
      const r = await f(item)._run();
      if (r._tag === "Failure") return r;
      results.push(r.value);
    }
    return ok(results);
  });
}

/**
 * Run multiple `Fx` computations in parallel, collecting all results.
 *
 * @remarks
 * `all` starts every computation immediately using `Promise.all`. All
 * computations run concurrently. If any computation fails, the first
 * failure encountered (in iteration order) is returned.
 *
 * **Note**: Unlike sequential short-circuiting, all computations are already
 * started before any result is inspected. `Promise.all` itself resolves
 * when all promises settle, but the result array is scanned left-to-right
 * and the first failure wins.
 *
 * @param fxs - An iterable of `Fx` computations to run in parallel.
 *
 * @returns An `Fx<A[], E>` containing all success values (in iteration order),
 *   or the first failure.
 *
 * @example
 * ```ts
 * // Fetch multiple resources in parallel
 * const results = await Fx.run(
 *   Fx.all([
 *     Fx.from({ ok: () => fetchUsers(), err: toError }),
 *     Fx.from({ ok: () => fetchPosts(), err: toError }),
 *     Fx.from({ ok: () => fetchComments(), err: toError }),
 *   ]),
 * );
 * // results: [users, posts, comments]
 * ```
 *
 * @see {@link each} — Sequential traversal with a mapping function.
 * @see {@link race} — Return the first computation to complete.
 * @see {@link zip} — Pair exactly two computations into a tuple.
 *
 * @category Parallel
 */
function all<A, E>(fxs: Iterable<Fx<A, E>>): Fx<A[], E> {
  return new FxImpl(async () => {
    const promises = Array.from(fxs, (fx) => fx._run());
    const settled = await Promise.all(promises);
    const results: A[] = [];
    for (const r of settled) {
      if (r._tag === "Failure") return r;
      results.push(r.value);
    }
    return ok(results);
  });
}

/**
 * Run multiple `Fx` computations, returning the first to complete.
 *
 * @remarks
 * `race` starts all computations concurrently and returns the result of
 * whichever finishes first (success or failure) via `Promise.race`. The
 * remaining computations continue executing in the background — they are
 * not cancelled.
 *
 * Use `race` for "first wins" patterns such as fetching from multiple
 * mirrors, racing a computation against a manual cancellation signal, or
 * implementing competitive parallelism.
 *
 * @param fxs - An iterable of `Fx` computations to race.
 *
 * @returns An `Fx<A, E>` producing the result of the first computation
 *   to complete.
 *
 * @example
 * ```ts
 * // Race two mirror fetches — first response wins
 * const result = await Fx.run(
 *   Fx.race([
 *     Fx.from({ ok: () => fetch(mirror1), err: toError }),
 *     Fx.from({ ok: () => fetch(mirror2), err: toError }),
 *   ]),
 * );
 * ```
 *
 * @see {@link all} — Wait for all computations to complete.
 * @see {@link timeout} — Race a computation against a timer.
 *
 * @category Parallel
 */
function race<A, E>(fxs: Iterable<Fx<A, E>>): Fx<A, E> {
  return new FxImpl(() => {
    const promises = Array.from(fxs, (fx) => fx._run());
    return Promise.race(promises);
  });
}

/**
 * Combine two `Fx` computations into a tuple `[A, B]`, running in parallel.
 *
 * @remarks
 * `zip` executes both computations concurrently via `Promise.all` and
 * pairs their success values into a tuple. If either computation fails,
 * the first failure (checking `a` before `b`) is returned.
 *
 * This is a convenience for the common case of running exactly two
 * independent computations in parallel. For more than two, use {@link all}.
 *
 * @param a - The first computation.
 * @param b - The second computation.
 *
 * @returns An `Fx<[A, B], EA | EB>` producing the paired success values.
 *
 * @example
 * ```ts
 * // Fetch a user and their settings in parallel
 * const [user, settings] = await Fx.run(
 *   Fx.zip(
 *     Fx.from({ ok: () => fetchUser(id), err: toError }),
 *     Fx.from({ ok: () => fetchSettings(id), err: toError }),
 *   ),
 * );
 * ```
 *
 * @see {@link all} — Parallel execution for any number of computations.
 * @see {@link each} — Sequential traversal with a mapping function.
 *
 * @category Parallel
 */
function zip<A, EA, B, EB>(a: Fx<A, EA>, b: Fx<B, EB>): Fx<[A, B], EA | EB> {
  return new FxImpl(async () => {
    const [ra, rb] = await Promise.all([a._run(), b._run()]);
    if (ra._tag === "Failure") return ra as Result<never, EA | EB>;
    if (rb._tag === "Failure") return rb as Result<never, EA | EB>;
    return ok([ra.value, rb.value] as [A, B]);
  });
}

// ---------------------------------------------------------------------------
// Control flow
// ---------------------------------------------------------------------------

/**
 * Gleam-inspired early return: if the condition is true, return the fallback;
 * otherwise continue with {@link unit}.
 *
 * @remarks
 * `guard` provides a concise way to express early-return logic in `Fx.gen`
 * generators or pipelines. When `condition` is `true`, the `fallback` Fx is
 * returned (typically an `Fx.fail(...)` to abort the pipeline). When
 * `condition` is `false`, `Fx.unit` is returned so the pipeline continues.
 *
 * This mirrors Gleam's `use <- guard(condition, fallback)` pattern, adapted
 * for TypeScript's `Fx.gen` syntax:
 *
 * ```ts
 * const pipeline = Fx.gen(function* () {
 *   yield* Fx.guard(items.length === 0, Fx.fail(new EmptyError()));
 *   // If we get here, items is non-empty
 *   return processItems(items);
 * });
 * ```
 *
 * @param condition - When `true`, the `fallback` Fx is returned.
 * @param fallback - The `Fx` to return when `condition` is `true`. Typically
 *   `Fx.fail(...)` for early exit.
 *
 * @returns `fallback` if `condition` is `true`, otherwise `Fx.unit`.
 *
 * @example
 * ```ts
 * // Guard against empty input in a generator
 * const pipeline = Fx.gen(function* () {
 *   yield* Fx.guard(items.length === 0, Fx.fail(new EmptyError()));
 *   const first = items[0]!;
 *   return yield* processItem(first);
 * });
 * ```
 *
 * @example
 * ```ts
 * // Guard with a successful fallback (return early with a default)
 * const pipeline = Fx.gen(function* () {
 *   yield* Fx.guard(useCache, Fx.succeed(cachedValue));
 *   return yield* expensiveComputation();
 * });
 * ```
 *
 * @see {@link fail} — Commonly used as the fallback for error guards.
 * @see {@link unit} — Returned when the condition is false.
 * @see {@link gen} — Generator runner where guard is most useful.
 *
 * @category Control Flow
 */
function guard<A, E>(condition: boolean, fallback: Fx<A, E>): Fx<A | void, E> {
  return condition ? fallback : (unit as Fx<void, never>);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a computation from a raw async function, folding both outcomes into
 * a single successful value.
 *
 * @remarks
 * `attempt` is a convenience combinator that combines {@link from} and
 * {@link fold} in a single call. It runs `fn`, then maps the result through
 * `onOk` on success or `onErr` on failure. The resulting `Fx` always succeeds
 * — it can never fail with a typed error (the error type is `never`).
 *
 * This is particularly useful for protocol handlers and dispatch logic where
 * you need to convert both success and failure into a uniform response type.
 *
 * @param fn - An async function to execute.
 * @param onOk - Maps the success value `A` to `B`.
 * @param onErr - Maps a caught exception (`unknown`) to `B`.
 *
 * @returns An `Fx<B, never>` that always succeeds with the mapped value.
 *
 * @example
 * ```ts
 * // Evaluate a query and produce either QueryUpdated or QueryFailed
 * const modification = Fx.attempt(
 *   () => this._executor.runQuery(q.udfPath, ...q.args),
 *   (value): StateModification => ({
 *     type: "QueryUpdated",
 *     queryId: q.queryId,
 *     value: value as JSONValue,
 *     logLines: [],
 *     journal: null,
 *   }),
 *   (err): StateModification => ({
 *     type: "QueryFailed",
 *     queryId: q.queryId,
 *     errorMessage: errorMessage(err),
 *     logLines: [errorMessage(err)],
 *     errorData: null,
 *     journal: null,
 *   }),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Fold a mutation into a protocol response
 * const mutationResponse = await Fx.run(
 *   Fx.attempt(
 *     () => executor.runMutation(message.udfPath, ...(message.args ?? [])),
 *     (result): ServerMessage => ({
 *       type: "MutationResponse",
 *       requestId: message.requestId,
 *       success: true,
 *       result: result ?? null,
 *       logLines: [],
 *     }),
 *     (err): ServerMessage => ({
 *       type: "MutationResponse",
 *       requestId: message.requestId,
 *       success: false,
 *       result: errorMessage(err),
 *       logLines: [],
 *     }),
 *   ),
 * );
 * ```
 *
 * @see {@link from} — When you need the error channel instead of folding.
 * @see {@link fold} — When you already have an Fx and want to collapse paths.
 *
 * @category Control Flow
 */
function attempt<A, B>(
  fn: () => Promise<A>,
  onOk: (a: A) => B,
  onErr: (e: unknown) => B,
): Fx<B, never> {
  return from({ ok: fn, err: (e) => e }).pipe(
    fold({ ok: onOk, err: onErr }),
  ) as Fx<B, never>;
}

// ---------------------------------------------------------------------------
// Generator runner
// ---------------------------------------------------------------------------

/**
 * Run a generator of `Fx` values sequentially, using `yield*` to unwrap each one.
 *
 * @remarks
 * `gen` provides an imperative-looking syntax for composing `Fx` computations.
 * Inside the generator, `yield* someFx` executes the `Fx` and returns the
 * success value. If any `yield*`-ed `Fx` fails, the generator is immediately
 * terminated and the failure is returned — subsequent `yield*` statements are
 * not reached.
 *
 * This is the `Fx` equivalent of `async`/`await` for Promises, but with typed
 * errors: the error type `E` is inferred from all `yield*`-ed `Fx` values.
 *
 * `gen` works via the `[Symbol.iterator]` protocol on `Fx`. Each `yield*`
 * yields the `Fx` to the runner, which executes it and resumes the generator
 * with the unwrapped value.
 *
 * Prefer `gen` over long `.pipe()` chains when the logic is sequential and
 * benefits from variable bindings and control flow (if/else, loops, etc.).
 *
 * @param f - A generator function that yields `Fx` values and returns the
 *   final result `A`.
 *
 * @returns An `Fx<A, E>` that, when executed, runs the generator to completion.
 *
 * @example
 * ```ts
 * // Sequential composition with variable bindings
 * const pipeline = Fx.gen(function* () {
 *   const user = yield* Fx.from({
 *     ok: () => fetchUser(id),
 *     err: (e) => new FetchError(e),
 *   });
 *
 *   yield* Fx.guard(user.banned, Fx.fail(new BannedError(user.id)));
 *
 *   const posts = yield* Fx.from({
 *     ok: () => fetchPosts(user.id),
 *     err: (e) => new FetchError(e),
 *   });
 *
 *   return { user, posts };
 * });
 * ```
 *
 * @see {@link chain} — Pipeline-style sequential chaining.
 * @see {@link guard} — Early return inside generators.
 * @see {@link run} — Execute the resulting Fx.
 *
 * @category Execution
 */
function gen<A, E>(f: () => Generator<Fx<unknown, E>, A, unknown>): Fx<A, E> {
  return new FxImpl(async () => {
    const iter = f();
    let next = iter.next();

    while (!next.done) {
      const fx = next.value as Fx<unknown, E>;
      const r = await fx._run();

      if (r._tag === "Failure") {
        const thrown = iter.return?.(undefined as never);
        void thrown;
        return r;
      }

      next = iter.next(r.value);
    }

    return ok(next.value);
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Execute an `Fx` computation and return a `Promise` of the success value.
 *
 * @remarks
 * `run` is the entry point from the `Fx` world back to the `Promise` world.
 * It executes the computation and:
 *
 * - **On success**: resolves with the value `A`.
 * - **On typed failure**: rejects (throws) the error `E`.
 * - **On {@link FxFatal}**: unwraps the `FxFatal` wrapper and re-throws the
 *   inner `defect`, so callers see the original error (e.g. `Error("bug")`)
 *   rather than the `FxFatal` wrapper.
 *
 * `run` should be called at the boundary of your program — typically once at
 * the top level. Inside `Fx` pipelines, use combinators ({@link chain},
 * {@link map}, {@link gen}) to sequence computations instead of calling `run`
 * in the middle.
 *
 * @param fx - The `Fx` computation to execute.
 *
 * @returns A `Promise<A>` that resolves with the success value.
 *
 * @throws The typed error `E` if the computation fails.
 * @throws The unwrapped defect if the computation throws {@link FxFatal}.
 *
 * @example
 * ```ts
 * // Execute an OCC transaction pipeline
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(this._maxRetries),
 * );
 * return Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
 * ```
 *
 * @example
 * ```ts
 * // Execute bracket for Worker lifecycle management
 * return Fx.run(
 *   Fx.bracket(
 *     Fx.sync(() => new Worker(workerUrl, { type: "module" })),
 *     (worker) => Fx.from({ ok: () => init(worker), err: toError }),
 *     (worker, exit) => {
 *       if (exit._tag === "Failure") worker.terminate();
 *       return Fx.unit;
 *     },
 *   ),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Execute and handle hydration with inspect + recover
 * this._hydrated = Fx.run(
 *   Fx.from({
 *     ok: () => this.db.hydrate(),
 *     err: (err) => err as Error,
 *   }).pipe(
 *     Fx.inspect((err) =>
 *       Fx.sync(() => console.error("[convex-embedded] hydration failed:", err)),
 *     ),
 *     Fx.recover(() => Fx.unit),
 *   ),
 * );
 * ```
 *
 * @see {@link gen} — Generator-based composition (avoids calling run mid-pipeline).
 * @see {@link FxFatal} — Defect type that run unwraps.
 *
 * @category Execution
 */
async function run<A, E>(fx: Fx<A, E>): Promise<A> {
  try {
    const r = await fx._run();
    if (r._tag === "Success") return r.value;
    throw r.error;
  } catch (e) {
    if (e instanceof FxFatal) throw e.defect;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Error class for timeout
// ---------------------------------------------------------------------------

/**
 * Error produced when an `Fx` computation exceeds the duration specified
 * by {@link timeout}.
 *
 * @remarks
 * `TimeoutError` is a standard `Error` subclass with a discriminant `_tag`
 * field for pattern matching and a `ms` property recording the timeout
 * duration that was exceeded.
 *
 * It appears in the error channel when using `Fx.timeout(ms)`:
 * ```ts
 * const fx: Fx<Data, AppError | TimeoutError> = fetchData.pipe(
 *   Fx.timeout(5000),
 * );
 * ```
 *
 * You can match on `_tag` or use `instanceof` to distinguish timeout errors
 * from other failure types in {@link recover} or {@link inspect}.
 *
 * @see {@link timeout} — The combinator that produces this error.
 *
 * @category Helper
 */
export class TimeoutError extends Error {
  readonly _tag = "TimeoutError" as const;
  constructor(readonly ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Standalone pipe
// ---------------------------------------------------------------------------

/**
 * Left-to-right function composition for non-Fx values.
 *
 * @remarks
 * Takes an initial value and up to five transformation functions, applying them
 * sequentially from left to right. Each function receives the return value of
 * the previous one, producing a fully type-safe transformation pipeline.
 *
 * `pipe` is a **general-purpose** data transformation utility. It is **not**
 * intended for composing `Fx` effects — use the `fx.pipe()` instance method
 * for that.
 *
 * @param a - The initial value to transform.
 * @returns The result of applying all transformation functions left to right.
 *
 * @example
 * ```ts
 * import { Fx } from "@robelest/fx";
 *
 * const result = Fx.pipe(
 *   "  Hello, World!  ",
 *   (s) => s.trim(),
 *   (s) => s.toLowerCase(),
 * );
 * // result: "hello, world!"
 * ```
 *
 * @category Helper
 */
function pipe<A>(a: A): A;
function pipe<A, B>(a: A, ab: (a: A) => B): B;
function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
function pipe<A, B, C, D>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
): D;
function pipe<A, B, C, D, E>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
): E;
function pipe<A, B, C, D, E, F>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
): F;
function pipe(
  a: unknown,
  ...fns: Array<(x: unknown) => unknown>
): unknown {
  let result = a;
  for (const fn of fns) result = fn(result);
  return result;
}

// ---------------------------------------------------------------------------
// Fire-and-forget
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget an async function, logging any errors instead of rejecting.
 *
 * @remarks
 * `detach` executes `fn()` immediately, catches any thrown or rejected error,
 * and logs it via `console.error(label, err)`. It returns `void` synchronously
 * — the caller never awaits the result and never sees the error.
 *
 * Use `detach` for background tasks where the caller does not need the result
 * and must not be blocked by the outcome. It prevents unhandled promise
 * rejections by unconditionally catching all errors and routing them to
 * `console.error`.
 *
 * The `label` string is prepended to every error log, making it easy to
 * identify which fire-and-forget call failed when scanning logs.
 *
 * Common use cases include cache invalidation, background persistence,
 * fire-and-forget notifications, deferred scheduling, and graceful cleanup
 * during shutdown.
 *
 * @param fn - A zero-argument async function to execute. Its return value is
 *   discarded; only errors are observed (and logged).
 * @param label - A descriptive string prepended to `console.error` when `fn`
 *   rejects. Use it to identify the call site.
 * @returns `void` — returns synchronously before `fn` settles.
 *
 * @example
 * ```ts
 * import { Fx } from "@robelest/fx";
 *
 * // Background persistence after an in-memory commit
 * if (storage !== null && (puts.length > 0 || deletes.length > 0)) {
 *   Fx.detach(
 *     () => storage.commit({ puts, deletes, meta }),
 *     "[convex-embedded] storage commit failed:",
 *   );
 * }
 * ```
 *
 * @example
 * ```ts
 * import { Fx } from "@robelest/fx";
 *
 * // Fire-and-forget a remote mutation push
 * Fx.detach(
 *   () => Fx.run(
 *     Fx.from({
 *       ok: () => remoteClient.mutation(ref, args),
 *       err: (e) => e as Error,
 *     }).pipe(
 *       Fx.recover(() => Fx.unit),
 *     ),
 *   ),
 *   "[monitor] pushToRemote:",
 * );
 * ```
 *
 * @see {@link from} — For wrapping async operations with typed error tracking.
 * @see {@link inspect} — For composable error observation within the Fx pipeline.
 * @see {@link run} — Execute an Fx and return a Promise (use inside detach's fn).
 *
 * @category Execution
 */
function detach(fn: () => Promise<unknown>, label: string): void {
  fn().catch((err) => {
    console.error(label, err);
  });
}

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

/**
 * The public API surface of `@robelest/fx` — a minimal, zero-dependency
 * functional effect system for TypeScript with Gleam-inspired naming.
 *
 * @remarks
 * All functions are accessed through this namespace object (e.g.
 * `Fx.succeed()`, `Fx.map()`, `Fx.run()`). The namespace groups functions
 * by purpose:
 *
 * **Constructors** — Create `Fx` values:
 * - {@link succeed} — Wrap a plain value.
 * - {@link sync} — Wrap a synchronous thunk.
 * - {@link promise} — Wrap an infallible Promise thunk.
 * - {@link from} — Wrap a fallible sync/async operation with error mapping.
 * - {@link fail} — Immediate typed failure.
 * - {@link fatal} — Unrecoverable defect.
 * - {@link defer} — Lazy Fx construction (critical for retry).
 * - {@link unit} — `Fx<void, never>` no-op.
 *
 * **Combinators** — Transform and compose (data-last for `.pipe()`):
 * - {@link map} — Transform success value.
 * - {@link chain} — FlatMap/chain.
 * - {@link tap} — Side-effect on success.
 * - {@link inspect} — Side-effect on failure.
 * - {@link recover} — Catch typed errors.
 * - {@link fold} — Collapse both paths.
 * - {@link retry} — Re-run on failure per policy (also has `.exponential`, `.jittered`, `.recurs`, `.compose`, `.while`).
 * - {@link timeout} — Race against a timer.
 * - {@link delay} — Pause before execution.
 *
 * **Resource management**:
 * - {@link bracket} — Acquire/use/release with guaranteed cleanup.
 *
 * **Traversal and parallel**:
 * - {@link each} — Sequential traversal.
 * - {@link all} — Parallel via Promise.all.
 * - {@link race} — First to complete wins.
 * - {@link zip} — Pair two Fx into a tuple.
 *
 * **Control flow**:
 * - {@link guard} — Gleam-inspired early return.
 * - {@link attempt} — Run async fn, fold both outcomes.
 *
 * **Execution**:
 * - {@link gen} — Generator runner with `yield*`.
 * - {@link run} — Execute and return a Promise.
 * - {@link detach} — Fire-and-forget an async function.
 *
 * **Utilities**:
 * - {@link pipe} — Left-to-right function composition for plain values.
 *
 * @example
 * ```ts
 * import { Fx } from "@robelest/fx";
 *
 * const pipeline = Fx.from({
 *   ok: () => fetch("/api/data").then(r => r.json()),
 *   err: (e) => new FetchError(e),
 * }).pipe(
 *   Fx.map(data => data.items),
 *   Fx.timeout(5000),
 *   Fx.retry(Fx.retry.compose(
 *     Fx.retry.jittered(Fx.retry.exponential(100)),
 *     Fx.retry.recurs(3),
 *   )),
 * );
 *
 * const items = await Fx.run(pipeline);
 * ```
 */
export const Fx = {
  // Constructors
  succeed,
  sync,
  promise,
  from,
  fail,
  fatal,
  defer,
  unit,

  // Combinators
  map,
  chain,
  tap,
  inspect,
  recover,
  fold,
  retry,
  timeout,
  delay,

  // Resource
  bracket,

  // Traversal & Parallel
  each,
  all,
  race,
  zip,

  // Control flow
  guard,

  // Helpers
  attempt,

  // Generator
  gen,

  // Execution
  run,

  // Utilities
  pipe,
  detach,
} as const;
