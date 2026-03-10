/** Discriminated union representing computation outcome. */
export type Result<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E };

/** Exit from a computation — failure includes unrecoverable defects. */
export type Exit<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E | FxFatal };

/** Marker wrapper for unrecoverable errors thrown via `Fx.fatal`. */
export class FxFatal {
  readonly _tag = "Fatal" as const;
  constructor(readonly defect: unknown) {}
}

/**
 * Lazy computation that produces `A` or fails with `E`.
 * Supports `.pipe()` for chaining and `yield*` in generators.
 */
export interface Fx<A, E = never> {
  /** Execute the computation. */
  readonly _run: () => Promise<Result<A, E>>;

  /** Chain combinators fluently: `fx.pipe(Fx.map(f), Fx.then(g))`. */
  pipe<B>(ab: (self: Fx<A, E>) => B): B;
  pipe<B, C>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C): C;
  pipe<B, C, D>(ab: (self: Fx<A, E>) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  pipe<B, C, D, F>(
    ab: (self: Fx<A, E>) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => F,
  ): F;

  /** Enable `yield*` in `Fx.gen(function* () { ... })`. */
  [Symbol.iterator](): Generator<Fx<A, E>, A, A>;
}
