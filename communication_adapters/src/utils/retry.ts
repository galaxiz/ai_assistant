/**
 * Retry an async operation up to maxAttempts times with a fixed delay between
 * attempts. Only retries when the optional `retryable` predicate returns true.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts: number;
    delayMs: number;
    retryable?: (err: unknown) => boolean;
    onRetry?: (err: unknown, attempt: number) => void;
  },
): Promise<T> {
  const { maxAttempts, delayMs, retryable = () => true, onRetry } = opts;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && retryable(err)) {
        onRetry?.(err, attempt);
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastErr;
}

/** Returns true for errors thrown when the orchestrator client is reconnecting. */
export function isNotConnectedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('not connected');
}
