import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { callTool, type ToolCaller } from "../src/call";
import { stableStringify } from "../src/render";
import type { RetryOptions } from "../src/retry";

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

function retryOpts(
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

/**
 * Stub Client: pops fixture results (or throws thrown values) in order and
 * records the params of every call. Structurally it is exactly the
 * `Pick<Client, "callTool">` surface `callTool` consumes — the same shape an
 * `InMemoryTransport`-backed real Client presents in C3.1.
 */
function stubClient(script: Array<{ result?: unknown; throws?: unknown }>) {
  const calls: unknown[] = [];
  const remaining = [...script];
  const client = {
    callTool: async (params: unknown) => {
      calls.push(params);
      const step = remaining.length > 1 ? remaining.shift() : remaining[0];
      if (!step) throw new Error("stub script exhausted");
      if ("throws" in step) throw step.throws;
      return step.result;
    },
  } as unknown as ToolCaller;
  return { client, calls };
}

const envelope = (code: string, extra: Record<string, unknown> = {}) => ({
  isError: true,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: { code, message: `${code} occurred`, ...extra },
      }),
    },
  ],
});

const successResult = {
  content: [
    { type: "text", text: '{"id":"task_9","key":"STK-42","number":42}' },
  ],
  structuredContent: { id: "task_9", key: "STK-42", number: 42 },
};

describe("callTool — success path", () => {
  it("passes name/arguments through and renders structuredContent (--json)", async () => {
    const clock = fakeClock();
    const { client, calls } = stubClient([{ result: successResult }]);
    const outcome = await callTool(
      client,
      "create_task",
      { columnId: "col_1", title: "Fix login redirect" },
      { json: true, retry: retryOpts(clock) },
    );
    assert.deepEqual(calls, [
      {
        name: "create_task",
        arguments: { columnId: "col_1", title: "Fix login redirect" },
      },
    ]);
    assert.equal(outcome.exitCode, 0);
    assert.equal(
      outcome.stdout,
      stableStringify(successResult.structuredContent),
    );
    assert.equal(outcome.stderr, undefined);
  });

  it("renders human mode through the same renderer (list shape → table)", async () => {
    const clock = fakeClock();
    const list = {
      boards: [{ id: "b1", name: "Sprint 12" }],
      totalCount: 1,
    };
    const { client } = stubClient([
      {
        result: {
          content: [{ type: "text", text: "{}" }],
          structuredContent: list,
        },
      },
    ]);
    const outcome = await callTool(
      client,
      "list_boards",
      {},
      { json: false, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.stdout ?? "", /Sprint 12/);
    assert.match(outcome.stdout ?? "", /totalCount: 1/);
  });

  it("falls back to raw text when structuredContent is absent (foreign tools)", async () => {
    const clock = fakeClock();
    const { client } = stubClient([
      { result: { content: [{ type: "text", text: "plain text answer" }] } },
    ]);
    const outcome = await callTool(
      client,
      "some_tool",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.stdout, "plain text answer");
  });
});

describe("callTool — error envelopes route through envelopeToExit", () => {
  it("FORBIDDEN → exit 3 with hint on stderr", async () => {
    const clock = fakeClock();
    const { client } = stubClient([
      { result: envelope("FORBIDDEN", { hint: "Ask an admin." }) },
    ]);
    const outcome = await callTool(
      client,
      "convert_board_kind",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 3);
    assert.equal(
      outcome.stderr,
      "FORBIDDEN: FORBIDDEN occurred (Ask an admin.)",
    );
    assert.equal(outcome.stdout, undefined);
  });

  it("CONFLICT → exit 5 with error.current as JSON on stdout", async () => {
    const clock = fakeClock();
    const current = { id: "task_1", updatedAt: "2026-06-21T00:00:00.000Z" };
    const { client } = stubClient([
      { result: envelope("CONFLICT", { current }) },
    ]);
    const outcome = await callTool(
      client,
      "update_task",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 5);
    assert.equal(outcome.stdout, JSON.stringify(current));
  });

  it("isError without a parseable envelope → exit 1 with the raw text", async () => {
    const clock = fakeClock();
    const { client } = stubClient([
      {
        result: { isError: true, content: [{ type: "text", text: "kaboom" }] },
      },
    ]);
    const outcome = await callTool(
      client,
      "x",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.stderr ?? "", /kaboom/);
  });
});

describe("callTool — RATE_LIMITED retry integration", () => {
  it("retries per retryAfterSeconds, then succeeds", async () => {
    const clock = fakeClock();
    const { client, calls } = stubClient([
      { result: envelope("RATE_LIMITED", { retryAfterSeconds: 2 }) },
      { result: successResult },
    ]);
    const outcome = await callTool(
      client,
      "list_tasks",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(clock.sleeps, [2000]);
  });

  it("exhausted retries → exit 6 (--no-wait: maxRetries 0 never sleeps)", async () => {
    const clock = fakeClock();
    const { client, calls } = stubClient([
      { result: envelope("RATE_LIMITED", { retryAfterSeconds: 30 }) },
    ]);
    const outcome = await callTool(
      client,
      "list_tasks",
      {},
      {
        json: true,
        retry: retryOpts(clock, { maxRetries: 0 }),
      },
    );
    assert.equal(outcome.exitCode, 6);
    assert.equal(calls.length, 1);
    assert.deepEqual(clock.sleeps, []);
    assert.match(outcome.stderr ?? "", /^RATE_LIMITED: /);
  });
});

describe("callTool — transport failures", () => {
  it("thrown transport error → exit 7, never retried", async () => {
    const clock = fakeClock();
    const { client, calls } = stubClient([
      { throws: new Error("fetch failed") },
    ]);
    const outcome = await callTool(
      client,
      "list_tasks",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 7);
    assert.equal(calls.length, 1);
    assert.match(outcome.stderr ?? "", /^TRANSPORT: fetch failed/);
  });

  it("HTTP 401 gets the dead-token message (agents misread a bare 401)", async () => {
    const clock = fakeClock();
    const { client } = stubClient([
      {
        throws: new Error("Error POSTing to endpoint (HTTP 401): Unauthorized"),
      },
    ]);
    const outcome = await callTool(
      client,
      "list_tasks",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 7);
    assert.match(outcome.stderr ?? "", /token is invalid, expired, or revoked/);
    assert.match(outcome.stderr ?? "", /STACKS_TOKEN/);
  });

  it("non-Error throwables still exit 7", async () => {
    const clock = fakeClock();
    const { client } = stubClient([{ throws: "socket hang up" }]);
    const outcome = await callTool(
      client,
      "list_tasks",
      {},
      { json: true, retry: retryOpts(clock) },
    );
    assert.equal(outcome.exitCode, 7);
    assert.match(outcome.stderr ?? "", /socket hang up/);
  });
});
