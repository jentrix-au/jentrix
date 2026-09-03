import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaudeTimingTracker } from "../src/session-host/session-claude-timing.js";
import { mapClaudeTranscriptLine } from "../src/session-host/session-claude-transcript.js";

/**
 * control-room AC3.6/AC3.7 — the pairing that populates
 * providerActiveDurationMs and toolDurationMs.
 *
 * The gap report found both columns null on EVERY row ever written. The cause
 * was never the aggregator (it has always summed intervals correctly); it was
 * that nothing on the Claude path ever fed it one. These tests pin the pairing
 * rule, and especially the two cases where the easy definition would be wrong:
 * tool wait must not be billed as generation, and an unpaired interval must be
 * NAMED rather than silently dropped.
 */

const t = (iso: string) => Date.parse(iso);

test("pairs each generation segment with whatever handed the provider control", () => {
  const tracker = new ClaudeTimingTracker();
  // user asks at :00 → assistant answers at :05. Five seconds of generation.
  assert.deepEqual(
    tracker.observe({ at: t("2026-08-13T00:00:00Z"), id: "u1", role: "user" }),
    [],
  );
  const closed = tracker.observe({
    at: t("2026-08-13T00:00:05Z"),
    id: "a1",
    role: "assistant",
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.kind, "turn");
  assert.equal(closed[0]!.endedAt - closed[0]!.startedAt, 5_000);
});

test("tool WAIT is not billed as generation — the tool result is the next boundary", () => {
  // The defect this prevents: :00 user → :01 assistant calls a tool → the tool
  // runs 60s → :61 result → :62 assistant answers. Naive pairing would report
  // 61s of "provider active" for 1s of generation.
  const tracker = new ClaudeTimingTracker();
  tracker.observe({ at: t("2026-08-13T00:00:00Z"), id: "u1", role: "user" });
  const firstSegment = tracker.observe({
    at: t("2026-08-13T00:00:01Z"),
    id: "a1",
    role: "assistant",
    toolStarts: ["tu_1"],
  });
  const afterResult = tracker.observe({
    at: t("2026-08-13T00:01:01Z"),
    id: "u2",
    role: "user",
    toolEnds: ["tu_1"],
  });
  const secondSegment = tracker.observe({
    at: t("2026-08-13T00:01:02Z"),
    id: "a2",
    role: "assistant",
  });

  const turns = [...firstSegment, ...afterResult, ...secondSegment].filter(
    (i) => i.kind === "turn",
  );
  const tools = [...firstSegment, ...afterResult, ...secondSegment].filter(
    (i) => i.kind === "tool",
  );
  // Two generation segments: 1s and 1s. NOT 61s.
  assert.deepEqual(
    turns.map((i) => i.endedAt - i.startedAt),
    [1_000, 1_000],
  );
  // And the 60s belongs to the tool, measured from call to result.
  assert.deepEqual(
    tools.map((i) => i.endedAt - i.startedAt),
    [60_000],
  );
});

test("parallel tools each get their own interval", () => {
  const tracker = new ClaudeTimingTracker();
  tracker.observe({ at: t("2026-08-13T00:00:00Z"), id: "u1", role: "user" });
  tracker.observe({
    at: t("2026-08-13T00:00:01Z"),
    id: "a1",
    role: "assistant",
    toolStarts: ["tu_a", "tu_b"],
  });
  const closed = tracker.observe({
    at: t("2026-08-13T00:00:11Z"),
    id: "u2",
    role: "user",
    toolEnds: ["tu_a", "tu_b"],
  });
  const tools = closed.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 2);
  // Overlapping by design: "time spent in tools" is the sum of each tool's own
  // duration, which is what the aggregator sums and what the number means.
  assert.deepEqual(
    tools.map((i) => i.endedAt - i.startedAt),
    [10_000, 10_000],
  );
});

test("an assistant entry with no preceding boundary yields NO interval", () => {
  // A resumed transcript whose head the host never saw. Inventing a start of
  // zero would report a 56-year turn; reporting nothing is correct.
  const tracker = new ClaudeTimingTracker();
  assert.deepEqual(
    tracker.observe({
      at: t("2026-08-13T00:00:05Z"),
      id: "a1",
      role: "assistant",
    }),
    [],
  );
});

test("a tool result for a call we never saw open is ignored, not guessed", () => {
  const tracker = new ClaudeTimingTracker();
  assert.deepEqual(
    tracker.observe({
      at: t("2026-08-13T00:00:05Z"),
      id: "u1",
      role: "user",
      toolEnds: ["tu_unknown"],
    }),
    [],
  );
});

test("a tool that never returned is reported as unclosed, so the gap is named", () => {
  const tracker = new ClaudeTimingTracker();
  tracker.observe({ at: t("2026-08-13T00:00:00Z"), id: "u1", role: "user" });
  tracker.observe({
    at: t("2026-08-13T00:00:01Z"),
    id: "a1",
    role: "assistant",
    toolStarts: ["tu_hung"],
  });
  assert.deepEqual(tracker.unclosedToolIds(), ["tool:tu_hung"]);
});

test("the transcript mapper reports the timing a real line carries", () => {
  const assistant = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-08-13T00:00:05Z",
      message: {
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }],
      },
    }),
  );
  assert.equal(assistant.timing?.role, "assistant");
  assert.deepEqual(assistant.timing?.toolStarts, ["tu_1"]);
  assert.equal(assistant.modelId, "claude-opus-5");

  const user = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2026-08-13T00:00:09Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    }),
  );
  assert.deepEqual(user.timing?.toolEnds, ["tu_1"]);
});

test("an unparseable timestamp yields NO timing rather than an epoch-zero one", () => {
  const mapped = mapClaudeTranscriptLine(
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    }),
  );
  assert.equal(mapped.timing, undefined);
});
