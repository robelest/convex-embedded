/**
 * Retry policy primitives for `@robelest/fx`.
 *
 * This module provides composable building blocks for constructing retry
 * strategies. Each primitive controls a single aspect of retry behavior —
 * delay calculation, attempt limiting, jitter, or conditional continuation —
 * and they are combined via {@link compose} and {@link while_} to form
 * complete policies.
 *
 * @remarks
 * Policies are accessed in consumer code through the `Fx.retry` namespace
 * (e.g. `Fx.retry.exponential(100)`). The `while_` function is re-exported
 * as `Fx.retry.while` so consumers never see the trailing underscore.
 *
 * A typical composition chains a delay policy, jitter, and a retry limit:
 * ```ts
 * Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(50)),
 *   Fx.retry.recurs(5),
 * )
 * ```
 *
 * @see {@link RetryPolicy} — the core interface all primitives produce
 * @see {@link compose} — the primary combinator for merging policies
 *
 * @module
 * @category Retry
 */

/**
 * A stateless retry policy that decides whether to retry and how long to wait.
 *
 * @remarks
 * Every retry primitive in this module returns a `RetryPolicy`. Policies are
 * plain objects with a single {@link RetryPolicy.next | next} method, making
 * them trivially composable — wrap one policy with another to layer behaviors
 * (jitter, limits, conditional predicates).
 *
 * Policies are **stateless**: the same policy instance can be reused across
 * multiple independent retry loops. All per-attempt state is carried in the
 * `attempt` counter passed to {@link RetryPolicy.next | next}.
 *
 * @typeParam E - The error type the policy inspects. Defaults to `unknown`.
 *   Narrowing `E` allows type-safe predicates in {@link while_}.
 *
 * @example
 * ```ts
 * // OCC transaction retry — exponential backoff with jitter, capped at 5 retries
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(this._maxRetries),
 * );
 * ```
 *
 * @see {@link exponential} — delay policy using exponential backoff
 * @see {@link jittered} — decorator that adds random jitter to delays
 * @see {@link recurs} — limits the number of retry attempts
 * @see {@link compose} — combines a delay policy with a limit policy
 * @see {@link while_} — conditionally continues retrying based on a predicate
 *
 * @category Retry
 */
export interface RetryPolicy<E = unknown> {
  /**
   * Compute the delay before the next retry attempt.
   *
   * @remarks
   * The `attempt` parameter is **0-indexed relative to retries**, not total
   * attempts. That is, `attempt === 0` corresponds to the **first retry**
   * (the second overall execution). The initial execution is not counted.
   *
   * Returning `null` signals that retrying should stop — the most recent
   * error will be propagated to the caller. Returning `0` means retry
   * immediately with no delay.
   *
   * @param attempt - The 0-indexed retry number. `0` = first retry (second
   *   overall attempt), `1` = second retry, and so on.
   * @param error - The error from the most recent failed attempt. The type
   *   is determined by the policy's `E` type parameter.
   * @returns The delay in milliseconds before the next attempt, or `null`
   *   to stop retrying.
   *
   * @example
   * ```ts
   * const policy: RetryPolicy = Fx.retry.exponential(100);
   * policy.next(0, err); // → 100  (first retry, delay 100ms)
   * policy.next(1, err); // → 200  (second retry, delay 200ms)
   * policy.next(2, err); // → 400  (third retry, delay 400ms)
   * ```
   *
   * @category Retry
   */
  next(attempt: number, error: E): number | null;
}

/**
 * Create an exponential backoff delay policy.
 *
 * Returns a policy where the delay for retry `attempt` is
 * `baseMs * 2^attempt`. The progression for `exponential(100)` is:
 *
 * | attempt | delay   |
 * |---------|---------|
 * | 0       | 100 ms  |
 * | 1       | 200 ms  |
 * | 2       | 400 ms  |
 * | 3       | 800 ms  |
 * | 4       | 1600 ms |
 *
 * @remarks
 * This policy never returns `null` — it will produce delays indefinitely.
 * **You must compose it with {@link recurs}** (or another limiting policy)
 * to cap the number of retries. Without a limit, the retry loop runs
 * forever with geometrically increasing delays.
 *
 * The policy ignores the error argument; delay is purely a function of the
 * attempt number.
 *
 * @param baseMs - The base delay in milliseconds. The first retry
 *   (`attempt === 0`) waits exactly this long. Subsequent retries double
 *   the previous delay.
 * @returns A {@link RetryPolicy} that computes `baseMs * 2^attempt`.
 *
 * @example
 * ```ts
 * // OCC transaction retry — compose with jitter and a retry limit
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(this._maxRetries),
 * );
 *
 * // Standalone (infinite retries — rarely used without compose)
 * const delays = Fx.retry.exponential(100);
 * delays.next(0, err); // → 100
 * delays.next(3, err); // → 800
 * ```
 *
 * @see {@link jittered} — wrap with jitter to prevent thundering herd
 * @see {@link recurs} — limit the number of retries
 * @see {@link compose} — combine delay and limit policies
 *
 * @category Retry
 */
export function exponential(baseMs: number): RetryPolicy {
  return {
    next(attempt) {
      return baseMs * 2 ** attempt;
    },
  };
}

/**
 * Wrap a policy with ±25% random jitter on its delays.
 *
 * The returned policy delegates to the inner policy's
 * {@link RetryPolicy.next | next} and multiplies the result by a random
 * factor uniformly distributed in `[0.75, 1.25]`. The result is rounded
 * to the nearest integer.
 *
 * @remarks
 * Jitter prevents the **thundering herd** problem: when many clients fail
 * simultaneously, pure exponential backoff causes them all to retry at the
 * exact same intervals, creating repeated load spikes. Adding randomness
 * spreads retries across a window, smoothing the load on the server.
 *
 * If the inner policy returns `null` (stop retrying), the jittered wrapper
 * passes `null` through unchanged — jitter only affects delay values, not
 * the decision to stop.
 *
 * The jitter range is fixed at ±25% (multiplier `0.75`–`1.25`). For a
 * base delay of 100 ms, the jittered delay ranges from 75 ms to 125 ms.
 *
 * @typeParam E - The error type, forwarded from the inner policy.
 * @param policy - The inner policy whose delays will be jittered.
 * @returns A new {@link RetryPolicy} that applies random jitter to the
 *   inner policy's delays.
 *
 * @example
 * ```ts
 * // Jittered exponential backoff for OCC transactions
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(this._maxRetries),
 * );
 * ```
 *
 * @example
 * ```ts
 * // Jittered exponential backoff for network resolve with abort support
 * const retrySchedule = Fx.retry.while(
 *   Fx.retry.compose(
 *     Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
 *     Fx.retry.recurs(maxRetries - 1),
 *   ),
 *   (meta) => !signal?.aborted,
 * );
 * ```
 *
 * @see {@link exponential} — the most common inner policy for jitter
 * @see {@link compose} — combine jittered delays with a retry limit
 *
 * @category Retry
 */
export function jittered<E>(policy: RetryPolicy<E>): RetryPolicy<E> {
  return {
    next(attempt, error) {
      const delay = policy.next(attempt, error);
      if (delay === null) return null;
      const jitter = 0.75 + Math.random() * 0.5;
      return Math.round(delay * jitter);
    },
  };
}

/**
 * Create a policy that limits the number of retries.
 *
 * `recurs(n)` allows at most `n` retries, meaning `n + 1` total attempts
 * (the initial attempt plus `n` retries). When the attempt counter reaches
 * `n`, the policy returns `null` to stop.
 *
 * | `recurs(n)` | retries | total attempts |
 * |-------------|---------|----------------|
 * | `recurs(0)` | 0       | 1              |
 * | `recurs(1)` | 1       | 2              |
 * | `recurs(3)` | 3       | 4              |
 * | `recurs(5)` | 5       | 6              |
 *
 * @remarks
 * This policy returns a delay of `0` (instant retry) for all allowed
 * attempts. It controls **only the count**, not timing. To add delays
 * between retries, compose it with a delay policy like {@link exponential}
 * via {@link compose}. The standard pattern is:
 *
 * ```ts
 * Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(baseMs)),
 *   Fx.retry.recurs(maxRetries),
 * )
 * ```
 *
 * The policy ignores the error argument; the retry decision is purely
 * count-based.
 *
 * @param maxRetries - The maximum number of retries. `0` means no retries
 *   (only the initial attempt runs). Must be a non-negative integer.
 * @returns A {@link RetryPolicy} that allows up to `maxRetries` retries
 *   with zero delay, then returns `null`.
 *
 * @example
 * ```ts
 * // OCC transaction — 5 retries (6 total attempts) with exponential backoff
 * const OCC_MAX_RETRIES = 5;
 * const OCC_BASE_DELAY_MS = 50;
 *
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(OCC_MAX_RETRIES),
 * );
 * ```
 *
 * @see {@link compose} — combine with a delay policy for timed retries
 * @see {@link exponential} — common delay policy to pair with `recurs`
 *
 * @category Retry
 */
export function recurs(maxRetries: number): RetryPolicy {
  return {
    next(attempt) {
      return attempt < maxRetries ? 0 : null;
    },
  };
}

/**
 * Compose two policies: take the delay from the first, but stop when
 * **either** policy returns `null`.
 *
 * This is the primary combinator for building complete retry strategies.
 * The first argument provides the delay schedule, and the second provides
 * the termination condition. Both policies are consulted on every attempt;
 * if either returns `null`, the composed policy returns `null`.
 *
 * @remarks
 * The canonical usage pairs a delay policy (often jittered exponential)
 * with a count limit:
 *
 * ```ts
 * compose(jittered(exponential(50)), recurs(5))
 * ```
 *
 * This produces exponential backoff with ±25% jitter, stopping after 5
 * retries (6 total attempts).
 *
 * The delay value comes exclusively from the `delay` (first) argument.
 * The `limit` (second) argument's numeric return value is evaluated but
 * discarded — only its `null` vs non-`null` distinction matters. This
 * means `recurs` (which returns `0`) works correctly as the limit argument
 * because its actual delay value is ignored.
 *
 * Both policies receive the same `attempt` and `error` arguments, so
 * error-aware policies work correctly in either position.
 *
 * @typeParam E - The error type, shared by both policies.
 * @param delay - The policy that determines the retry delay. Its numeric
 *   return value is used as the composed policy's delay.
 * @param limit - The policy that determines when to stop. Its numeric
 *   return value is ignored; only `null` (stop) vs non-`null` (continue)
 *   matters.
 * @returns A new {@link RetryPolicy} that returns the delay from `delay`
 *   when both policies return non-`null`, or `null` when either stops.
 *
 * @example
 * ```ts
 * // OCC transaction — exponential backoff + jitter + retry limit
 * const OCC_MAX_RETRIES = 5;
 * const OCC_BASE_DELAY_MS = 50;
 *
 * const retrySchedule = Fx.retry.compose(
 *   Fx.retry.jittered(Fx.retry.exponential(OCC_BASE_DELAY_MS)),
 *   Fx.retry.recurs(OCC_MAX_RETRIES),
 * );
 *
 * const attempt = Fx.defer(() => {
 *   db.startTransaction();
 *   return Fx.from({ ok: () => fn(), err: (e) => e });
 * });
 *
 * return Fx.run(attempt.pipe(Fx.retry(retrySchedule)));
 * ```
 *
 * @example
 * ```ts
 * // Network resolve — compose inside a while_ for abort support
 * const retrySchedule = Fx.retry.while(
 *   Fx.retry.compose(
 *     Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
 *     Fx.retry.recurs(maxRetries - 1),
 *   ),
 *   (meta) => !signal?.aborted,
 * );
 * ```
 *
 * @see {@link exponential} — common delay policy
 * @see {@link jittered} — add jitter to delay policies
 * @see {@link recurs} — common limit policy
 * @see {@link while_} — add conditional continuation on top of composed policies
 *
 * @category Retry
 */
export function compose<E>(
  delay: RetryPolicy<E>,
  limit: RetryPolicy<E>,
): RetryPolicy<E> {
  return {
    next(attempt, error) {
      const d = delay.next(attempt, error);
      const l = limit.next(attempt, error);
      if (d === null || l === null) return null;
      return d;
    },
  };
}

/**
 * Continue retrying only while a predicate returns `true`.
 *
 * Wraps an inner policy with a guard condition evaluated **before** each
 * retry. If the predicate returns `false`, the policy returns `null`
 * immediately without consulting the inner policy. If the predicate
 * returns `true`, the inner policy's result is returned unchanged.
 *
 * @remarks
 * The predicate runs **before** the inner policy on each attempt, so a
 * `false` result short-circuits without computing the delay.
 *
 * Common use cases:
 * - **Abort signal**: stop retrying when an `AbortController` fires.
 * - **Error classification**: stop on non-transient errors (e.g.,
 *   `AbortError`, 4xx HTTP status) while retrying transient ones.
 * - **External state**: stop when a component unmounts or a flag changes.
 *
 * This function is exported as `while_` (trailing underscore) because
 * `while` is a reserved keyword in JavaScript. It is re-exported on the
 * `Fx.retry` namespace as `Fx.retry.while`, so consumer code uses the
 * clean name without the underscore.
 *
 * @typeParam E - The error type. Narrowing `E` gives type-safe access
 *   to the error in the predicate via `meta.input`.
 * @param policy - The inner retry policy to delegate to when the
 *   predicate passes.
 * @param predicate - A function that receives `{ attempt, input }` and
 *   returns `true` to continue retrying or `false` to stop. `attempt`
 *   is the 0-indexed retry number and `input` is the error from the
 *   most recent failed attempt.
 * @returns A new {@link RetryPolicy} that gates the inner policy behind
 *   the predicate.
 *
 * @example
 * ```ts
 * // Network resolve with abort signal — stop retrying on abort or AbortError
 * const retrySchedule = Fx.retry.while(
 *   Fx.retry.compose(
 *     Fx.retry.jittered(Fx.retry.exponential(retryDelayMs)),
 *     Fx.retry.recurs(maxRetries - 1),
 *   ),
 *   (meta) => {
 *     // Stop retrying if the signal has been aborted
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
 * @see {@link compose} — combine delay and limit policies before wrapping with `while_`
 * @see {@link RetryPolicy} — the interface all policies implement
 *
 * @category Retry
 */
export function while_<E>(
  policy: RetryPolicy<E>,
  predicate: (meta: { attempt: number; input: E }) => boolean,
): RetryPolicy<E> {
  return {
    next(attempt, error) {
      if (!predicate({ attempt, input: error })) return null;
      return policy.next(attempt, error);
    },
  };
}
