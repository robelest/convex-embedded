import type { Fx, Result, Exit } from "./types.js";
import { FxFatal } from "./types.js";
import type { RetryPolicy } from "./schedule.js";
import * as schedule from "./schedule.js";

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

class FxImpl<A, E = never> implements Fx<A, E> {
  constructor(readonly _run: () => Promise<Result<A, E>>) {}

  pipe(...fns: Array<(x: unknown) => unknown>): unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let result: unknown = this;
    for (const fn of fns) result = fn(result);
    return result;
  }

  *[Symbol.iterator](): Generator<Fx<A, E>, A, A> {
    return yield this;
  }
}

function ok<A>(value: A): Result<A, never> {
  return { _tag: "Success", value };
}

function err<E>(error: E): Result<never, E> {
  return { _tag: "Failure", error };
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Wrap a plain value into a successful computation. */
function succeed<A>(value: A): Fx<A, never> {
  return new FxImpl(async () => ok(value));
}

/** Wrap a synchronous computation. */
function sync<A>(f: () => A): Fx<A, never> {
  return new FxImpl(async () => ok(f()));
}

/** Wrap a Promise that cannot fail (only use when failure is impossible). */
function promise<A>(f: () => Promise<A>): Fx<A, never> {
  return new FxImpl(async () => ok(await f()));
}

/**
 * Lift a sync or async function that can throw into an Fx with error mapping.
 * The `ok` callback returns `A | Promise<A>`. If it returns a Promise, it is awaited.
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

/** Create an immediately-failed computation. */
function fail<E>(error: E): Fx<never, E> {
  return new FxImpl(async () => err(error));
}

/** Throw an unrecoverable defect (not catchable by `recover`). */
function fatal(defect: unknown): Fx<never, never> {
  return new FxImpl(async () => {
    throw new FxFatal(defect);
  });
}

/** Defer computation construction until execution time. */
function defer<A, E>(f: () => Fx<A, E>): Fx<A, E> {
  return new FxImpl(() => f()._run());
}

/** A computation that succeeds with `undefined`. */
const unit: Fx<void, never> = sync(() => undefined);

// ---------------------------------------------------------------------------
// Combinators (data-last, for `.pipe()`)
// ---------------------------------------------------------------------------

/** Transform the success value. */
function map<A, B>(f: (a: A) => B) {
  return <E>(self: Fx<A, E>): Fx<B, E> =>
    new FxImpl(async () => {
      const r = await self._run();
      return r._tag === "Success" ? ok(f(r.value)) : r;
    });
}

/** Chain a computation from the success value. */
function then<A, B, E2>(f: (a: A) => Fx<B, E2>) {
  return <E>(self: Fx<A, E>): Fx<B, E | E2> =>
    new FxImpl(async () => {
      const r = await self._run();
      if (r._tag === "Failure") return r;
      return f(r.value)._run();
    });
}

/** Run a side-effecting computation on success, passing through the value. */
function tap<A, E2>(f: (a: A) => Fx<unknown, E2>) {
  return <E>(self: Fx<A, E>): Fx<A, E | E2> =>
    new FxImpl(async () => {
      const r = await self._run();
      if (r._tag === "Failure") return r;
      const r2 = await f(r.value)._run();
      if (r2._tag === "Failure") return r2;
      return r;
    });
}

/** Run a side-effecting computation on failure, passing through the error. */
function inspect<E, E2>(f: (e: E) => Fx<unknown, E2>) {
  return <A>(self: Fx<A, E>): Fx<A, E | E2> =>
    new FxImpl(async () => {
      const r = await self._run();
      if (r._tag === "Success") return r;
      const r2 = await f(r.error)._run();
      if (r2._tag === "Failure") return r2;
      return r;
    });
}

/** Recover from all errors by mapping to a new computation. */
function recover<E, B, E2>(f: (e: E) => Fx<B, E2>) {
  return <A>(self: Fx<A, E>): Fx<A | B, E2> =>
    new FxImpl(async () => {
      const r = await self._run();
      if (r._tag === "Success") return r;
      return f(r.error)._run();
    });
}

/**
 * Fold success and failure into a single value.
 * `{ ok, err }` — collapse both paths into a single successful result.
 */
function fold<A, E, B>(opts: { ok: (a: A) => B; err: (e: E) => B }) {
  return (self: Fx<A, E>): Fx<B, never> =>
    new FxImpl(async () => {
      const r = await self._run();
      return r._tag === "Success" ? ok(opts.ok(r.value)) : ok(opts.err(r.error));
    });
}

/** Add a delay (in ms) before running the computation. */
function delay(ms: number) {
  return <A, E>(self: Fx<A, E>): Fx<A, E> =>
    new FxImpl(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return self._run();
    });
}

/** Fail with a TimeoutError if the computation takes longer than `ms`. */
function timeout(ms: number) {
  return <A, E>(self: Fx<A, E>): Fx<A, E | TimeoutError> =>
    new FxImpl(() => {
      return Promise.race([
        self._run(),
        new Promise<Result<never, TimeoutError>>((resolve) =>
          setTimeout(() => resolve(err(new TimeoutError(ms))), ms),
        ),
      ]);
    });
}

/** Retry a computation according to a retry policy. */
function retry<E>(policy: RetryPolicy<E>) {
  return <A>(self: Fx<A, E>): Fx<A, E> =>
    new FxImpl(async () => {
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
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

// Attach schedule builders as properties on the retry function
retry.exponential = schedule.exponential;
retry.jittered = schedule.jittered;
retry.recurs = schedule.recurs;
retry.compose = schedule.compose;
retry.while = schedule.while_;

// ---------------------------------------------------------------------------
// Resource management
// ---------------------------------------------------------------------------

/**
 * Acquire a resource, use it, and release it.
 * Release receives the Exit so it can distinguish success from failure.
 */
function bracket<R, A, E>(
  acquire: Fx<R, E>,
  use: (resource: R) => Fx<A, E>,
  release: (resource: R, exit: Exit<A, E>) => Fx<void, never>,
): Fx<A, E> {
  return new FxImpl(async () => {
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

/** Run an effectful function over each item sequentially, collecting results. */
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

/** Run multiple Fx computations in parallel, collecting all results. */
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

/** Run multiple Fx computations, return the first to complete. */
function race<A, E>(fxs: Iterable<Fx<A, E>>): Fx<A, E> {
  return new FxImpl(() => {
    const promises = Array.from(fxs, (fx) => fx._run());
    return Promise.race(promises);
  });
}

/** Combine two Fx computations into a tuple, running in parallel. */
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
 * Early return if condition is true.
 * Gleam-inspired guard: `Fx.guard(isEmpty, Fx.fail(new EmptyError()))`.
 * If `condition` is true, returns `fallback`. Otherwise continues with `Fx.unit`.
 */
function guard<A, E>(condition: boolean, fallback: Fx<A, E>): Fx<A | void, E> {
  return condition ? fallback : (unit as Fx<void, never>);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a raw async function, run it, fold both outcomes into a single value.
 * Always succeeds — errors are mapped through `onErr`.
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
 * Run a generator of `Fx` values sequentially.
 * Inside: `const x = yield* someFx;`
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
 * Execute an Fx computation, returning a Promise.
 * Throws on failure (mirroring Effect.runPromise semantics).
 * Unwraps FxFatal so callers see the original defect, not the wrapper.
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

/** Error thrown when an Fx computation exceeds the specified timeout. */
export class TimeoutError extends Error {
  readonly _tag = "TimeoutError" as const;
  constructor(readonly ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

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
  then,
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
} as const;
