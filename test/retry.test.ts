import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { envelopeOfResult, envelopeToExit } from "../src/errors";
import { withRateLimitRetry, type RetryOptions } from "../src/retry";

/** Fake clock: sleeping advances time; nothing really waits. */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function opts(
  clock: ReturnType<typeof fakeClock>,
  over: Partial<RetryOptions> = {},
): RetryOptions {
  return {
    maxRetries: 2,
    maxWaitSeconds: 300,
    sleep: clock.sleep,
    now: clock.now,
    ...over,
  };
}

function rateLimited(retryAfterSeconds?: number) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "RATE_LIMITED",
            message: "Rate limit exceeded.",
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          },
        }),
      },
    ],
  };
}

const success = {
  content: [{ type: "text", text: '{"id":"task_9"}' }],
  structuredContent: { id: "task_9" },
};

const notFound = {
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: { code: "NOT_FOUND", message: "No such task." },
      }),
    },
  ],
};

/** fn that pops results in order and counts calls. */
function sequence(results: unknown[]) {
  let calls = 0;
  return {
    fn: async () => {
      calls += 1;
      if (results.length === 0) throw new Error("sequence exhausted");
      return results.length > 1 ? results.shift() : results[0];
    },
    calls: () => calls,
  };
}

describe("withRateLimitRetry", () => {
  it("retries a RATE_LIMITED envelope after retryAfterSeconds", async () => {
    const clock = fakeClock();
    const seq = sequence([rateLimited(3), success]);
    const result = await withRateLimitRetry(seq.fn, opts(clock));
    assert.deepEqual(result, success);
    assert.equal(seq.calls(), 2);
    assert.deepEqual(clock.sleeps, [3000]);
  });

  it("caps at maxRetries, returning the last RATE_LIMITED result (→ exit 6)", async () => {
    const clock = fakeClock();
    const seq = sequence([rateLimited(1)]);
    const result = await withRateLimitRetry(
      seq.fn,
      opts(clock, { maxRetries: 2 }),
    );
    assert.equal(seq.calls(), 3); // 1 attempt + 2 retries
    assert.deepEqual(clock.sleeps, [1000, 1000]);
    const envelope = envelopeOfResult(result);
    assert.equal(envelope?.error.code, "RATE_LIMITED");
    assert.equal(envelopeToExit(envelope).code, 6);
  });

  it("never waits past maxWaitSeconds (single oversized wait)", async () => {
    const clock = fakeClock();
    const seq = sequence([rateLimited(10)]);
    const result = await withRateLimitRetry(
      seq.fn,
      opts(clock, { maxRetries: 5, maxWaitSeconds: 5 }),
    );
    assert.equal(seq.calls(), 1);
    assert.deepEqual(clock.sleeps, []);
    assert.equal(envelopeOfResult(result)?.error.code, "RATE_LIMITED");
  });

  it("never waits past maxWaitSeconds (cumulative)", async () => {
    const clock = fakeClock();
    const seq = sequence([rateLimited(4)]);
    // 1st retry waits 4s (total 4 ≤ 6); 2nd would reach 8s > 6 → stop.
    const result = await withRateLimitRetry(
      seq.fn,
      opts(clock, { maxRetries: 5, maxWaitSeconds: 6 }),
    );
    assert.equal(seq.calls(), 2);
    assert.deepEqual(clock.sleeps, [4000]);
    assert.equal(envelopeOfResult(result)?.error.code, "RATE_LIMITED");
  });

  it("never retries non-RATE_LIMITED envelopes", async () => {
    const clock = fakeClock();
    const seq = sequence([notFound]);
    const result = await withRateLimitRetry(seq.fn, opts(clock));
    assert.equal(seq.calls(), 1);
    assert.deepEqual(clock.sleeps, []);
    assert.deepEqual(result, notFound);
  });

  it("never retries success results", async () => {
    const clock = fakeClock();
    const seq = sequence([success]);
    const result = await withRateLimitRetry(seq.fn, opts(clock));
    assert.equal(seq.calls(), 1);
    assert.deepEqual(result, success);
  });

  it("maxRetries 0 (--no-wait semantics): one attempt, no sleep", async () => {
    const clock = fakeClock();
    const seq = sequence([rateLimited(1)]);
    const result = await withRateLimitRetry(
      seq.fn,
      opts(clock, { maxRetries: 0 }),
    );
    assert.equal(seq.calls(), 1);
    assert.deepEqual(clock.sleeps, []);
    assert.equal(envelopeOfResult(result)?.error.code, "RATE_LIMITED");
  });

  it("does not retry when retryAfterSeconds is missing or non-finite", async () => {
    for (const bad of [undefined, Number.POSITIVE_INFINITY, Number.NaN, -1]) {
      const clock = fakeClock();
      const seq = sequence([rateLimited(bad as number | undefined)]);
      await withRateLimitRetry(seq.fn, opts(clock));
      assert.equal(seq.calls(), 1, `retryAfterSeconds=${String(bad)}`);
      assert.deepEqual(clock.sleeps, []);
    }
  });

  it("propagates thrown errors without retrying (transport is not our job)", async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
      withRateLimitRetry(async () => {
        calls += 1;
        throw new Error("fetch failed");
      }, opts(clock)),
      /fetch failed/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });
});
