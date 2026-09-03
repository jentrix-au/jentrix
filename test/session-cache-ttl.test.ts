/**
 * Model-catalog PRD D7 (JEN-289) — the cache-write TTL split and thinking
 * tokens the Claude Code transcript already carries, read from golden
 * entries: one with the split (every write 1-hour, the inspected session's
 * shape), one WITHOUT (an older transcript — the field stays absent, never 0),
 * one with both tiers non-zero.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { mapClaudeTranscriptLine } from "../src/session-host/session-claude-transcript.js";
import { aggregateSessionUsage } from "../src/session-host/session-usage.js";

const GOLDEN = join(
  import.meta.dirname,
  "golden",
  "claude-transcript-cache-ttl.jsonl",
);
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n");
const usageOf = (line: string) =>
  mapClaudeTranscriptLine(line).events.find((e) => e.kind === "usage")
    ?.payload as Record<string, unknown>;

test("golden: an entry with the split reports the 1-hour subset and the thinking tokens", () => {
  assert.deepEqual(usageOf(lines[0]!), {
    kind: "delta",
    inputTokens: 115549,
    outputTokens: 42,
    cacheReadTokens: 110000,
    cacheCreationTokens: 5546,
    cacheCreation1hTokens: 5546, // 5m 0 · 1h 5546 — Claude Code's default TTL
    reasoningOutputTokens: 30,
    modelId: "claude-fable-5-1",
  });
});

test("golden: an entry WITHOUT the split leaves both fields absent — never 0", () => {
  const usage = usageOf(lines[1]!);
  assert.deepEqual(usage, {
    kind: "delta",
    inputTokens: 9003,
    outputTokens: 42,
    cacheReadTokens: 8000,
    cacheCreationTokens: 1000,
    modelId: "claude-fable-5-1",
  });
  assert.equal("cacheCreation1hTokens" in usage, false);
  assert.equal("reasoningOutputTokens" in usage, false);
});

test("golden: both tiers non-zero — the 1-hour figure is the SUBSET, the total stays the total", () => {
  const usage = usageOf(lines[2]!);
  assert.equal(usage.cacheCreationTokens, 1000);
  assert.equal(usage.cacheCreation1hTokens, 900);
  // A reported zero IS a report: thinking_tokens 0 maps to 0, not absent.
  assert.equal(usage.reasoningOutputTokens, 0);
});

test("the rollup carries the 1-hour subset per model, under the same field-level honesty", () => {
  const rollup = aggregateSessionUsage({
    receipts: lines.map((line, i) => ({
      eventId: `g${i}`,
      kind: "delta" as const,
      ...(usageOf(line) as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        cacheCreation1hTokens?: number;
        reasoningOutputTokens?: number;
        modelId?: string;
      }),
      at: 1000 + i,
    })),
    observedRanges: [{ from: 0, to: 10_000 }],
    providerTurns: [],
    toolIntervals: [],
  });
  assert.equal(rollup.cacheCreationTokens, 7546);
  // Only the two receipts that REPORTED the split contribute to it.
  assert.equal(rollup.cacheCreation1hTokens, 6446);
  assert.equal(rollup.reasoningOutputTokens, 30);
  assert.equal(rollup.perModel[0]!.cacheCreation1hTokens, 6446);

  // Cumulative receipts: both-reported, non-negative delta — a regressing
  // counter reads as unreported for that interval, never as negative usage.
  const cumulative = aggregateSessionUsage({
    receipts: [
      {
        eventId: "c1",
        kind: "cumulative",
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 50,
        cacheCreation1hTokens: 40,
        at: 1000,
      },
      {
        eventId: "c2",
        kind: "cumulative",
        inputTokens: 200,
        outputTokens: 20,
        cacheCreationTokens: 80,
        cacheCreation1hTokens: 70,
        at: 2000,
      },
      {
        eventId: "c3",
        kind: "cumulative",
        inputTokens: 300,
        outputTokens: 30,
        cacheCreationTokens: 90,
        cacheCreation1hTokens: 10, // regressed — this interval attributes nothing
        at: 3000,
      },
    ],
    observedRanges: [{ from: 0, to: 10_000 }],
    providerTurns: [],
    toolIntervals: [],
  });
  assert.equal(cumulative.cacheCreationTokens, 40);
  assert.equal(cumulative.cacheCreation1hTokens, 30);

  // No receipt ever carried the split → null, not 0.
  const none = aggregateSessionUsage({
    receipts: [
      {
        eventId: "n1",
        kind: "delta",
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 5,
        at: 1,
      },
    ],
    observedRanges: [{ from: 0, to: 10 }],
    providerTurns: [],
    toolIntervals: [],
  });
  assert.equal(none.cacheCreation1hTokens, null);
  assert.equal(none.perModel[0]!.cacheCreation1hTokens, null);
});
