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
    onAttempt?: (attempt: number) => void;
    onFailure?: (err: unknown, attempt: number, willRetry: boolean) => void;
  },
): Promise<T> {
  const { maxAttempts, delayMs, retryable = () => true, onRetry, onAttempt, onFailure } = opts;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onAttempt?.(attempt);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const willRetry = attempt < maxAttempts && retryable(err);
      onFailure?.(err, attempt, willRetry);
      if (willRetry) {
        onRetry?.(err, attempt);
        await new Promise<void>((r) => setTimeout(r, delayMs));
      } else {
        break;
      }
    }
  }

  throw lastErr;
}

/** Returns true for transient connection errors that are worth retrying. */
export function isNotConnectedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('not connected') ||
    err.message.includes('WebSocket closed unexpectedly')
  );
}
