export interface RetryOptions {
  maxRetries?: number;
  baseMs?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  /** Optional predicate to decide whether an error is retryable. Non-retryable errors are thrown immediately. */
  shouldRetry?: (error: unknown) => boolean;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 2,
    baseMs = 200,
    jitter = true,
    signal,
    shouldRetry,
  } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (shouldRetry && !shouldRetry(error)) throw error;
      if (attempt < maxRetries) {
        if (signal?.aborted) throw error;
        const delay = baseMs * 2 ** attempt;
        const jitterMs = jitter ? Math.random() * delay : 0;
        await new Promise((r) => setTimeout(r, delay + jitterMs));
      }
    }
  }
  throw lastError;
}
