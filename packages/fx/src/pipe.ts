/**
 * Standalone left-to-right function composition for non-Fx values.
 *
 * Takes an initial value and up to five transformation functions, applying them
 * sequentially from left to right. Each function receives the return value of
 * the previous one, producing a fully type-safe transformation pipeline.
 *
 * @remarks
 * `pipe` is a **general-purpose** data transformation utility. It is **not**
 * intended for composing `Fx` effects — use the `fx.pipe()` instance method
 * for that. The distinction:
 *
 * - `pipe(value, f, g)` — transforms a plain value: `g(f(value))`
 * - `myFx.pipe(Fx.map(f), Fx.flatMap(g))` — composes Fx operators on an
 *   effect value, preserving typed error tracking and lazy evaluation.
 *
 * Six overloads (0–5 functions) provide full generic type inference. Calls with
 * more than five functions fall through to the variadic implementation signature
 * and lose per-step type inference (the result becomes `unknown`).
 *
 * @param a - The initial value to transform.
 * @param ab - First transformation: `A → B`.
 * @param bc - Second transformation: `B → C`.
 * @param cd - Third transformation: `C → D`.
 * @param de - Fourth transformation: `D → E`.
 * @param ef - Fifth transformation: `E → F`.
 * @returns The result of applying all transformation functions left to right.
 *   With zero functions, returns `a` unchanged.
 *
 * @example
 * **Basic value transformation (non-Fx):**
 * ```ts
 * import { pipe } from "@robelest/fx";
 *
 * const result = pipe(
 *   "  Hello, World!  ",
 *   (s) => s.trim(),
 *   (s) => s.toLowerCase(),
 *   (s) => s.replace(/\s+/g, "-"),
 * );
 * // result: "hello,-world!" — fully inferred as string
 * ```
 *
 * @example
 * **Multi-step data processing:**
 * ```ts
 * import { pipe } from "@robelest/fx";
 *
 * const total = pipe(
 *   [1, 2, 3, 4, 5],
 *   (nums) => nums.filter((n) => n % 2 === 0),
 *   (evens) => evens.map((n) => n * 10),
 *   (scaled) => scaled.reduce((sum, n) => sum + n, 0),
 * );
 * // total: 60 — inferred as number
 * ```
 *
 * @example
 * **Fx `.pipe()` method (for comparison — do NOT use standalone `pipe` for this):**
 * ```ts
 * import { Fx } from "@robelest/fx";
 *
 * const program = Fx.from({
 *   ok: () => fetchUser(userId),
 *   err: (e) => e as NetworkError,
 * }).pipe(
 *   Fx.map((user) => user.profile),
 *   Fx.chain((profile) =>
 *     Fx.from({
 *       ok: () => enrichProfile(profile),
 *       err: (e) => e as EnrichError,
 *     }),
 *   ),
 * );
 * // program: Fx<EnrichedProfile, NetworkError | EnrichError>
 * ```
 *
 * @see `Fx.pipe()` method on Fx instances for composing Fx operators on effect values.
 *
 * @category Helper
 */
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: (a: A) => B): B;
export function pipe<A, B, C>(a: A, ab: (a: A) => B, bc: (b: B) => C): C;
export function pipe<A, B, C, D>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
): D;
export function pipe<A, B, C, D, E>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
): E;
export function pipe<A, B, C, D, E, F>(
  a: A,
  ab: (a: A) => B,
  bc: (b: B) => C,
  cd: (c: C) => D,
  de: (d: D) => E,
  ef: (e: E) => F,
): F;
export function pipe(
  a: unknown,
  ...fns: Array<(x: unknown) => unknown>
): unknown {
  let result = a;
  for (const fn of fns) result = fn(result);
  return result;
}
