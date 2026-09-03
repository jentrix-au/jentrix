/**
 * RATE_LIMITED retry policy over tool-call results.
 *
 * PURE — clock and sleep are injected, so tests drive a fake clock and prod
 * wires `setTimeout`. Inside the dependency firewall (sibling imports only).
 */

import { envelopeOfResult } from "./errors";

export interface RetryOptions {
  /** Retries AFTER the first attempt; 0 = `--no-wait` (never sleep). */
  maxRetries: number;
  /**
   * Hard cap on total time spent (waiting + calling) across all retries, in
   * seconds. A retry whose wait would push past the cap is not attempted —
   * the RATE_LIMITED result is returned instead. This is the guarantee that
   * a hostile/buggy `retryAfterSeconds` can never wait forever.
   */
  maxWaitSeconds: number;
  /** Injected sleep (milliseconds). Prod: setTimeout; tests: fake clock. */
  sleep: (ms: number) => Promise<void>;
  /** Injected clock (epoch milliseconds). */
  now: () => number;
}

/**
 * Run `fn` and, when its result is a RATE_LIMITED error envelope carrying a
 * usable `retryAfterSeconds`, sleep that long and retry — up to
 * `maxRetries` times and never past `maxWaitSeconds` total. Everything else
 * (success results, other envelopes, RATE_LIMITED without a finite positive
 * `retryAfterSeconds`) is returned to the caller unchanged on the spot;
 * exhausted retries also return the last RATE_LIMITED result (the caller
 * maps it to exit 6). Thrown errors propagate — transport failures are not
 * retried here.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, maxWaitSeconds, sleep, now } = options;
  const start = now();
  let attempt = 0;
  for (;;) {
    const result = await fn();
    const envelope = envelopeOfResult(result);
    if (envelope?.error.code !== "RATE_LIMITED") return result;
    const retryAfter = envelope.error.retryAfterSeconds;
    // No usable wait hint → don't guess, don't loop.
    if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter)) {
      return result;
    }
    if (retryAfter < 0) return result;
    if (attempt >= maxRetries) return result;
    const elapsedMs = now() - start;
    if (elapsedMs + retryAfter * 1000 > maxWaitSeconds * 1000) return result;
    await sleep(retryAfter * 1000);
    attempt += 1;
  }
}
