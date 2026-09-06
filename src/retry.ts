/**
 * RATE_LIMITED retry policy over tool-call results.
 *
 * PURE — clock and sleep are injected, so tests drive a fake clock and prod
 * wires `setTimeout`. Inside the dependency firewall (sibling imports only).
 */

import { envelopeOfResult } from "./errors";

export interface RetryOptions<T = unknown> {
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
  /**
   * JEN-456 — how to read "wait this long" off a result that is not an MCP
   * tool-call envelope. The session host's heartbeat, trace-part upload and
   * typed-push go over REST, where the refusal is an HTTP 429 carrying
   * `Retry-After`, not an envelope; this lets the ONE retry policy cover both
   * rather than growing a second one beside it. Return null for "not rate
   * limited" — every other result is returned to the caller untouched.
   *
   * Absent ⇒ the MCP envelope reader, which is the original behaviour.
   */
  retryAfterOf?: (result: T) => number | null;
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
  options: RetryOptions<T>,
): Promise<T> {
  const { maxRetries, maxWaitSeconds, sleep, now, retryAfterOf } = options;
  const start = now();
  let attempt = 0;
  for (;;) {
    const result = await fn();
    const retryAfter = retryAfterOf
      ? retryAfterOf(result)
      : envelopeRetryAfter(result);
    if (retryAfter === null) return result;
    // No usable wait hint → don't guess, don't loop.
    if (!Number.isFinite(retryAfter)) return result;
    if (retryAfter < 0) return result;
    if (attempt >= maxRetries) return result;
    const elapsedMs = now() - start;
    if (elapsedMs + retryAfter * 1000 > maxWaitSeconds * 1000) return result;
    await sleep(retryAfter * 1000);
    attempt += 1;
  }
}

/**
 * The default reader: a RATE_LIMITED tool-call envelope's `retryAfterSeconds`,
 * or null when the result is not a rate-limit refusal. An envelope that refuses
 * without a usable hint yields NaN, which the caller treats as "don't guess".
 */
function envelopeRetryAfter(result: unknown): number | null {
  const envelope = envelopeOfResult(result);
  if (envelope?.error.code !== "RATE_LIMITED") return null;
  const retryAfter = envelope.error.retryAfterSeconds;
  return typeof retryAfter === "number" ? retryAfter : NaN;
}
