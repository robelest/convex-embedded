/**
 * Compile-time regression tests for TS2766.
 *
 * The original bug: `yield* Fx.fail(...)` inside `Fx.gen` generators caused
 * TS2766 because the `[Symbol.iterator]` on `Fx<A, E>` had `TNext = A`.
 * When `A = never` (as with `Fx.fail`), `TNext = never` was incompatible
 * with the `gen` runner which sends `unknown`.
 *
 * Fix: `TNext` changed from `A` to `unknown` in `Fx[Symbol.iterator]`.
 *
 * These are pure type-level assertions — no runtime code. They pass if tsgo
 * compiles without errors. The `@ts-expect-error` directives assert that
 * certain patterns DO produce errors (negative tests).
 */

import { Fx } from "../index";

// ---------------------------------------------------------------------------
// Positive: patterns that MUST compile
// ---------------------------------------------------------------------------

/** yield* Fx.fail("boom") inside Fx.gen must compile (the TS2766 fix). */
const _failInGen: Fx<never, string> = Fx.gen(function* () {
  yield* Fx.fail("boom");
  return "unreachable" as never;
});

/** yield* Fx.succeed(42) inside Fx.gen must compile. */
const _succeedInGen: Fx<number, never> = Fx.gen(function* () {
  const n: number = yield* Fx.succeed(42);
  return n;
});

/** Mixed yield* with both succeed and fail in one generator. */
const _mixedGen: Fx<string, string> = Fx.gen(function* () {
  const n: number = yield* Fx.succeed(42);
  if (n > 100) {
    yield* Fx.fail("too large");
  }
  return String(n);
});

/** yield* Fx.unit inside Fx.gen. */
const _unitInGen: Fx<void, never> = Fx.gen(function* () {
  yield* Fx.unit;
});

/** Chaining multiple yield* calls with consistent error type. */
const _chainGen: Fx<string, string> = Fx.gen(function* () {
  const a: number = yield* Fx.succeed(1);
  const b: number = yield* Fx.succeed(2);
  if (a + b > 10) yield* Fx.fail("overflow");
  return `${a + b}`;
});

// ---------------------------------------------------------------------------
// Negative: patterns that MUST produce type errors
// ---------------------------------------------------------------------------

/** Assigning Fx<number, never> to Fx<string, never> must fail. */
// @ts-expect-error — number is not assignable to string
const _wrongA: Fx<string, never> = Fx.succeed(42);

/** Assigning Fx<never, number> to Fx<never, string> must fail. */
// @ts-expect-error — number is not assignable to string
const _wrongE: Fx<never, string> = Fx.fail(42);

// ---------------------------------------------------------------------------
// Ensure variables are "used" (prevents noUnusedLocals errors)
// ---------------------------------------------------------------------------
void _failInGen;
void _succeedInGen;
void _mixedGen;
void _unitInGen;
void _chainGen;
void _wrongA;
void _wrongE;
