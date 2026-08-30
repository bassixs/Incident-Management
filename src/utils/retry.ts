import { setTimeout as delay } from 'node:timers/promises';

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to fail fast (e.g. on a 4xx that will never succeed). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
};

/**
 * Controlled retry with exponential backoff and jitter.
 *
 * Used for every outbound MAX call: a transient delivery failure must never
 * cost us an incident, and it must never cause a duplicate one either — so the
 * retry always wraps a single idempotent HTTP call, never a business action.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error, attempt)) break;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const waitMs = Math.round(backoff * (0.5 + Math.random() * 0.5));
      options.onRetry?.(error, attempt, waitMs);
      await delay(waitMs);
    }
  }
  throw lastError;
}
