/**
 * M20.1 — provider adapters + bridge fault injection (PRD §25): recorded/fake
 * Claude and Codex event streams, provider IDs, duplicate events, network
 * loss, redacted-slot terminality, heartbeat throttling, and honest closure.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRateLimitBudget,
  MAX_FINAL_RESPONSE_BYTES,
  retryAfterOfResponse,
  SessionBridge,
  withHostRateLimitRetry,
} from "../src/session-host/session-bridge.js";
import { mapClaudeTranscriptLine } from "../src/session-host/session-claude-transcript.js";
import { mapCodexThreadEvent } from "../src/session-host/session-codex-events.js";
import { createSessionRedactor } from "../src/session-host/session-redact.js";
import { SessionSpool } from "../src/session-host/session-spool.js";

test("claude transcript mapper: visible shapes only, deterministic", () => {
  const assistant = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "u1",
      timestamp: "2026-08-06T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "working on it" },
          {
            type: "tool_use",
            id: "tu1",
            name: "Read",
            input: { file: "a.ts" },
          },
        ],
        usage: { input_tokens: 120, output_tokens: 30 },
      },
    }),
  );
  assert.equal(assistant.unrecognized, false);
  assert.deepEqual(
    assistant.events.map((e) => e.kind),
    ["assistant_message", "tool_call", "usage"],
  );
  assert.equal(assistant.events[2]!.providerEventId, "u1:usage");

  const user = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-08-06T10:00:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "file body" },
        ],
      },
    }),
  );
  assert.deepEqual(
    user.events.map((e) => e.kind),
    ["tool_result"],
  );

  assert.equal(mapClaudeTranscriptLine("not json").unrecognized, true);
  assert.deepEqual(
    mapClaudeTranscriptLine(JSON.stringify({ type: "summary" })).events,
    [],
  );
});

test("claude transcript mapper: inputTokens includes cache read + creation (AGE-935)", () => {
  // Anthropic's input_tokens EXCLUDES the cache fields — they are siblings.
  // On a long session cache reads dominate (round 2 saw 129 vs 9,153,841).
  const mapped = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "u3",
      timestamp: "2026-08-06T10:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 8000,
          output_tokens: 42,
        },
      },
    }),
  );
  const usage = mapped.events.find((e) => e.kind === "usage");
  // AGE-938: the split rides beside the summed total — disjoint subsets.
  assert.deepEqual(usage?.payload, {
    kind: "delta",
    inputTokens: 9003,
    outputTokens: 42,
    cacheReadTokens: 8000,
    cacheCreationTokens: 1000,
  });

  // Cache-only entry (input_tokens omitted) still yields a usage receipt.
  const cacheOnly = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "u4",
      timestamp: "2026-08-06T10:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { cache_read_input_tokens: 500, output_tokens: 1 },
      },
    }),
  );
  const cacheUsage = cacheOnly.events.find((e) => e.kind === "usage");
  assert.deepEqual(cacheUsage?.payload, {
    kind: "delta",
    inputTokens: 500,
    outputTokens: 1,
    cacheReadTokens: 500,
    cacheCreationTokens: 0,
  });

  // No cache fields on the entry at all (old transcript format): the split is
  // OMITTED — unreported, never a fabricated zero (AGE-938).
  const noCache = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "u5",
      timestamp: "2026-08-06T10:00:04.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    }),
  );
  assert.deepEqual(noCache.events.find((e) => e.kind === "usage")?.payload, {
    kind: "delta",
    inputTokens: 7,
    outputTokens: 2,
  });
});

test("codex event mapper: thread id, items, usage receipts, hidden reasoning dropped", () => {
  const started = mapCodexThreadEvent({
    type: "thread.started",
    thread_id: "th_1",
  });
  assert.equal(started.threadId, "th_1");
  assert.equal(started.event?.kind, "session");

  const message = mapCodexThreadEvent({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "done" },
  });
  assert.equal(message.event?.kind, "assistant_message");
  assert.equal(message.event?.providerEventId, "i1");

  const command = mapCodexThreadEvent({
    type: "item.completed",
    item: {
      id: "i2",
      type: "command_execution",
      command: "pnpm test",
      exit_code: 0,
    },
  });
  assert.equal(command.event?.kind, "command");

  const usage = mapCodexThreadEvent({
    type: "turn.completed",
    usage: { input_tokens: 900, cached_input_tokens: 350, output_tokens: 80 },
  });
  assert.equal(usage.event?.kind, "usage");
  // AGE-938: cached_input_tokens (a SUBSET of input_tokens) → cacheReadTokens;
  // cacheCreationTokens is never emitted (no such Codex concept — unreported).
  assert.deepEqual(usage.event?.payload, {
    kind: "delta",
    inputTokens: 900,
    outputTokens: 80,
    cacheReadTokens: 350,
  });

  const reasoning = mapCodexThreadEvent({
    type: "item.completed",
    item: { id: "i3", type: "reasoning", text: "hidden" },
  });
  assert.equal(reasoning.event, null);
  assert.equal(reasoning.unrecognized, false);

  const alien = mapCodexThreadEvent({ type: "something.else" });
  assert.equal(alien.unrecognized, true);
});

interface FakeCall {
  url: string;
  body: Record<string, unknown>;
}

function fakeBridge(opts: {
  partResponses?: Array<{ status: number; body: unknown } | "network-error">;
  heartbeatResponses?: Array<
    { status: number; body: unknown } | "network-error"
  >;
  /** AGE-649 — the typed-push boundary the final response lands on. */
  artifactResponses?: Array<
    { status: number; body: unknown } | "network-error"
  >;
  now?: { value: number };
  traceCapture?: boolean;
  onUnauthorized?: (failedBearer: string) => Promise<void>;
}) {
  const root = mkdtempSync(join(tmpdir(), "stacks-bridge-"));
  const spool = new SessionSpool(root, "ses_1");
  const calls: FakeCall[] = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const partQueue = [...(opts.partResponses ?? [])];
  const heartbeatQueue = [...(opts.heartbeatResponses ?? [])];
  const artifactQueue = [...(opts.artifactResponses ?? [])];
  const timeline: string[] = [];
  const now = opts.now ?? { value: 100_000 };
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.example",
    bearer: "tmo_transient_bearer_123",
    sessionId: "ses_1",
    provider: "claude",
    spool,
    redactor: createSessionRedactor({ env: {}, homedir: null }),
    callTool: async (name, args) => {
      toolCalls.push({ name, args });
      timeline.push(`tool:${name}`);
      if (name === "get_agent_session") {
        return { updatedAt: "2026-08-06T10:00:00.000Z" };
      }
      if (name === "complete_agent_session") {
        return {
          status: args.outcome,
          captureComplete: (args.captureError ?? null) === null,
          summaryArtifactId: "art_summary",
        };
      }
      return {};
    },
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ url: String(url), body });
      // ONE ordered log across both effect channels (HTTP and MCP tool calls),
      // so a test can assert that the final-response push precedes the
      // completion that seals the session against it.
      timeline.push(`http:${new URL(String(url)).pathname}`);
      if (String(url).includes("/parts")) {
        const next = partQueue.shift() ?? {
          status: 200,
          body: { checksum: "ack" },
        };
        if (next === "network-error") throw new Error("ECONNREFUSED");
        return {
          ok: next.status < 400,
          status: next.status,
          json: async () => next.body,
          text: async () => JSON.stringify(next.body),
        } as unknown as Response;
      }
      if (String(url).includes("/heartbeat")) {
        const next = heartbeatQueue.shift() ?? {
          status: 200,
          body: { ok: true },
        };
        if (next === "network-error") throw new Error("ECONNREFUSED");
        return {
          ok: next.status < 400,
          status: next.status,
          json: async () => next.body,
          text: async () => JSON.stringify(next.body),
        } as unknown as Response;
      }
      if (String(url).includes("/artifacts")) {
        const next = artifactQueue.shift() ?? {
          status: 200,
          body: { artifactId: "art_final", type: "REPORT", deduped: false },
        };
        if (next === "network-error") throw new Error("ECONNREFUSED");
        return {
          ok: next.status < 400,
          status: next.status,
          json: async () => next.body,
          text: async () => JSON.stringify(next.body),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "{}",
      } as unknown as Response;
    }) as typeof fetch,
    monotonic: () => now.value,
    wallClock: () => new Date("2026-08-06T10:00:00.000Z"),
    ...(opts.traceCapture !== undefined
      ? { traceCapture: opts.traceCapture }
      : {}),
    ...(opts.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}),
  });
  return { bridge, spool, calls, toolCalls, timeline, now };
}

test("bridge redacts before spool and collects deduped usage receipts", () => {
  const { bridge, spool } = fakeBridge({});
  bridge.startObserving();
  bridge.record({
    kind: "tool_call",
    providerEventId: "e1",
    payload: { input: "Authorization: Bearer tmo_abcdefghijklmnop999" },
  });
  bridge.record({
    kind: "usage",
    providerEventId: "u1",
    payload: { kind: "delta", inputTokens: 10, outputTokens: 2 },
  });
  // Duplicate provider event id — the rollup counts it once (AC38).
  bridge.record({
    kind: "usage",
    providerEventId: "u1",
    payload: { kind: "delta", inputTokens: 10, outputTokens: 2 },
  });
  const spooled = spool.readPart(0);
  assert.ok(!spooled.includes("tmo_abcdefghijklmnop999"));
  const rollup = bridge.usageRollup();
  assert.equal(rollup.inputTokens, 10);
  assert.equal(rollup.outputTokens, 2);
  // No receipt carried a cache field → null, never a fabricated 0 (AGE-938).
  assert.equal(rollup.cacheReadTokens, null);
  assert.equal(rollup.cacheCreationTokens, null);
});

test("bridge rollup sums the cache split across receipts (AGE-938)", () => {
  const { bridge } = fakeBridge({});
  bridge.startObserving();
  bridge.record({
    kind: "usage",
    providerEventId: "u1",
    payload: {
      kind: "delta",
      inputTokens: 1000,
      outputTokens: 5,
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
    },
  });
  bridge.record({
    kind: "usage",
    providerEventId: "u2",
    payload: {
      kind: "delta",
      inputTokens: 2000,
      outputTokens: 7,
      cacheReadTokens: 1800,
      cacheCreationTokens: 0,
    },
  });
  // A receipt WITHOUT the split still contributes its totals.
  bridge.record({
    kind: "usage",
    providerEventId: "u3",
    payload: { kind: "delta", inputTokens: 30, outputTokens: 1 },
  });
  const rollup = bridge.usageRollup();
  assert.equal(rollup.inputTokens, 3030);
  assert.equal(rollup.outputTokens, 13);
  assert.equal(rollup.cacheReadTokens, 2700);
  assert.equal(rollup.cacheCreationTokens, 50);
});

test("bridge: network loss keeps spool + pending; retry converges; ack deletes", async () => {
  const { bridge, spool } = fakeBridge({
    partResponses: ["network-error"],
  });
  bridge.record({ kind: "user_message", payload: { text: "hi" } });
  const first = await bridge.flushParts();
  assert.equal(first.pending, 1);
  assert.equal(spool.pendingParts().length, 1); // evidence retained (AC22)

  const second = await bridge.flushParts(); // queue empty → default 200 ack
  assert.equal(second.pending, 0);
  assert.equal(spool.pendingParts().length, 0);
});

test("bridge: a redacted-slot refusal is terminal — spool kept, no more retries", async () => {
  const { bridge, spool } = fakeBridge({
    partResponses: [
      {
        status: 409,
        body: { error: "ARTIFACT_PART_REDACTED: slot is terminal" },
      },
    ],
  });
  bridge.record({ kind: "user_message", payload: { text: "hi" } });
  const result = await bridge.flushParts();
  assert.equal(result.pending, 0);
  assert.equal(result.terminal, 1);
  assert.equal(spool.pendingParts().length, 1); // never deleted on a stub
  const again = await bridge.flushParts();
  assert.equal(again.terminal, 1); // not retried
});

test("bridge: heartbeats are throttled to the 30s window (AC42)", async () => {
  const { bridge, calls, now } = fakeBridge({});
  await bridge.maybeHeartbeat();
  await bridge.maybeHeartbeat();
  now.value += 29_000;
  await bridge.maybeHeartbeat();
  now.value += 2_000;
  await bridge.maybeHeartbeat();
  const heartbeats = calls.filter((c) => c.url.includes("/heartbeat"));
  assert.equal(heartbeats.length, 2);
});

test("flush advances the spool past acked parts — later events never reuse a flushed slot", async () => {
  // Part ingestion is append-only per slot: same part + different checksum is
  // a permanent CONFLICT. A mid-session flush that acks (and deletes) the
  // open part must therefore advance the spool, or the next event re-creates
  // the same part number with different content and capture never converges.
  const { bridge, spool } = fakeBridge({
    partResponses: [{ status: 200, body: { checksum: "ack-0" } }],
  });
  bridge.record({ kind: "user_message", payload: { text: "turn one" } });
  const first = await bridge.flushParts();
  assert.equal(first.pending, 0);
  bridge.record({ kind: "user_message", payload: { text: "turn two" } });
  const parts = spool.pendingParts();
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.part, 1, "the flushed slot 0 is never reused");
});

test("heartbeat 409 SESSION_NOT_ACTIVE marks the session inactive; network loss does not", async () => {
  const { bridge, now } = fakeBridge({
    heartbeatResponses: [
      "network-error",
      {
        status: 409,
        body: { error: "SESSION_NOT_ACTIVE", status: "COMPLETED" },
      },
    ],
  });
  await bridge.maybeHeartbeat();
  assert.equal(bridge.sessionInactive, false, "offline is not termination");
  now.value += 31_000;
  await bridge.maybeHeartbeat();
  assert.equal(
    bridge.sessionInactive,
    true,
    "a definite 409 is the end signal",
  );
});

test("bridge: closure sends the ACKED manifest + rollup under CAS and stays honest about pending", async () => {
  const { bridge, toolCalls } = fakeBridge({
    partResponses: [{ status: 200, body: { checksum: "server-checksum" } }],
  });
  bridge.startObserving();
  bridge.markTurnStarted("t1");
  bridge.record({
    kind: "usage",
    providerEventId: "u1",
    payload: { kind: "delta", inputTokens: 5, outputTokens: 1, turnId: "t1" },
  });
  bridge.markTurnEnded("t1");
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: "main", head: "abc", dirty: false },
  });
  assert.equal(result.status, "COMPLETED");
  const complete = toolCalls.find((c) => c.name === "complete_agent_session")!;
  assert.deepEqual(complete.args.manifest, {
    parts: [{ part: 0, checksum: "server-checksum" }],
  });
  assert.equal(complete.args.expectedUpdatedAt, "2026-08-06T10:00:00.000Z");
  const usage = complete.args.usage as {
    coverage: string;
    inputTokens: number;
  };
  assert.equal(usage.inputTokens, 5);
  assert.equal(usage.coverage, "COMPLETE");
});

test("bridge: an unflushed part makes closure carry capture debt, never completeness", async () => {
  const { bridge, toolCalls } = fakeBridge({
    partResponses: ["network-error", "network-error"],
  });
  bridge.record({ kind: "user_message", payload: { text: "hi" } });
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  assert.equal(result.pendingParts, 1);
  assert.equal(result.captureComplete, false);
  const complete = toolCalls.find((c) => c.name === "complete_agent_session")!;
  assert.match(String(complete.args.captureError), /capture pending/);
});

test("bridge: traceCapture=false spools nothing, uploads nothing, still submits usage (Jentrix MVP AC10)", async () => {
  const { bridge, spool, calls, toolCalls } = fakeBridge({
    traceCapture: false,
  });
  bridge.startObserving();
  bridge.record({ kind: "user_message", payload: { text: "hi" } });
  bridge.record({
    kind: "usage",
    providerEventId: "u1:usage",
    payload: { kind: "delta", inputTokens: 100, outputTokens: 20 },
  });
  // Nothing durable was spooled and no part upload happens.
  assert.equal(spool.pendingParts().length, 0);
  const flush = await bridge.flushParts();
  assert.deepEqual(flush, { pending: 0, terminal: 0 });
  assert.equal(calls.filter((c) => c.url.includes("/parts")).length, 0);
  // 2026-08-08 finding: the rollup is DURABLE the moment a receipt lands —
  // a host death can no longer take the telemetry with it (`session end`'s
  // server-side fallback submits this snapshot).
  const snapshot = JSON.parse(
    readFileSync(join(spool.directory, "usage.json"), "utf8"),
  ) as { rollup: { inputTokens: number | null } };
  assert.equal(snapshot.rollup.inputTokens, 100);
  // Heartbeats still flow — the session must not be swept as abandoned.
  await bridge.maybeHeartbeat();
  assert.equal(calls.filter((c) => c.url.includes("/heartbeat")).length, 1);
  // Closure: NO manifest, an honest capture-off reason, usage still attested.
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  const complete = toolCalls.find((c) => c.name === "complete_agent_session")!;
  assert.equal(complete.args.manifest, undefined);
  // AGE-958: the healthy capture-off default is a STATUS the server derives
  // (OFF_BY_DESIGN), never prose in the error field.
  assert.equal(complete.args.captureError, null);
  const usage = complete.args.usage as { inputTokens: number | null };
  assert.equal(usage.inputTokens, 100);
  assert.equal(result.pendingParts, 0);
  // The snapshot's job is done once the server holds the rollup.
  assert.equal(existsSync(join(spool.directory, "usage.json")), false);
});

test("bridge: a 401 heartbeat asks the bearer source to recover (rotation mid-session)", async () => {
  const failed: string[] = [];
  const { bridge, calls } = fakeBridge({
    heartbeatResponses: [{ status: 401, body: { error: "invalid_token" } }],
    onUnauthorized: async (bearer) => {
      failed.push(bearer);
    },
  });
  await bridge.maybeHeartbeat();
  assert.equal(calls.filter((c) => c.url.includes("/heartbeat")).length, 1);
  assert.deepEqual(failed, ["tmo_transient_bearer_123"]);
});

// ---------------------------------------------------------------------------
// AGE-649 — the session's FINAL RESPONSE as a typed artifact.
//
// With TRACE capture off (the MVP default) a closed session kept its telemetry
// and its typed artifacts and nothing held what the agent concluded. The
// RUN_SUMMARY cannot carry it: model prose is banned from that document
// (M20.1 AC31). So the output rides the ordinary typed-push boundary.
// ---------------------------------------------------------------------------

test("bridge: the final response is pushed as a typed report BEFORE the session is sealed", async () => {
  const { bridge, calls, timeline } = fakeBridge({});
  bridge.startObserving();
  bridge.record({ kind: "assistant_message", payload: { text: "first pass" } });
  bridge.record({
    kind: "assistant_message",
    payload: { text: "Shipped the operator path. Drift gate green." },
  });
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: "main", head: "abc", dirty: false },
  });

  assert.equal(result.finalResponseArtifactId, "art_final");
  const push = calls.find((c) => c.url.includes("/artifacts"));
  assert.ok(push, "the final response was pushed");
  assert.equal(push!.body.kind, "report");
  assert.match(String(push!.body.title), /^Final response — session /);
  const body = String(push!.body.body);
  // The NEWEST message, not the first one observed.
  assert.match(body, /Shipped the operator path\. Drift gate green\./);
  assert.doesNotMatch(body, /first pass/);
  // Self-describing: a reader can tell it apart from the RUN_SUMMARY beside it.
  assert.match(body, /Verbatim provider output/);
  assert.match(body, /RUN_SUMMARY artifact is the deterministic record/);

  // ORDERING is the load-bearing part: `COMPLETED` seals the session against
  // typed pushes, so a push issued after the completion call could never land.
  // Asserted over ONE ordered log of both effect channels — comparing indexes
  // inside two separate arrays would prove nothing about their interleaving.
  const pushAt = timeline.indexOf("http:/api/agent-sessions/ses_1/artifacts");
  const sealAt = timeline.indexOf("tool:complete_agent_session");
  assert.ok(pushAt >= 0, `no push in ${timeline.join(" → ")}`);
  assert.ok(sealAt >= 0, `no completion in ${timeline.join(" → ")}`);
  assert.ok(
    pushAt < sealAt,
    `the push must precede the seal: ${timeline.join(" → ")}`,
  );
  assert.equal(result.status, "COMPLETED");
});

test("bridge: capture-off still stores the final response — that is the whole point", async () => {
  const { bridge, calls, spool } = fakeBridge({ traceCapture: false });
  bridge.startObserving();
  bridge.record({
    kind: "assistant_message",
    payload: { text: "Closing note with capture off." },
  });
  // Nothing was spooled — the event was observed, not captured.
  assert.equal(spool.pendingParts().length, 0);
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  assert.equal(result.finalResponseArtifactId, "art_final");
  assert.match(
    String(calls.find((c) => c.url.includes("/artifacts"))!.body.body),
    /Closing note with capture off\./,
  );
});

test("bridge: no assistant text observed means NO artifact, never an empty one", async () => {
  const { bridge, calls } = fakeBridge({});
  bridge.startObserving();
  // Tool-only turns and whitespace are not a final response.
  bridge.record({ kind: "tool_call", payload: { input: "ls" } });
  bridge.record({ kind: "assistant_message", payload: { text: "   \n " } });
  bridge.record({ kind: "assistant_message", payload: {} });
  const result = await bridge.complete({
    outcome: "INTERRUPTED",
    end: { branch: null, head: null, dirty: null },
  });
  assert.equal(result.finalResponseArtifactId, null);
  assert.equal(calls.filter((c) => c.url.includes("/artifacts")).length, 0);
});

test("bridge: a refused final-response push never costs the operator their close", async () => {
  const { bridge, toolCalls } = fakeBridge({
    artifactResponses: [{ status: 503, body: { error: "no object storage" } }],
  });
  bridge.record({ kind: "assistant_message", payload: { text: "done" } });
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  assert.equal(result.finalResponseArtifactId, null);
  assert.equal(result.status, "COMPLETED");
  assert.ok(toolCalls.find((c) => c.name === "complete_agent_session"));
});

test("bridge: a network failure on the final-response push never costs the close", async () => {
  const { bridge, toolCalls } = fakeBridge({
    artifactResponses: ["network-error"],
  });
  bridge.record({ kind: "assistant_message", payload: { text: "done" } });
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  assert.equal(result.finalResponseArtifactId, null);
  assert.ok(toolCalls.find((c) => c.name === "complete_agent_session"));
});

test("bridge: the final response is REDACTED text, like every other durable write", async () => {
  const { bridge, calls } = fakeBridge({});
  bridge.record({
    kind: "assistant_message",
    payload: { text: "the token is tmo_abcdefghijklmnop999 — do not share" },
  });
  await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  const body = String(
    calls.find((c) => c.url.includes("/artifacts"))!.body.body,
  );
  assert.doesNotMatch(body, /tmo_abcdefghijklmnop999/);
  assert.match(body, /do not share/);
});

test("bridge: an oversized final response is truncated and SAYS so", async () => {
  const { bridge, calls } = fakeBridge({});
  bridge.record({
    kind: "assistant_message",
    payload: { text: "x".repeat(MAX_FINAL_RESPONSE_BYTES + 5_000) },
  });
  await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: null, head: null, dirty: null },
  });
  const body = String(
    calls.find((c) => c.url.includes("/artifacts"))!.body.body,
  );
  assert.ok(
    Buffer.byteLength(body, "utf8") <= MAX_FINAL_RESPONSE_BYTES,
    "stays inside the bound the server enforces",
  );
  assert.match(
    body,
    /\[truncated — the response exceeded the artifact limit\]/,
  );
});

// ---------------------------------------------------------------------------
// TPM Slice 2 (task-performance-monitoring PRD §6) — the mapper/model half:
// Claude stamps the producing model onto each usage receipt (AC2.4), Codex
// maps turn_context + reasoning_output_tokens when the stream reports them
// (AC2.4/AC2.7), and the bridge's flush receipt bypasses the 30 s window
// (AC2.5) without ever lying about acknowledgement.
// ---------------------------------------------------------------------------

test("claude mapper: the usage receipt carries the entry's own model (AC2.4)", () => {
  const mapped = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "u9",
      timestamp: "2026-08-06T10:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    }),
  );
  const usage = mapped.events.find((e) => e.kind === "usage");
  assert.equal(
    (usage?.payload as { modelId?: string }).modelId,
    "claude-opus-5",
  );
  // The line-level report is unchanged — the bridge still tracks "last model".
  assert.equal(mapped.modelId, "claude-opus-5");
});

test("codex mapper: turn_context names the model; reasoning tokens map when present (AC2.4/AC2.7)", () => {
  const context = mapCodexThreadEvent({
    type: "turn_context",
    turn_context: { model: "gpt-5.5-codex" },
  });
  assert.equal(context.unrecognized, false);
  assert.equal(context.modelId, "gpt-5.5-codex");
  assert.equal(context.event, null);

  const usage = mapCodexThreadEvent({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 8,
    },
  });
  assert.deepEqual(usage.event?.payload, {
    kind: "delta",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 40,
    reasoningOutputTokens: 8,
  });

  // Absent stays absent — an old runtime without the field reports nothing.
  const bare = mapCodexThreadEvent({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 1 },
  });
  assert.equal(
    "reasoningOutputTokens" in (bare.event?.payload as object),
    false,
  );
});

test("bridge: flushUsageNow bypasses the 30 s window and reports the server's ack honestly (AC2.5)", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let respondOk = true;
  const root = mkdtempSync(join(tmpdir(), "stacks-flush-"));
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.test",
    bearer: "tm_test",
    sessionId: "ses_flush",
    provider: "claude",
    spool: new SessionSpool(root, "ses_flush"),
    redactor: createSessionRedactor({ homedir: "/home/u" }),
    callTool: async () => ({}),
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(respondOk ? "{}" : "nope", {
        status: respondOk ? 200 : 503,
      });
    }) as typeof fetch,
    monotonic: (() => {
      // Starts past the 30 s window (lastHeartbeatAt begins at 0) so the
      // FIRST beat posts; every later call is 1 s apart — inside the window.
      let t = 30_000;
      return () => (t += 1000);
    })(),
  });
  bridge.record({
    kind: "usage",
    payload: {
      kind: "delta",
      inputTokens: 10,
      outputTokens: 2,
      modelId: "claude-opus-5",
    },
  });
  await bridge.maybeHeartbeat(); // first beat posts
  await bridge.maybeHeartbeat(); // throttled — inside the window
  assert.equal(calls.length, 1);
  // The flush IGNORES the window…
  assert.equal(await bridge.flushUsageNow(), true);
  assert.equal(calls.length, 2);
  // …and the beat carries the per-model rollup (AC2.4 on the wire).
  const usage = calls[1]!.body.usage as {
    perModel?: Array<{ modelId: string | null }>;
  };
  assert.equal(usage.perModel?.length, 1);
  assert.equal(usage.perModel?.[0]?.modelId, "claude-opus-5");
  // A failed post is reported as NOT acknowledged — never a lie.
  respondOk = false;
  assert.equal(await bridge.flushUsageNow(), false);
});

// ---------------------------------------------------------------------------
// JEN-456 — bounded RATE_LIMITED backoff. Before this, a 429 on the heartbeat
// was a silent liveness loss, a 429 on the final response lost the session's
// closing output, and a RATE_LIMITED `get_agent_session` inside complete() threw
// and took the whole close with it ("spool retained for retry", exit 1) — all
// four observed on prod on 2026-09-06 with five hosts under one token.
// ---------------------------------------------------------------------------

/** A Response-shaped stub: only status + headers + the two readers are used. */
function rateLimited(retryAfter: string | null): Response {
  return {
    ok: false,
    status: 429,
    headers: {
      get: (name: string) => (name === "retry-after" ? retryAfter : null),
    },
    json: async () => ({ error: "RATE_LIMITED" }),
    text: async () => '{"error":"RATE_LIMITED"}',
  } as unknown as Response;
}

function okResponse(body: unknown = { ok: true }): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

test("retryAfterOfResponse reads Retry-After, defaults, and ignores non-429", () => {
  assert.equal(retryAfterOfResponse(rateLimited("34")), 34);
  // No usable header (an older server): retry once conservatively rather than
  // abandon the close, because the close is what is being protected.
  assert.equal(retryAfterOfResponse(rateLimited(null)), 5);
  assert.equal(retryAfterOfResponse(rateLimited("garbage")), 5);
  assert.equal(retryAfterOfResponse(okResponse()), null);
});

test("the rate-limit budget is shared, bounded, and never goes negative", () => {
  const budget = createRateLimitBudget(10_000);
  assert.equal(budget.remainingSeconds(), 10);
  budget.spend(4_000);
  assert.equal(budget.remainingSeconds(), 6);
  budget.spend(60_000);
  assert.equal(budget.remainingSeconds(), 0);
  budget.spend(-5);
  assert.equal(budget.remainingSeconds(), 0);
});

test("a rate-limited heartbeat waits Retry-After and succeeds on the retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-rl-beat-"));
  const slept: number[] = [];
  let calls = 0;
  const logs: string[] = [];
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.test",
    bearer: "tm_test",
    sessionId: "ses_rl",
    provider: "claude",
    spool: new SessionSpool(root, "ses_rl"),
    redactor: createSessionRedactor({ env: {}, homedir: null }),
    callTool: async () => ({}),
    rateLimitBudget: createRateLimitBudget(),
    log: (line) => logs.push(line),
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1 ? rateLimited("3") : okResponse();
    }) as unknown as typeof fetch,
  });
  // Inject the sleep through the module helper rather than really waiting.
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout: unknown }).setTimeout = ((
    fn: () => void,
    ms: number,
  ) => {
    slept.push(ms);
    fn();
    return 0 as unknown as ReturnType<typeof originalSetTimeout>;
  }) as unknown as typeof originalSetTimeout;
  try {
    const acked = await bridge.flushUsageNow();
    assert.equal(acked, true, "the retry must succeed, not report a dead beat");
  } finally {
    (globalThis as { setTimeout: unknown }).setTimeout = originalSetTimeout;
  }
  assert.equal(calls, 2, "exactly one retry");
  assert.deepEqual(slept, [3000], "waited the server's own Retry-After");
  assert.equal(logs.length, 1, "said it ONCE, not once per attempt");
  assert.match(logs[0]!, /rate limited \(HTTP 429\)/);
});

test("an exhausted budget stops retrying instead of hanging past the close window", async () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-rl-budget-"));
  let calls = 0;
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.test",
    bearer: "tm_test",
    sessionId: "ses_rl2",
    provider: "claude",
    spool: new SessionSpool(root, "ses_rl2"),
    redactor: createSessionRedactor({ env: {}, homedir: null }),
    callTool: async () => ({}),
    // Zero budget: `jentrix session end` waits 90 s for the host, so a wait
    // that does not fit is never taken.
    rateLimitBudget: createRateLimitBudget(0),
    fetchImpl: (async () => {
      calls += 1;
      return rateLimited("59");
    }) as unknown as typeof fetch,
  });
  assert.equal(await bridge.flushUsageNow(), false);
  assert.equal(calls, 1, "no wait fits, so no retry is attempted");
});

test("without a budget the bridge behaves exactly as before (no backoff)", async () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-rl-none-"));
  let calls = 0;
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.test",
    bearer: "tm_test",
    sessionId: "ses_rl3",
    provider: "claude",
    spool: new SessionSpool(root, "ses_rl3"),
    redactor: createSessionRedactor({ env: {}, homedir: null }),
    callTool: async () => ({}),
    fetchImpl: (async () => {
      calls += 1;
      return rateLimited("3");
    }) as unknown as typeof fetch,
  });
  assert.equal(await bridge.flushUsageNow(), false);
  assert.equal(calls, 1);
});

test("withHostRateLimitRetry retries a RATE_LIMITED tool envelope, bounded", async () => {
  const budget = createRateLimitBudget(60_000);
  const slept: number[] = [];
  let attempts = 0;
  const envelope = {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code: "RATE_LIMITED",
            message: "Rate limit exceeded (60 requests/min)",
            retryAfterSeconds: 4,
          },
        }),
      },
    ],
  };
  let clock = 0;
  const result = await withHostRateLimitRetry(
    budget,
    async () => {
      attempts += 1;
      return attempts === 1 ? envelope : { ok: true };
    },
    undefined,
    async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    () => clock,
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(slept, [4000]);
  // The wait is charged to the shared budget, so the REST and MCP paths of one
  // close cannot each spend the whole thing.
  assert.equal(budget.remainingSeconds(), 56);
});

// JEN-457 — the CLI is released separately from the app, and the server
// rejects unknown parameters outright ("INVALID_INPUT: Unknown parameter
// \"captureOff\" for this tool", verified against prod on 2026-09-06). A client
// carrying the field must not lose the close against a server that predates it.
test("complete drops captureOff and closes anyway when the server rejects it", async () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-fwdcompat-"));
  const seen: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.test",
    bearer: "tm_test",
    sessionId: "ses_fwd",
    provider: "claude",
    spool: new SessionSpool(root, "ses_fwd"),
    redactor: createSessionRedactor({ env: {}, homedir: null }),
    traceCapture: false,
    log: (line) => logs.push(line),
    callTool: async (name, args) => {
      if (name === "get_agent_session") {
        return { updatedAt: "2026-08-06T10:00:00.000Z" };
      }
      seen.push(args);
      if (name === "complete_agent_session" && "captureOff" in args) {
        throw new Error(
          'complete_agent_session failed: {"error":{"code":"INVALID_INPUT","message":"Unknown parameter \\"captureOff\\" for this tool."}}',
        );
      }
      return { status: "COMPLETED", captureComplete: true };
    },
  });
  const result = await bridge.complete({
    outcome: "COMPLETED",
    end: { branch: "main", head: "abc", dirty: false },
  });
  assert.equal(result.status, "COMPLETED", "the close must still happen");
  assert.equal(seen.length, 2, "one rejected attempt, one without the field");
  assert.equal(seen[0]!.captureOff, true);
  assert.equal("captureOff" in seen[1]!, false);
  // Everything else survives the retry untouched.
  assert.equal(seen[1]!.sessionId, "ses_fwd");
  assert.equal(seen[1]!.outcome, "COMPLETED");
  assert.match(logs.join("\n"), /does not accept `captureOff`/);
});

test("complete does NOT swallow an unrelated refusal", async () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-fwdcompat2-"));
  let calls = 0;
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://stacks.test",
    bearer: "tm_test",
    sessionId: "ses_fwd2",
    provider: "claude",
    spool: new SessionSpool(root, "ses_fwd2"),
    redactor: createSessionRedactor({ env: {}, homedir: null }),
    traceCapture: false,
    callTool: async (name) => {
      if (name === "get_agent_session") {
        return { updatedAt: "2026-08-06T10:00:00.000Z" };
      }
      calls += 1;
      throw new Error("complete_agent_session failed: EVIDENCE_FLOOR refusal");
    },
  });
  await assert.rejects(
    bridge.complete({
      outcome: "COMPLETED",
      end: { branch: "main", head: "abc", dirty: false },
    }),
    /EVIDENCE_FLOOR/,
  );
  assert.equal(calls, 1, "no blind retry on a real refusal");
});
