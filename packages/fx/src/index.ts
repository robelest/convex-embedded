/**
 * @module @robelest/fx
 *
 * Minimal, zero-dependency functional effect system for TypeScript with
 * Gleam-inspired naming. The core type `Fx<A, E>` represents a lazy
 * computation that produces a success value `A` or fails with a typed
 * error `E`. Nothing executes until {@link Fx.run} is called.
 *
 * ## Exports by category
 *
 * **Types**: {@link Fx}, {@link Result}, {@link Exit}, {@link FxFatal},
 * {@link RetryPolicy}, {@link TimeoutError}
 *
 * **Constructors**: `Fx.succeed`, `Fx.sync`, `Fx.promise`, `Fx.from`,
 * `Fx.fail`, `Fx.fatal`, `Fx.defer`, `Fx.unit`
 *
 * **Combinators**: `Fx.map`, `Fx.chain`, `Fx.tap`, `Fx.inspect`,
 * `Fx.recover`, `Fx.fold`, `Fx.retry`, `Fx.timeout`, `Fx.delay`
 *
 * **Retry policies**: `Fx.retry.exponential`, `Fx.retry.jittered`,
 * `Fx.retry.recurs`, `Fx.retry.compose`, `Fx.retry.while`
 *
 * **Parallel & traversal**: `Fx.all`, `Fx.race`, `Fx.zip`, `Fx.each`
 *
 * **Resources**: `Fx.bracket`
 *
 * **Control flow**: `Fx.guard`, `Fx.match`, `Fx.attempt`
 *
 * **Execution**: `Fx.gen`, `Fx.run`, `Fx.detach`
 *
 * **Utilities**: `Fx.pipe`
 *
 * ## Quick example
 *
 * ```ts
 * import { Fx } from "@robelest/fx";
 *
 * const getName = Fx.from({
 *   ok: () => fetch("/api/user").then(r => r.json()),
 *   err: (e) => new Error("fetch failed", { cause: e }),
 * }).pipe(
 *   Fx.map(user => user.name),
 *   Fx.recover(() => Fx.succeed("anonymous")),
 * );
 *
 * const name: string = await Fx.run(getName);
 * ```
 */
export { Fx, TimeoutError } from "./core";
export type { Result, Exit } from "./types";
export { FxFatal } from "./types";
export type { RetryPolicy } from "./schedule";
