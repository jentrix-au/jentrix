/**
 * M20.1 — runner-side capture substrate: local redaction (AC21), crash-safe
 * spool retention (AC22/AC23 + the §12.3 redacted-slot rule), the event
 * envelope, and the §12.5 usage aggregator (AC35–AC39, AC46).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseSessionEvent,
  serializeSessionEvent,
  SESSION_EVENT_VERSION,
} from "../src/session-host/session-events.js";
import { createSessionRedactor, REDACTED } from "../src/session-host/session-redact.js";
import {
  markHostExited,
  markHostFlushed,
  SessionSpool,
  writeHostMarker,
  type SessionHostMarker,
} from "../src/session-host/session-spool.js";
import { aggregateSessionUsage } from "../src/session-host/session-usage.js";

test("redactor scrubs token shapes, env literals, and home prefixes before spool", () => {
  const redactor = createSessionRedactor({
    env: { STACKS_TOKEN: "tm_secret_value_123456" },
    homedir: "/Users/operator",
  });
  const line = redactor.text(
    "Authorization: Bearer tmo_abcdefghijklmnop123 in /Users/operator/work tm_secret_value_123456 sk-ant-abcdefghijklmnopqrstu",
  );
  assert.ok(!line.includes("tmo_abcdefghijklmnop123"));
  assert.ok(!line.includes("tm_secret_value_123456"));
  assert.ok(!line.includes("sk-ant-abcdefghijklmnopqrstu"));
  assert.ok(!line.includes("/Users/operator/work"));
  assert.ok(line.includes("~/work"));
  assert.ok(line.includes(REDACTED));

  const value = redactor.value({
    argv: ["--token", "tm_secret_value_123456"],
    nested: { path: "/Users/operator/repo" },
    count: 3,
  }) as { argv: string[]; nested: { path: string }; count: number };
  assert.equal(value.argv[1], REDACTED);
  assert.equal(value.nested.path, "~/repo");
  assert.equal(value.count, 3);
});

test("event envelope round-trips and rejects foreign shapes", () => {
  const line = serializeSessionEvent({
    version: SESSION_EVENT_VERSION,
    sequence: 7,
    at: "2026-08-06T10:00:00.000Z",
    provider: "claude",
    providerEventId: "evt_1",
    kind: "tool_call",
    payload: { name: "Read" },
  });
  assert.ok(line.endsWith("\n"));
  const parsed = parseSessionEvent(line);
  assert.equal(parsed?.sequence, 7);
  assert.equal(parsed?.kind, "tool_call");
  assert.equal(parseSessionEvent('{"version":2,"sequence":1}'), null);
  assert.equal(parseSessionEvent("not json"), null);
});

test("spool: 0600 parts, rotation, checksum identity, ack-gated deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "stacks-spool-"));
  const spool = new SessionSpool(root, "ses_1");
  spool.append('{"sequence":0}\n');
  spool.append('{"sequence":1}\n');

  const parts = spool.pendingParts();
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.part, 0);
  const mode = statSync(parts[0]!.path).mode & 0o777;
  assert.equal(mode, 0o600);

  // A wrong-checksum "ack" (an audit stub can never produce the right one)
  // deletes NOTHING.
  assert.equal(spool.deleteAcknowledged(0, "not-the-checksum"), false);
  assert.equal(spool.pendingParts().length, 1);

  // The genuine acknowledgement clears the part.
  assert.equal(spool.deleteAcknowledged(0, parts[0]!.checksum), true);
  assert.equal(spool.pendingParts().length, 0);

  // Server-side re-redaction changed the stored checksum: deletion needs the
  // explicit force after the manifest recorded the acked checksum.
  spool.appendRaw(1, "line-with-content\n");
  assert.equal(spool.deleteAcknowledged(1, "serverchanged"), false);
  assert.equal(
    spool.deleteAcknowledged(1, "serverchanged", { force: true }),
    true,
  );

  // A crash-restart resumes numbering from the surviving parts.
  spool.appendRaw(4, "late\n");
  const resumed = new SessionSpool(root, "ses_1");
  resumed.append("next\n");
  assert.deepEqual(
    readdirSync(join(root, "ses_1"))
      .filter((f) => f.startsWith("part-"))
      .sort(),
    ["part-000004.ndjson"],
  );
});

test("usage: dedupe, delta sums, and turn-receipt coverage (AC38)", () => {
  const rollup = aggregateSessionUsage({
    receipts: [
      {
        eventId: "r1",
        turnId: "t1",
        kind: "delta",
        inputTokens: 100,
        outputTokens: 10,
        at: 1000,
      },
      {
        eventId: "r1",
        turnId: "t1",
        kind: "delta",
        inputTokens: 100,
        outputTokens: 10,
        at: 1000,
      }, // duplicate
      {
        eventId: "r2",
        turnId: "t2",
        kind: "delta",
        inputTokens: 50,
        outputTokens: 5,
        at: 2000,
      },
    ],
    observedRanges: [{ from: 0, to: 10_000 }],
    providerTurns: [
      { id: "t1", startedAt: 900, endedAt: 1500 },
      { id: "t2", startedAt: 1900, endedAt: 2500 },
    ],
    toolIntervals: [{ id: "tool1", startedAt: 1000, endedAt: 1200 }],
  });
  assert.equal(rollup.inputTokens, 150);
  assert.equal(rollup.outputTokens, 15);
  assert.equal(rollup.providerActiveDurationMs, 1200);
  assert.equal(rollup.toolDurationMs, 200);
  assert.equal(rollup.coverage, "COMPLETE");
  assert.deepEqual(rollup.missingRanges, []);
});

test("usage: cumulative receipts need a baseline AND continuous capture (AC37/AC46)", () => {
  // Mid-session attach: the first cumulative receipt is a baseline only —
  // the whole thread total is never assigned to the session.
  const attach = aggregateSessionUsage({
    receipts: [
      {
        eventId: "c1",
        kind: "cumulative",
        inputTokens: 5000,
        outputTokens: 800,
        at: 1000,
      },
      {
        eventId: "c2",
        kind: "cumulative",
        inputTokens: 5200,
        outputTokens: 850,
        at: 2000,
      },
    ],
    observedRanges: [{ from: 500, to: 3000 }],
    providerTurns: [],
    toolIntervals: [],
  });
  assert.equal(attach.inputTokens, 200);
  assert.equal(attach.outputTokens, 50);
  assert.equal(attach.coverage, "PARTIAL"); // the baseline gap is named
  assert.ok(attach.missingRanges.some((m: string) => m.includes("baseline")));

  // A gap in capture between two cumulative receipts voids that delta.
  const gapped = aggregateSessionUsage({
    receipts: [
      {
        eventId: "c1",
        kind: "cumulative",
        inputTokens: 100,
        outputTokens: 10,
        at: 1000,
      },
      {
        eventId: "c2",
        kind: "cumulative",
        inputTokens: 900,
        outputTokens: 90,
        at: 9000,
      },
      {
        eventId: "c3",
        kind: "cumulative",
        inputTokens: 950,
        outputTokens: 95,
        at: 9500,
      },
    ],
    observedRanges: [
      { from: 0, to: 2000 },
      { from: 8000, to: 10_000 },
    ],
    providerTurns: [],
    toolIntervals: [],
  });
  // c1→c2 crossed the unobserved 2000–8000 gap: not counted. c2→c3 counted.
  assert.equal(gapped.inputTokens, 50);
  assert.equal(gapped.outputTokens, 5);
  assert.ok(gapped.missingRanges.some((m: string) => m.includes("unobserved")));
});

test("usage: no receipts is UNAVAILABLE; unmatched tool terminals are named (AC39)", () => {
  const rollup = aggregateSessionUsage({
    receipts: [],
    observedRanges: [{ from: 0, to: 1000 }],
    providerTurns: [{ id: "t1", startedAt: 0, endedAt: 500 }],
    toolIntervals: [{ id: "tool1", startedAt: 100, endedAt: null }],
  });
  assert.equal(rollup.inputTokens, null);
  assert.equal(rollup.outputTokens, null);
  assert.equal(rollup.coverage, "UNAVAILABLE");
  assert.ok(rollup.missingRanges.some((m: string) => m.includes("tool1")));
  assert.ok(rollup.missingRanges.some((m: string) => m.includes("t1")));
});

test("host marker: flush stamps acked state; exit preserves it", () => {
  // An empty spool is ambiguous — nothing captured vs everything flushed.
  // The flush stamp is what lets `session status` tell them apart.
  const dir = join(mkdtempSync(join(tmpdir(), "stacks-flush-")), "ses_f");
  writeHostMarker(dir, { pid: 4243, provider: "claude", mode: "watch" });
  markHostFlushed(dir, 3);
  const flushed = JSON.parse(
    readFileSync(join(dir, "host.json"), "utf8"),
  ) as SessionHostMarker;
  assert.equal(flushed.ackedParts, 3);
  assert.ok(flushed.lastFlushAt);
  assert.equal(flushed.pid, 4243, "start fields survive the flush stamp");

  markHostExited(dir, 0);
  const exited = JSON.parse(
    readFileSync(join(dir, "host.json"), "utf8"),
  ) as SessionHostMarker;
  assert.equal(exited.ackedParts, 3, "acked state survives the exit stamp");
  assert.equal(exited.exitCode, 0);

  // No marker → tolerated no-op, same as markHostExited.
  markHostFlushed(join(tmpdir(), "nope-never-existed"), 1);
});

test("host marker: start writes pid, clean exit stamps it, a crash leaves no exit (AGE-929)", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "stacks-host-")), "ses_1");
  writeHostMarker(dir, { pid: 4242, provider: "claude", mode: "launch" });
  const started = JSON.parse(
    readFileSync(join(dir, "host.json"), "utf8"),
  ) as SessionHostMarker;
  assert.equal(started.pid, 4242);
  assert.equal(started.provider, "claude");
  assert.ok(started.startedAt);
  // A crash is exactly this state: a marker with NO exit recorded — the CLI
  // detects it by probing the pid. Only a clean shutdown stamps the exit.
  assert.equal(started.exitedAt, undefined);

  markHostExited(dir, 1);
  const exited = JSON.parse(
    readFileSync(join(dir, "host.json"), "utf8"),
  ) as SessionHostMarker;
  assert.equal(exited.exitCode, 1);
  assert.ok(exited.exitedAt);

  // Stamping a directory with no marker is a tolerated no-op (best-effort).
  markHostExited(join(tmpdir(), "stacks-host-none"), 0);
});

// ---------------------------------------------------------------------------
// TPM Slice 2 (task-performance-monitoring PRD §6, AC2.4/AC2.7) — per-model
// receipt grouping and the reasoning-token split, over the same rules.
// ---------------------------------------------------------------------------

test("usage: receipts group per model, mid-session model change included (AC2.4)", () => {
  const rollup = aggregateSessionUsage({
    receipts: [
      {
        eventId: "r1",
        kind: "delta",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 80,
        modelId: "claude-opus-5",
        at: 1000,
      },
      {
        eventId: "r2",
        kind: "delta",
        inputTokens: 50,
        outputTokens: 5,
        modelId: "claude-opus-5",
        at: 2000,
      },
      // The session switched models mid-flight — the whole point of segments.
      {
        eventId: "r3",
        kind: "delta",
        inputTokens: 30,
        outputTokens: 3,
        reasoningOutputTokens: 2,
        modelId: "gpt-5.5-codex",
        at: 3000,
      },
      // A receipt whose model was never observed lands in the null bucket.
      {
        eventId: "r4",
        kind: "delta",
        inputTokens: 7,
        outputTokens: 1,
        at: 4000,
      },
    ],
    observedRanges: [{ from: 0, to: 10_000 }],
    providerTurns: [],
    toolIntervals: [],
  });
  // Buckets sum EXACTLY to the totals — grouping never invents or drops.
  assert.equal(rollup.inputTokens, 187);
  assert.equal(rollup.outputTokens, 19);
  assert.equal(rollup.reasoningOutputTokens, 2);
  const byModel = new Map(rollup.perModel.map((b) => [b.modelId, b]));
  assert.deepEqual(byModel.get("claude-opus-5"), {
    modelId: "claude-opus-5",
    inputTokens: 150,
    outputTokens: 15,
    cacheReadTokens: 80, // reported by r1 only — field-level honesty holds
    cacheCreationTokens: null,
    cacheCreation1hTokens: null,
    reasoningOutputTokens: null, // Anthropic does not split it out — null, not 0
  });
  assert.deepEqual(byModel.get("gpt-5.5-codex"), {
    modelId: "gpt-5.5-codex",
    inputTokens: 30,
    outputTokens: 3,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheCreation1hTokens: null,
    reasoningOutputTokens: 2,
  });
  assert.deepEqual(byModel.get(null), {
    modelId: null,
    inputTokens: 7,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheCreation1hTokens: null,
    reasoningOutputTokens: null,
  });
});

test("usage: cumulative deltas attribute to the LATER receipt's model; reasoning needs both endpoints (AC2.4/AC2.7)", () => {
  const rollup = aggregateSessionUsage({
    receipts: [
      {
        eventId: "c1",
        kind: "cumulative",
        inputTokens: 1000,
        outputTokens: 100,
        reasoningOutputTokens: 10,
        at: 1000,
      },
      {
        eventId: "c2",
        kind: "cumulative",
        inputTokens: 1200,
        outputTokens: 130,
        reasoningOutputTokens: 18,
        modelId: "gpt-5.5-codex",
        at: 2000,
      },
      // Reasoning regressed on an otherwise valid interval: unreported, never negative.
      {
        eventId: "c3",
        kind: "cumulative",
        inputTokens: 1300,
        outputTokens: 140,
        reasoningOutputTokens: 5,
        modelId: "gpt-5.5-codex",
        at: 3000,
      },
    ],
    observedRanges: [{ from: 0, to: 10_000 }],
    providerTurns: [],
    toolIntervals: [],
  });
  assert.equal(rollup.inputTokens, 300); // c1→c2 (200) + c2→c3 (100)
  assert.equal(rollup.reasoningOutputTokens, 8); // c1→c2 only; c2→c3 regressed
  const bucket = rollup.perModel.find((b) => b.modelId === "gpt-5.5-codex");
  assert.deepEqual(bucket, {
    modelId: "gpt-5.5-codex",
    inputTokens: 300,
    outputTokens: 40,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cacheCreation1hTokens: null,
    reasoningOutputTokens: 8,
  });
});

test("usage: no reasoning receipt anywhere leaves the rollup field null, never 0 (AC2.7)", () => {
  const rollup = aggregateSessionUsage({
    receipts: [
      {
        eventId: "r1",
        kind: "delta",
        inputTokens: 10,
        outputTokens: 1,
        at: 1000,
      },
    ],
    observedRanges: [{ from: 0, to: 2000 }],
    providerTurns: [],
    toolIntervals: [],
  });
  assert.equal(rollup.reasoningOutputTokens, null);
  assert.equal(rollup.perModel[0]!.reasoningOutputTokens, null);
});

// ---------------------------------------------------------------------------
// Session-review-taxonomy Slice 5 (AC5.1/D9) — the opening prompt.
// ---------------------------------------------------------------------------

test("openingPromptOf: first HUMAN user text; sidechains, tool results, isMeta/isCompactSummary and command markup skipped; absent → null", async () => {
  const { openingPromptOf } =
    await import("../src/session-host/session-claude-transcript.js");
  const lines = [
    JSON.stringify({ type: "summary", summary: "meta" }),
    JSON.stringify({
      type: "user",
      isSidechain: true,
      message: { role: "user", content: "subagent turn — not the operator" },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
    }),
    // Host-synthesized user entries: flagged meta, compaction continuation,
    // and slash-command markup (which sometimes carries no flag at all).
    // None of these is the operator's ask.
    JSON.stringify({
      type: "user",
      isMeta: true,
      message: { role: "user", content: "Caveat: the messages below…" },
    }),
    JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: {
        role: "user",
        content:
          "This session is being continued from a previous conversation…",
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "<command-message>jentrix:jentrix-align</command-message>\n<command-name>/jentrix:jentrix-align</command-name>",
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "  <local-command-caveat>local</local-command-caveat>",
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "Implement the taxonomy PRD." },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "a LATER prompt — not the opener" },
    }),
  ].join("\n");
  assert.equal(openingPromptOf(lines), "Implement the taxonomy PRD.");
  assert.equal(openingPromptOf(""), null);
  assert.equal(openingPromptOf("not json\n{}"), null);
  // Block-array content works too.
  assert.equal(
    openingPromptOf(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
    ),
    "hi",
  );
});

test("usageRollup bounds missingRanges to the server schema's 200 (silent-400 heartbeat regression)", async () => {
  const { SessionBridge } = await import("../src/session-host/session-bridge.js");
  const spool = new SessionSpool(
    mkdtempSync(join(tmpdir(), "stacks-rollup-")),
    "ses_cap",
  );
  const bridge = new SessionBridge({
    jentrixBaseUrl: "https://example.invalid",
    bearer: "tm_x",
    sessionId: "ses_cap",
    provider: "claude",
    spool,
    redactor: createSessionRedactor({}),
    callTool: async () => ({}),
    log: () => undefined,
  });
  bridge.startObserving();
  // 250 receipt-less provider turns → 250 named missing ranges unbounded.
  for (let i = 0; i < 250; i += 1) {
    bridge.markTurnStarted(`turn:${i}`);
    bridge.markTurnEnded(`turn:${i}`);
  }
  // One real receipt so a usage-bearing beat would actually be sent.
  bridge.record({
    kind: "usage",
    payload: { turnId: "turn:0", input_tokens: 10, output_tokens: 2 },
  });
  const rollup = bridge.usageRollup();
  assert.ok(
    rollup.missingRanges.length <= 200,
    String(rollup.missingRanges.length),
  );
  assert.match(
    rollup.missingRanges[rollup.missingRanges.length - 1]!,
    /and \d+ more missing ranges/,
  );
  for (const range of rollup.missingRanges) {
    assert.ok(range.length <= 400);
  }
});
