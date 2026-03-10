/**
 * A retry policy.
 * `next(attempt, error)` returns the delay in ms before the next attempt,
 * or `null` to stop retrying.
 */
export interface RetryPolicy<E = unknown> {
  next(attempt: number, error: E): number | null;
}

/** Exponential backoff: `baseMs * 2^attempt`. */
export function exponential(baseMs: number): RetryPolicy {
  return {
    next(attempt) {
      return baseMs * 2 ** attempt;
    },
  };
}

/** Add +-25% random jitter to delays. */
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

/** Limit to N retries: recurs(N) = at most N retries (N+1 total attempts). */
export function recurs(maxRetries: number): RetryPolicy {
  return {
    next(attempt) {
      return attempt < maxRetries ? 0 : null;
    },
  };
}

/**
 * Compose two policies: takes the delay from the first, but stops
 * when either policy returns null.
 */
export function compose<E>(delay: RetryPolicy<E>, limit: RetryPolicy<E>): RetryPolicy<E> {
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
 * Continue retrying while the predicate returns true.
 * The predicate receives `{ attempt, input }` where input is the error.
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
