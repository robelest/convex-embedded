/**
 * Compile-time tests for Fx.match — exhaustiveness, narrowing, and type errors.
 *
 * These are pure type-level assertions — no runtime code. They pass if tsgo
 * compiles without errors. The `@ts-expect-error` directives assert that
 * certain patterns DO produce errors (negative tests).
 */

import { Fx } from "../index";

// ---------------------------------------------------------------------------
// Test types
// ---------------------------------------------------------------------------

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number };

type Result =
  | { _tag: "Success"; value: number }
  | { _tag: "Failure"; error: string };

type Action =
  | { type: "increment"; amount: number }
  | { type: "decrement"; amount: number }
  | { type: "reset" };

// ---------------------------------------------------------------------------
// Positive: patterns that MUST compile
// ---------------------------------------------------------------------------

/** Exhaustive match on a 3-variant union narrows each handler's parameter. */
const shape = {} as Shape;
const _shapeArea: Fx<number, never> = Fx.match(shape, shape.kind, {
  circle: (s) => Fx.succeed(Math.PI * s.radius ** 2),
  rect: (s) => Fx.succeed(s.width * s.height),
  triangle: (s) => Fx.succeed((s.base * s.height) / 2),
});

/** Match with different discriminant field name ("_tag"). */
const r = {} as Result;
const _resultMatch: Fx<number | string, never> = Fx.match(r, r._tag, {
  Success: (v) => Fx.succeed(v.value),
  Failure: (v) => Fx.succeed(v.error),
});

/** Handlers can return different Fx error types — union is inferred. */
const r2 = {} as Result;
const _mixedErrors: Fx<number, string | TypeError> = Fx.match(r2, r2._tag, {
  Success: (v) => Fx.succeed(v.value) as Fx<number, never>,
  Failure: (v) => Fx.fail(v.error) as Fx<never, string | TypeError>,
});

/** Match on a 3-variant union with "type" discriminant. */
const a = {} as Action;
const _actionMatch: Fx<number, never> = Fx.match(a, a.type, {
  increment: (v) => Fx.succeed(v.amount),
  decrement: (v) => Fx.succeed(-v.amount),
  reset: () => Fx.succeed(0),
});

// ---------------------------------------------------------------------------
// Negative: patterns that MUST produce type errors
// ---------------------------------------------------------------------------

/** Missing a variant ("triangle") must be a compile error. */
const s2 = {} as Shape;
// @ts-expect-error — missing handler for "triangle"
const _missingVariant = Fx.match(s2, s2.kind, {
  circle: (v) => Fx.succeed(v.radius),
  rect: (v) => Fx.succeed(v.width),
});

// ---------------------------------------------------------------------------
// Ensure variables are "used" (prevents noUnusedLocals errors)
// ---------------------------------------------------------------------------
void _shapeArea;
void _resultMatch;
void _mixedErrors;
void _actionMatch;
void _missingVariant;
