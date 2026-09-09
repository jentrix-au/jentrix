/**
 * JEN-494 (hardening PRD S1, D1/D12) — one usage receipt per API MESSAGE.
 *
 * Claude Code writes ONE transcript entry per content block of a streamed
 * message and repeats that message's usage on each entry. Keyed by the entry
 * uuid, a three-block message contributed three times, which is why every
 * token and cost figure Jentrix showed for a Claude session was 1.4–4.4× too
 * high (PRD §4 G1). The fixture beside this file is one such message: three
 * records, one `message.id`, ascending `output_tokens`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mapClaudeTranscriptLine } from "../src/session-host/session-claude-transcript.js";
import { SessionSkeleton } from "../src/session-host/session-skeleton.js";
import {
  aggregateSessionUsage,
  type UsageReceipt,
} from "../src/session-host/session-usage.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "claude-streamed-message.jsonl",
);

/** The fixture's three records, mapped exactly as the host maps them. */
function mappedFixture() {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => mapClaudeTranscriptLine(line));
}

/** The mapper's usage event as the bridge would turn it into a receipt. */
function receiptOf(
  mapped: ReturnType<typeof mapClaudeTranscriptLine>,
  at: number,
): UsageReceipt {
  const event = mapped.events.find((e) => e.kind === "usage")!;
  const payload = event.payload as Record<string, number | string>;
  return {
    eventId: event.providerEventId!,
    turnId: null,
    kind: "delta",
    inputTokens: payload.inputTokens as number,
    outputTokens: payload.outputTokens as number,
    cacheReadTokens: payload.cacheReadTokens as number,
    cacheCreationTokens: payload.cacheCreationTokens as number,
    cacheCreation1hTokens: payload.cacheCreation1hTokens as number,
    reasoningOutputTokens: payload.reasoningOutputTokens as number,
    modelId: payload.modelId as string,
    at,
    atWall: Date.parse(event.at!),
  };
}

test("AC1.1 — three records of one message share ONE receipt key", () => {
  const keys = mappedFixture().map(
    (m) => m.events.find((e) => e.kind === "usage")!.providerEventId,
  );
  assert.deepEqual(
    keys,
    [
      "msg_011Cerz4krHVkc9aL5379vtK",
      "msg_011Cerz4krHVkc9aL5379vtK",
      "msg_011Cerz4krHVkc9aL5379vtK",
    ].map((id) => `msg:${id}:usage`),
  );
});

test("AC1.1 — the rollup counts the message ONCE, last record winning", () => {
  const receipts = mappedFixture().map((m, i) => receiptOf(m, 1000 + i));
  const rollup = aggregateSessionUsage({
    receipts,
    observedRanges: [],
    providerTurns: [],
    toolIntervals: [],
  });
  // Naive (the defect) would be 3× everything and output 91+198+285 = 574.
  assert.equal(rollup.outputTokens, 285, "the LAST record's final output");
  assert.equal(rollup.cacheReadTokens, 10230);
  assert.equal(rollup.cacheCreationTokens, 26000);
  assert.equal(rollup.cacheCreation1hTokens, 26000);
  assert.equal(rollup.reasoningOutputTokens, 40);
  assert.equal(rollup.inputTokens, 2 + 26000 + 10230);
  assert.deepEqual(
    rollup.perModel.map((m) => [m.modelId, m.outputTokens]),
    [["claude-opus-5", 285]],
  );
});

test("AC1.1 — order does not matter: last-by-arrival is the winner", () => {
  const mapped = mappedFixture();
  const forwards = mapped.map((m, i) => receiptOf(m, 1000 + i));
  const rollup = aggregateSessionUsage({
    receipts: [...forwards].reverse(),
    observedRanges: [],
    providerTurns: [],
    toolIntervals: [],
  });
  // Reversed arrival ⇒ the FIRST fixture record is last in, and wins.
  assert.equal(rollup.outputTokens, 91);
});

test("AC1.2 — an entry without message.id keeps the per-entry receipt", () => {
  const mapped = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "no-msg-id",
      timestamp: "2026-09-09T01:18:25.897Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    }),
  );
  const usage = mapped.events.find((e) => e.kind === "usage")!;
  assert.equal(usage.providerEventId, "no-msg-id:usage");
  assert.equal(mapped.messageId, undefined);
  // ...and an old transcript stays "unreported" for what it never carried.
  const payload = usage.payload as Record<string, unknown>;
  assert.equal("cacheReadTokens" in payload, false);
  assert.equal("cacheCreation1hTokens" in payload, false);
  assert.equal("reasoningOutputTokens" in payload, false);
});

test("AC1.3 — a receipt inside a turn's interval covers it; a bare turn is NAMED", () => {
  const receipts = mappedFixture().map((m, i) => receiptOf(m, 1000 + i));
  // Two hook-opened turns on the transcript clock; only the first contains
  // the message's records. Rollout receipts carry `turnId: null` (§4 G2), so
  // this is the interval test doing the work, not the id test.
  const covered = {
    id: "turn:covered",
    startedAt: Date.parse("2026-09-09T01:18:25.000Z"),
    endedAt: Date.parse("2026-09-09T01:18:29.000Z"),
  };
  const bare = {
    id: "turn:bare",
    startedAt: Date.parse("2026-09-09T02:00:00.000Z"),
    endedAt: Date.parse("2026-09-09T02:00:10.000Z"),
  };
  const complete = aggregateSessionUsage({
    receipts,
    observedRanges: [],
    providerTurns: [covered],
    toolIntervals: [],
  });
  assert.equal(complete.coverage, "COMPLETE");
  assert.deepEqual(complete.missingRanges, []);

  const partial = aggregateSessionUsage({
    receipts,
    observedRanges: [],
    providerTurns: [covered, bare],
    toolIntervals: [],
  });
  assert.equal(partial.coverage, "PARTIAL");
  assert.deepEqual(partial.missingRanges, [
    "provider turn turn:bare carried no usable usage receipt",
  ]);
});

test("AC1.3 — a turnId match still covers a turn with no timestamp inside", () => {
  const rollup = aggregateSessionUsage({
    receipts: [
      {
        eventId: "e1",
        turnId: "turn:1",
        kind: "delta",
        inputTokens: 1,
        outputTokens: 1,
        at: 5,
      },
    ],
    observedRanges: [],
    providerTurns: [{ id: "turn:1", startedAt: 1000, endedAt: 2000 }],
    toolIntervals: [],
  });
  assert.equal(rollup.coverage, "COMPLETE");
});

test("AC1.4 — turns is the greater of user messages and provider turns", () => {
  // A `claude -p` shape: the prompt predates the attach, so NO user_message
  // event is ever observed while the provider ran four turns.
  const skeleton = new SessionSkeleton("claude");
  skeleton.observe({
    version: 1,
    sequence: 0,
    at: "2026-09-09T01:00:00.000Z",
    provider: "claude",
    kind: "assistant_message",
    payload: { text: "done" },
  });
  skeleton.noteProviderTurns(4);
  const snap = skeleton.snapshot();
  assert.equal(snap.turns, 4);
  assert.equal(snap.turnsBasis, "provider turns");

  // ...and an ordinary interactive session keeps the user-message basis.
  const chat = new SessionSkeleton("claude");
  for (let i = 0; i < 6; i += 1) {
    chat.observe({
      version: 1,
      sequence: i,
      at: "2026-09-09T01:00:00.000Z",
      provider: "claude",
      kind: "user_message",
      payload: { text: "go" },
    });
  }
  chat.noteProviderTurns(2);
  assert.equal(chat.snapshot().turns, 6);
  assert.equal(chat.snapshot().turnsBasis, "user messages");
});

test("AC1.5 — every text block of the streamed message carries its id", () => {
  const texts = mappedFixture().map((m) => {
    const event = m.events.find((e) => e.kind === "assistant_message")!;
    return event.payload as { text: string; messageId?: string };
  });
  assert.deepEqual(
    texts.map((t) => t.messageId),
    Array(3).fill("msg_011Cerz4krHVkc9aL5379vtK"),
  );
  // The bridge joins these three into the final response; the mapper's job is
  // only to say which message each block belongs to.
  assert.deepEqual(
    texts.map((t) => t.text),
    ["First block.", "Second block.", "Third block."],
  );
});
