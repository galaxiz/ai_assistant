import { status } from '@grpc/grpc-js';

const RETRYABLE_CODES = new Set([status.UNAVAILABLE, status.DEADLINE_EXCEEDED, status.RESOURCE_EXHAUSTED]);

export function isRetryable(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'number' &&
    RETRYABLE_CODES.has((err as { code: number }).code)
  );
}

export interface RetryOptions {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err;
      const jitter = Math.random() * 0.2 - 0.1; // ±10%
      const delay = Math.min(
        opts.initialDelayMs * 2 ** attempt * (1 + jitter),
        opts.maxDelayMs,
      );
      await sleep(delay);
      attempt++;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
