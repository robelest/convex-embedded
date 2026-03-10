# @robelest/fx

Minimal, zero-dependency functional effect system for TypeScript with
Gleam-inspired naming.

## Overview

- **Core type**: `Fx<A, E>` — a lazy computation producing success value `A` or
  typed error `E`. Nothing runs until `Fx.run()`.
- **Typed errors**: Recoverable errors (`Fx.fail`) tracked in the type system,
  separate from unrecoverable defects (`Fx.fatal`).
- **Zero dependencies**, under 10 KB.
- **Gleam-inspired one-word names**: `map`, `then`, `tap`, `inspect`, `recover`,
  `fold`. Everything lives under the `Fx.*` namespace.
- **Two composition styles**: `.pipe()` chaining with data-last combinators, or
  `Fx.gen` generators for imperative-looking sequential code.

## Install

```sh
bun add @robelest/fx
```

## Core Concepts

### Fx\<A, E\> — lazy computation

`Fx<A, E>` is a description of a computation, not its result. The same `Fx` can
be run multiple times, producing fresh results each time.

```ts
const fx = Fx.from({
  ok: () => fetch("/api/data").then((r) => r.json()),
  err: (e) => new FetchError(e),
});
// Nothing has happened yet. Run it:
const data = await Fx.run(fx);
```

### Result\<A, E\> — outcome of a computation

Discriminated union returned by the internal `_run()` method.

```ts
type Result<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E };
```

### Exit\<A, E\> — Result + FxFatal

Extends `Result` by widening the error channel to include `FxFatal`. Used by
`Fx.bracket`'s `release` callback to distinguish typed errors from unrecoverable
defects.

```ts
type Exit<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E | FxFatal };
```

### Typed errors vs defects

- `Fx.fail(error)` — creates a recoverable typed error. Caught by `Fx.recover`,
  `Fx.fold`, `Fx.inspect`.
- `Fx.fatal(defect)` — creates an unrecoverable defect. Bypasses all error
  combinators. `Fx.run` unwraps the `FxFatal` wrapper and re-throws the original
  value.

```ts
// Typed error — recoverable
Fx.fail(new ValidationError("bad input")).pipe(
  Fx.recover(() => Fx.succeed(defaultValue)),
);

// Defect — not recoverable
Fx.fatal(new Error("invariant violated"));
// recover is bypassed, Fx.run throws the original Error
```

### Data-last combinators

All combinators return functions suitable for `.pipe()`:

```ts
Fx.map(fn); // returns (fx: Fx<A, E>) => Fx<B, E>
Fx.then(fn); // returns (fx: Fx<A, E>) => Fx<B, E | E2>
Fx.recover(fn); // returns (fx: Fx<A, E>) => Fx<A | B, E2>
```

### Generator composition

`Fx.gen` accepts a generator function where each `yield*` unwraps an `Fx`,
short-circuiting on the first failure.

```ts
const pipeline = Fx.gen(function* () {
  const user = yield* fetchUserFx(id);
  const posts = yield* fetchPostsFx(user.id);
  return { user, posts };
});
```

## API Reference

### Types

#### `Fx<A, E = never>`

```ts
interface Fx<A, E = never> {
  readonly _run: () => Promise<Result<A, E>>;
  pipe<B>(ab: (self: Fx<A, E>) => B): B;
  pipe<B, C>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C): C;
  pipe<B, C, D>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  pipe<B, C, D, F>(
    ab: (self: Fx<A, E>) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => F,
  ): F;
  [Symbol.iterator](): Generator<Fx<A, E>, A, A>;
}
```

Lazy computation producing `A` or failing with `E`. Supports `.pipe()` for
combinator chaining and `yield*` inside `Fx.gen` blocks. `E` defaults to `never`
(infallible).

#### `Result<A, E>`

```ts
type Result<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E };
```

Discriminated union representing the outcome of an `Fx` computation.
Pattern-match on `_tag`.

#### `Exit<A, E>`

```ts
type Exit<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E | FxFatal };
```

Like `Result` but the error channel includes `FxFatal`. Used by `Fx.bracket`'s
release callback.

#### `FxFatal`

```ts
class FxFatal {
  readonly _tag = "Fatal";
  constructor(readonly defect: unknown);
}
```

Marker wrapper for unrecoverable defects. Created by `Fx.fatal`, unwrapped by
`Fx.run`. Not caught by `Fx.recover`, `Fx.fold`, or `Fx.inspect`.

#### `RetryPolicy<E>`

```ts
interface RetryPolicy<E = unknown> {
  next(attempt: number, error: E): number | null;
}
```

Determines retry behavior. `next()` returns the delay in ms before the next
attempt, or `null` to stop retrying. `attempt` is zero-indexed.

#### `TimeoutError`

```ts
class TimeoutError extends Error {
  readonly _tag = "TimeoutError";
  constructor(readonly ms: number);
}
```

Error produced by `Fx.timeout` when the computation exceeds the specified
duration.

### Constructors

#### `Fx.succeed(value)`

```ts
function succeed<A>(value: A): Fx<A, never>;
```

Wrap a plain value into a successful computation. Use for constants or
already-computed values.

```ts
const fx = Fx.succeed(42);
```

#### `Fx.sync(fn)`

```ts
function sync<A>(f: () => A): Fx<A, never>;
```

Wrap a synchronous thunk. The function is called on each `Fx.run`. Use for side
effects like logging.

```ts
Fx.sync(() => console.log("executed"));
```

#### `Fx.promise(fn)`

```ts
function promise<A>(f: () => Promise<A>): Fx<A, never>;
```

Wrap a Promise-returning function that cannot fail. If the promise can reject,
use `Fx.from` instead.

```ts
const fx = Fx.promise(() => readFile("config.json"));
```

#### `Fx.from({ ok, err })`

```ts
function from<A, E>(opts: {
  ok: () => A | Promise<A>;
  err: (error: unknown) => E;
}): Fx<A, E>;
```

The primary constructor for fallible operations. `ok` runs the operation; if it
throws, the caught value is passed to `err` for mapping into a typed error.

```ts
const fetchUser = Fx.from({
  ok: () => fetch("/api/user").then((r) => r.json()),
  err: (e) => new FetchError(e),
});
```

#### `Fx.fail(error)`

```ts
function fail<E>(error: E): Fx<never, E>;
```

Create an immediately-failed computation with a typed error.

```ts
const fx = Fx.fail(new ValidationError("missing field"));
```

#### `Fx.fatal(defect)`

```ts
function fatal(defect: unknown): Fx<never, never>;
```

Throw an unrecoverable defect. Bypasses `recover`, `fold`, and `inspect`.
`Fx.run` unwraps the `FxFatal` wrapper and re-throws the original value.

```ts
const fx = Fx.fatal(new Error("invariant violated"));
```

#### `Fx.defer(fn)`

```ts
function defer<A, E>(f: () => Fx<A, E>): Fx<A, E>;
```

Defer construction of an `Fx` until execution time. Useful when the `Fx` to run
depends on runtime state that changes between runs (e.g., inside a retry loop).

```ts
const attempt = Fx.defer(() => {
  resetState();
  return Fx.from({ ok: () => tryOperation(), err: (e) => e });
});
```

#### `Fx.unit`

```ts
const unit: Fx<void, never>;
```

A computation that succeeds with `undefined`. Use as a no-op return value.

```ts
Fx.bracket(acquire, use, (resource, exit) => {
  if (exit._tag === "Failure") resource.close();
  return Fx.unit;
});
```

### Combinators

All combinators are data-last functions returning `(fx: Fx) => Fx`, designed for
`.pipe()`.

#### `Fx.map(fn)`

```ts
function map<A, B>(f: (a: A) => B): <E>(self: Fx<A, E>) => Fx<B, E>;
```

Transform the success value. Does not run on failure.

```ts
Fx.succeed(21).pipe(Fx.map((x) => x * 2)); // Fx<number, never> → 42
```

#### `Fx.then(fn)`

```ts
function then<A, B, E2>(
  f: (a: A) => Fx<B, E2>,
): <E>(self: Fx<A, E>) => Fx<B, E | E2>;
```

Chain to another `Fx` from the success value. The returned `Fx`'s error type is
the union of both. Short-circuits on failure of the original.

```ts
Fx.succeed(userId).pipe(
  Fx.then((id) =>
    Fx.from({
      ok: () => fetchUser(id),
      err: (e) => new FetchError(e),
    }),
  ),
);
```

#### `Fx.tap(fn)`

```ts
function tap<A, E2>(
  f: (a: A) => Fx<unknown, E2>,
): <E>(self: Fx<A, E>) => Fx<A, E | E2>;
```

Run a side-effecting computation on success, passing through the original value.
If the side-effect fails, the entire computation fails.

```ts
Fx.succeed(result).pipe(Fx.tap((r) => Fx.sync(() => console.log("Got:", r))));
```

#### `Fx.inspect(fn)`

```ts
function inspect<E, E2>(
  f: (e: E) => Fx<unknown, E2>,
): <A>(self: Fx<A, E>) => Fx<A, E | E2>;
```

Run a side-effecting computation on failure, passing through the original error.
The mirror of `tap` — observes errors without recovering from them.

```ts
fetchFx.pipe(Fx.inspect((err) => Fx.sync(() => log.warn("fetch failed", err))));
```

#### `Fx.recover(fn)`

```ts
function recover<E, B, E2>(
  f: (e: E) => Fx<B, E2>,
): <A>(self: Fx<A, E>) => Fx<A | B, E2>;
```

Recover from all typed errors by mapping to a new computation. Does not catch
`FxFatal`.

```ts
fetchFx.pipe(Fx.recover(() => Fx.succeed(fallbackData)));
```

#### `Fx.fold({ ok, err })`

```ts
function fold<A, E, B>(opts: {
  ok: (a: A) => B;
  err: (e: E) => B;
}): (self: Fx<A, E>) => Fx<B, never>;
```

Collapse both success and failure paths into a single successful result. The
returned `Fx` never fails (with typed errors). Does not catch `FxFatal`.

```ts
fetchFx.pipe(
  Fx.fold({
    ok: (data) => ({ status: "ok", data }),
    err: (e) => ({ status: "error", message: e.message }),
  }),
);
```

#### `Fx.retry(policy)`

```ts
function retry<E>(policy: RetryPolicy<E>): <A>(self: Fx<A, E>) => Fx<A, E>;
```

Retry a computation according to a retry policy. On each attempt, `_run()` is
called again (the computation re-executes from scratch). Stops when the policy
returns `null` or the computation succeeds.

```ts
fetchFx.pipe(
  Fx.retry(
    Fx.retry.compose(
      Fx.retry.jittered(Fx.retry.exponential(100)),
      Fx.retry.recurs(3),
    ),
  ),
);
```

#### `Fx.timeout(ms)`

```ts
function timeout(ms: number): <A, E>(self: Fx<A, E>) => Fx<A, E | TimeoutError>;
```

Fail with `TimeoutError` if the computation takes longer than `ms` milliseconds.
Uses `Promise.race` internally.

```ts
fetchFx.pipe(Fx.timeout(5000));
```

#### `Fx.delay(ms)`

```ts
function delay(ms: number): <A, E>(self: Fx<A, E>) => Fx<A, E>;
```

Add a delay (in ms) before running the computation.

```ts
Fx.succeed("delayed").pipe(Fx.delay(1000));
```

### Retry Policies

Retry policies are composable objects passed to `Fx.retry()`. Access them via
`Fx.retry.*`.

#### `Fx.retry.exponential(baseMs)`

```ts
function exponential(baseMs: number): RetryPolicy;
```

Exponential backoff: delay = `baseMs * 2^attempt`. No jitter, no attempt limit.

```ts
Fx.retry.exponential(100);
// attempt 0: 100ms, 1: 200ms, 2: 400ms, 3: 800ms, ...
```

#### `Fx.retry.jittered(policy)`

```ts
function jittered<E>(policy: RetryPolicy<E>): RetryPolicy<E>;
```

Wrap a policy to add +/-25% random jitter to each delay. Prevents thundering
herd.

```ts
Fx.retry.jittered(Fx.retry.exponential(100));
// attempt 0: 75-125ms, 1: 150-250ms, 2: 300-500ms, ...
```

#### `Fx.retry.recurs(n)`

```ts
function recurs(maxRetries: number): RetryPolicy;
```

Limit to `n` retries (`n + 1` total attempts). Delay is 0 (immediate retry).
Compose with a delay policy via `Fx.retry.compose`.

```ts
Fx.retry.recurs(3); // at most 3 retries, 4 total attempts
```

#### `Fx.retry.compose(delay, limit)`

```ts
function compose<E>(
  delay: RetryPolicy<E>,
  limit: RetryPolicy<E>,
): RetryPolicy<E>;
```

Compose two policies: takes the delay from the first, but stops when either
returns `null`.

```ts
// Exponential backoff with jitter, limited to 5 retries
Fx.retry.compose(
  Fx.retry.jittered(Fx.retry.exponential(50)),
  Fx.retry.recurs(5),
);
```

#### `Fx.retry.while(policy, predicate)`

```ts
function while_<E>(
  policy: RetryPolicy<E>,
  predicate: (meta: { attempt: number; input: E }) => boolean,
): RetryPolicy<E>;
```

Continue retrying only while the predicate returns `true`. The predicate
receives `{ attempt, input }` where `input` is the error. Accessed as
`Fx.retry.while`.

```ts
Fx.retry.while(
  Fx.retry.compose(
    Fx.retry.jittered(Fx.retry.exponential(1000)),
    Fx.retry.recurs(2),
  ),
  (meta) => {
    if (meta.input instanceof DOMException && meta.input.name === "AbortError")
      return false;
    return true;
  },
);
```

### Parallel & Traversal

#### `Fx.all(fxs)`

```ts
function all<A, E>(fxs: Iterable<Fx<A, E>>): Fx<A[], E>;
```

Run multiple `Fx` computations in parallel via `Promise.all`. Collects all
results; short-circuits on the first failure.

```ts
const results = await Fx.run(Fx.all([fxA, fxB, fxC]));
```

#### `Fx.race(fxs)`

```ts
function race<A, E>(fxs: Iterable<Fx<A, E>>): Fx<A, E>;
```

Run multiple `Fx` computations, return the result of the first to complete
(success or failure).

```ts
const fastest = await Fx.run(Fx.race([primaryFx, fallbackFx]));
```

#### `Fx.zip(a, b)`

```ts
function zip<A, EA, B, EB>(a: Fx<A, EA>, b: Fx<B, EB>): Fx<[A, B], EA | EB>;
```

Combine two `Fx` computations into a tuple, running in parallel.

```ts
const [user, posts] = await Fx.run(Fx.zip(userFx, postsFx));
```

#### `Fx.each(items, fn)`

```ts
function each<A, B, E>(items: Iterable<A>, fn: (a: A) => Fx<B, E>): Fx<B[], E>;
```

Run an effectful function over each item **sequentially**, collecting results.
Short-circuits on the first failure.

```ts
const results = await Fx.run(
  Fx.each(userIds, (id) =>
    Fx.from({
      ok: () => fetchUser(id),
      err: (e) => new FetchError(e),
    }),
  ),
);
```

### Resources

#### `Fx.bracket(acquire, use, release)`

```ts
function bracket<R, A, E>(
  acquire: Fx<R, E>,
  use: (resource: R) => Fx<A, E>,
  release: (resource: R, exit: Exit<A, E>) => Fx<void, never>,
): Fx<A, E>;
```

Acquire a resource, use it, and guarantee release regardless of success or
failure. The `release` callback receives the `Exit` so it can distinguish
success from failure (including `FxFatal`). `release` must return
`Fx<void, never>` (it cannot fail with a typed error).

```ts
Fx.bracket(
  Fx.sync(() => new Worker(workerUrl, { type: "module" })),
  (worker) =>
    Fx.from({
      ok: async () => {
        await initWorker(worker);
        return buildAdapter(worker);
      },
      err: (e) => new Error(`init failed: ${e}`),
    }),
  (worker, exit) => {
    if (exit._tag === "Failure") worker.terminate();
    return Fx.unit;
  },
);
```

### Control Flow

#### `Fx.guard(condition, fallback)`

```ts
function guard<A, E>(condition: boolean, fallback: Fx<A, E>): Fx<A | void, E>;
```

Early return if `condition` is true. Returns `fallback` when true, `Fx.unit`
when false.

```ts
const fx = Fx.gen(function* () {
  yield* Fx.guard(items.length === 0, Fx.fail(new EmptyError()));
  return processItems(items);
});
```

#### `Fx.attempt(fn, onOk, onErr)`

```ts
function attempt<A, B>(
  fn: () => Promise<A>,
  onOk: (a: A) => B,
  onErr: (e: unknown) => B,
): Fx<B, never>;
```

Wrap a raw async function, run it, fold both outcomes into a single value.
Always succeeds — errors are mapped through `onErr`. Equivalent to
`Fx.from({ ok: fn, err: e => e }).pipe(Fx.fold({ ok: onOk, err: onErr }))`.

```ts
const response = Fx.attempt(
  () => executor.runMutation(path, args),
  (result) => ({ success: true, result }),
  (err) => ({ success: false, error: String(err) }),
);
```

### Execution

#### `Fx.gen(fn)`

```ts
function gen<A, E>(f: () => Generator<Fx<unknown, E>, A, unknown>): Fx<A, E>;
```

Generator-based sequential composition. Inside the generator, `yield*` unwraps
an `Fx` value. If any yielded `Fx` fails, the generator short-circuits and the
entire `Fx.gen` fails with that error.

```ts
const pipeline = Fx.gen(function* () {
  const user = yield* fetchUserFx(id);
  const posts = yield* fetchPostsFx(user.id);
  return { user, posts };
});
```

#### `Fx.run(fx)`

```ts
async function run<A, E>(fx: Fx<A, E>): Promise<A>;
```

Execute an `Fx` computation and return a `Promise<A>`. On success, resolves with
the value. On typed error failure, the promise rejects with the error. `FxFatal`
is unwrapped — the promise rejects with the original defect, not the wrapper.

```ts
const name = await Fx.run(getNameFx);
```

### Standalone Utilities

#### `pipe(value, ...fns)`

```ts
function pipe<A>(a: A): A;
function pipe<A, B>(a: A, ab: (a: A) => B): B;
function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
// ... up to 5 functions
```

General-purpose pipe for non-`Fx` values. Applies functions left-to-right. Use
when you need to compose transformations on plain values outside an `Fx`
pipeline.

```ts
import { pipe } from "@robelest/fx";

const result = pipe(rawData, parseInput, validate, transform);
```

#### `detach(fn, label)`

```ts
function detach(fn: () => Promise<unknown>, label: string): void;
```

Fire-and-forget an async function. Executes `fn()` immediately and swallows
errors, logging them via `console.error(label, err)`. Returns `void`
synchronously. Does not participate in the `Fx` type system.

```ts
import { detach } from "@robelest/fx";

detach(
  () => storage.commit({ puts, deletes, meta }),
  "[myModule] storage commit failed:",
);
```

## Composition Patterns

### 1. .pipe() chaining

Simple sequential pipeline with data-last combinators.

From `embedded.ts` — hydration with error logging and recovery:

```ts
import { Fx } from "@robelest/fx";

this._hydrated = Fx.run(
  Fx.from({
    ok: () => this.db.hydrate(),
    err: (err) => err as Error,
  }).pipe(
    Fx.inspect((err) =>
      Fx.sync(() => console.error("[convex-embedded] hydration failed:", err)),
    ),
    Fx.recover(() => Fx.unit),
  ),
);
```

### 2. Fx.gen generators

Imperative-style multi-step composition with early short-circuit on failure.

From `browser/index.ts` — 4-step storage initialization pipeline:

```ts
import { Fx } from "@robelest/fx";

const pipeline = Fx.gen(function* () {
  const wasmModule = yield* Fx.from({
    ok: () => compileWasmModule(),
    err: (err) => err as Error,
  });

  if (!wasmModule) return;

  const storage = yield* Fx.from({
    ok: () => createWaSqliteStorage({ name, wasmModule, workerUrl }),
    err: (err) => err as Error,
  });

  runtime.db.setStorage(storage);

  yield* Fx.from({
    ok: () => runtime.db.hydrate(),
    err: (err) => err as Error,
  });
});

const safe = pipeline.pipe(
  Fx.recover(() =>
    Fx.sync(() => console.error("wa-sqlite init failed, continuing in-memory")),
  ),
);

return Fx.run(safe);
```

### 3. Retry composition

Composing retry policies for OCC transaction retry.

From `transaction.ts` — exponential backoff with jitter, limited retries:

```ts
import { Fx } from "@robelest/fx";

const retrySchedule = Fx.retry.compose(
  Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
  Fx.retry.recurs(this._maxRetries),
);

const attempt = Fx.defer(() => {
  this._readSet.clear();
  this._tablesRead.clear();
  this._db.startTransaction();

  return Fx.from({ ok: () => fn(), err: (e) => e }).pipe(
    Fx.then((result) =>
      Fx.from({
        ok: () => {
          this._validateReadSet();
          this._db.commit();
          return result;
        },
        err: (e) => e,
      }),
    ),
    Fx.recover((err) => {
      this._db.rollbackWrites();
      return err instanceof OccConflictError ? Fx.fail(err) : Fx.fatal(err);
    }),
  );
});

return Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
```

### 4. Error recovery with logging

Observe errors via `Fx.inspect`, conditionally retry with `Fx.retry.while`.

From `monitor.ts` — resolve with per-error retry gating:

```ts
import { Fx } from "@robelest/fx";

const retrySchedule = Fx.retry.while(
  Fx.retry.compose(
    Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
    Fx.retry.recurs(maxRetries - 1),
  ),
  (meta) => {
    if (signal?.aborted) return false;
    const err = meta.input as Error;
    if (err instanceof DOMException && err.name === "AbortError") return false;
    return true;
  },
);

const attempt = Fx.defer(() => {
  if (signal?.aborted)
    return Fx.fail(new DOMException("Aborted", "AbortError"));
  return Fx.from({
    ok: () => remoteClient.query(tableConfig.resolve, { documents: [] }),
    err: (err) => err as Error,
  });
}).pipe(
  Fx.inspect((err) =>
    Fx.sync(() => {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        log.warn(`resolve attempt failed for "${tableName}"`, err);
      }
    }),
  ),
);

await Fx.run(
  attempt.pipe(
    Fx.retry(retrySchedule),
    Fx.tap(() => Fx.sync(() => log.debug(`resolved table "${tableName}"`))),
  ),
);
```

### 5. Resource management

Guarantee cleanup with `Fx.bracket`.

From `wa-sqlite.ts` — worker lifecycle management:

```ts
import { Fx } from "@robelest/fx";

return Fx.run(
  Fx.bracket(
    // Acquire: spawn a Dedicated Worker
    Fx.sync(() => new Worker(workerUrl, { type: "module" })),

    // Use: initialize wa-sqlite and build the storage adapter
    (worker) =>
      Fx.from({
        ok: async () => {
          await rpc(worker, { method: "init", name, wasmModule });
          return buildAdapter(worker);
        },
        err: (err) =>
          new Error(
            `wa-sqlite worker init failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      }),

    // Release: terminate worker only on failure (keeps it alive on success)
    (worker, exit) => {
      if (exit._tag === "Failure") worker.terminate();
      return Fx.unit;
    },
  ),
);
```

### 6. Fire-and-forget

Background work that must not block the caller.

From `database.ts` — persist to durable storage after in-memory commit:

```ts
import { detach } from "@robelest/fx";

if (this._storage !== null && (puts.length > 0 || deletes.length > 0)) {
  detach(
    () =>
      storage.commit({
        puts,
        deletes,
        meta: {
          timestamp: this._timestamp,
          nextDocId: this._nextDocId,
          lastCreationTime: this._lastCreationTime,
        },
      }),
    "[convex-embedded] storage commit failed:",
  );
}
```

From `executor.ts` — scheduled function execution:

```ts
import { detach } from "@robelest/fx";

const timerId = setTimeout(() => {
  detach(
    () => this._runFunction(functionPath, args),
    `[SchedulerExecutor] Scheduled function "${functionPath}" failed:`,
  );
}, delayMs);
```

## License

MIT
