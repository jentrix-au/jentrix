/**
 * M2 (JEN-537) — the OpenCode and Pi ledger mappers, on the figures the S0b
 * native proof recorded (task-manager reports/plugin-sync-2026-09-12/
 * m2-s0b-native-proof.md, fixtures/s0b). The stub model sent prompt 1002 /
 * completion 102 / cached 402 / reasoning 12 for OpenCode's tool step and
 * prompt 1003 / completion 103 / cached 403 / reasoning 13 for Pi's; each
 * host reported them in its own convention, and the receipts must carry the
 * same provider totals either way.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionBridge } from "../src/session-host/session-bridge.js";
import {
  SESSION_PROVIDERS,
  isSessionProvider,
  parseSessionEvent,
  serializeSessionEvent,
} from "../src/session-host/session-events.js";
import {
  ledgerOpeningPromptOf,
  mapOpenCodeHook,
  openCodeModelIdOf,
} from "../src/session-host/session-opencode-hooks.js";
import { mapPiHook, piModelIdOf } from "../src/session-host/session-pi-hooks.js";
import { createSessionRedactor } from "../src/session-host/session-redact.js";
import { SessionSpool } from "../src/session-host/session-spool.js";
import { sessionHookDir } from "../src/session-host-main.js";

function bridge(provider: "opencode" | "pi") {
  const dir = mkdtempSync(join(tmpdir(), `plugin-hooks-${provider}-`));
  return new SessionBridge({
    jentrixBaseUrl: "https://jentrix.test",
    bearer: "tm_0123456789abcdefTOKEN",
    sessionId: "ses_plugin",
    provider,
    spool: new SessionSpool(dir, "ses_plugin"),
    redactor: createSessionRedactor({ homedir: "/home/x" }),
    callTool: async () => ({}),
    traceCapture: false,
  });
}

test("the provider vocabulary carries the two plugin hosts end to end", () => {
  assert.deepEqual([...SESSION_PROVIDERS], ["claude", "codex", "opencode", "pi"]);
  assert.ok(isSessionProvider("opencode") && isSessionProvider("pi"));
  assert.equal(isSessionProvider("cursor"), false);
  for (const provider of SESSION_PROVIDERS) {
    assert.equal(
      sessionHookDir(provider, "/home/x"),
      join("/home/x", ".config", "stacks", `${provider}-sessions`),
    );
    const line = serializeSessionEvent({
      version: 1,
      sequence: 1,
      at: "2026-09-13T09:00:00.000Z",
      provider,
      kind: "session",
      payload: {},
    });
    assert.equal(parseSessionEvent(line)?.provider, provider);
  }
  assert.equal(sessionHookDir("cursor", "/home/x"), null);
});

test("OpenCode: one receipt per step-finish part, cache and reasoning added back as subsets", () => {
  // S0b run-plain-prompt: step 1 (tool-calls) reported input 600 / output 90 /
  // reasoning 12 / cache.read 402 for a stub call of prompt 1002 / completion
  // 102 / cached 402 / reasoning 12.
  const mapped = mapOpenCodeHook("Usage", {
    session_id: "ses_1",
    message_id: "msg_a",
    part_id: "prt_1",
    turn_id: "msg_user",
    model: { providerID: "jentrix-stub", modelID: "stub-model" },
    tokens: { total: 1104, input: 600, output: 90, reasoning: 12, cache: { read: 402, write: 0 } },
    cost: 0,
    finish: "tool-calls",
    at_wall: 1789290467971,
  });
  assert.equal(mapped.modelId, "jentrix-stub/stub-model");
  const [usage] = mapped.events;
  assert.equal(usage?.kind, "usage");
  assert.equal(usage?.providerEventId, "oc:part:prt_1");
  assert.equal(usage?.at, "2026-09-13T09:07:47.971Z");
  assert.deepEqual(usage?.payload, {
    kind: "delta",
    inputTokens: 1002,
    outputTokens: 102,
    cacheReadTokens: 402,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 12,
    modelId: "jentrix-stub/stub-model",
    turnId: "msg_user",
    messageId: "msg_a",
    finish: "tool-calls",
  });
  // A replayed part (fork history) carries `inherited` and yields nothing;
  // a part without an id or without counts yields nothing either.
  assert.deepEqual(
    mapOpenCodeHook("Usage", { session_id: "ses_2", part_id: "prt_9", inherited: true, tokens: { input: 1, output: 1 } }).events,
    [],
  );
  assert.deepEqual(mapOpenCodeHook("Usage", { session_id: "ses_2", tokens: { input: 1, output: 1 } }).events, []);
  assert.deepEqual(mapOpenCodeHook("Usage", { session_id: "ses_2", part_id: "p", tokens: { input: "1", output: 1 } }).events, []);
});

test("OpenCode: the same step-finish part replayed twice is ONE receipt in the rollup", () => {
  const b = bridge("opencode");
  const line = {
    session_id: "ses_1",
    message_id: "msg_a",
    part_id: "prt_dup",
    tokens: { input: 600, output: 90, reasoning: 12, cache: { read: 402, write: 0 } },
  };
  for (const e of mapOpenCodeHook("Usage", line).events) b.record(e);
  for (const e of mapOpenCodeHook("Usage", line).events) b.record(e);
  // Two records, one receipt: the totals are the single part's, not double.
  const rollup = b.usageRollup();
  assert.equal(rollup.inputTokens, 1002);
  assert.equal(rollup.outputTokens, 102);
  assert.equal(rollup.reasoningOutputTokens, 12);
});

test("Pi: one receipt per assistant entry, output already includes reasoning; compaction entries count once", () => {
  // S0b print-plain-prompt: usage {input 600, output 103, cacheRead 403,
  // cacheWrite 0, reasoning 13} for a stub call of prompt 1003 / completion 103.
  const mapped = mapPiHook("Usage", {
    session_id: "01a0",
    turn_id: "01a0:1",
    entry_id: "9af2c7ce",
    provider: "jentrix-stub",
    model: "stub-model",
    usage: { input: 600, output: 103, cacheRead: 403, cacheWrite: 0, reasoning: 13, totalTokens: 1106 },
    kind: "message",
    at_wall: "2026-09-13T09:06:11.590Z",
  });
  assert.equal(mapped.modelId, "jentrix-stub/stub-model");
  const [usage] = mapped.events;
  assert.equal(usage?.providerEventId, "pi:entry:9af2c7ce:usage");
  assert.deepEqual(usage?.payload, {
    kind: "delta",
    inputTokens: 1003,
    outputTokens: 103,
    cacheReadTokens: 403,
    cacheCreationTokens: 0,
    reasoningOutputTokens: 13,
    modelId: "jentrix-stub/stub-model",
    turnId: "01a0:1",
    messageId: "9af2c7ce",
    entryKind: "message",
  });
  // The compaction entry's own usage (S0b rpc-compact: entry 65416437) is a
  // second, distinct receipt — reported once, keyed by its entry id.
  const b = bridge("pi");
  for (const e of mapped.events) b.record(e);
  for (const e of mapPiHook("Usage", {
    session_id: "01a0",
    entry_id: "65416437",
    usage: { input: 600, output: 194, cacheRead: 494, cacheWrite: 0, reasoning: 104 },
    kind: "compaction",
  }).events) b.record(e);
  for (const e of mapPiHook("Usage", {
    session_id: "01a0",
    entry_id: "65416437",
    usage: { input: 600, output: 194, cacheRead: 494, cacheWrite: 0, reasoning: 104 },
    kind: "compaction",
  }).events) b.record(e);
  // Three records (the compaction entry twice), two receipts.
  const rollup = b.usageRollup();
  assert.equal(rollup.inputTokens, 1003 + 1094);
  assert.equal(rollup.outputTokens, 103 + 194);
  assert.equal(rollup.reasoningOutputTokens, 13 + 104);
  // Inherited entries (a fork copied them) never produce a receipt.
  assert.deepEqual(mapPiHook("Usage", { session_id: "01a0", entry_id: "e", inherited: true, usage: { input: 1, output: 1 } }).events, []);
});

test("both mappers: lifecycle, prompts, tool correlation, assistant identity and turn boundaries", () => {
  for (const [name, map] of [["opencode", mapOpenCodeHook], ["pi", mapPiHook]] as const) {
    const start = map("SessionStart", { session_id: "s", cwd: "/w", parent_session_id: "p", parent_session_file: "/f" });
    assert.equal(start.events[0]?.kind, "session");
    assert.equal((start.events[0]?.payload as { lifecycle: string }).lifecycle, "SessionStart");
    const prompt = map("UserPromptSubmit", { session_id: "s", turn_id: "t1", prompt: "do the thing", injected: true });
    assert.equal(prompt.events[0]?.kind, "user_message");
    assert.deepEqual(prompt.events[0]?.ids, { turnId: "t1" }, name);
    assert.equal((prompt.events[0]?.payload as { injected?: boolean }).injected, true);
    const tool = map("PostToolUse", {
      session_id: "s",
      turn_id: "t1",
      message_id: "m1",
      tool_use_id: "call_stub_2",
      tool_name: "bash",
      tool_input: { command: "echo jentrix-probe" },
      tool_response: name === "opencode" ? { output: "jentrix-probe\n", title: "echo" } : { text: "jentrix-probe\n", isError: false },
    });
    assert.equal(tool.events.length, 2);
    assert.equal(tool.events[0]?.ids?.toolCallId, "call_stub_2");
    assert.equal(tool.events[1]?.ids?.toolCallId, "call_stub_2");
    assert.equal(tool.events[1]?.ids?.messageId, "m1");
    assert.equal(tool.events[1]?.outcome, "ok");
    const failed = map("PostToolUse", {
      session_id: "s",
      tool_use_id: "c9",
      tool_name: "bash",
      tool_response: name === "opencode" ? { error: "boom" } : { text: "boom", isError: true },
    });
    assert.equal(failed.events[1]?.outcome, "error");
    const stop = map("Stop", { session_id: "s", turn_id: "t1", message_id: "m2", last_assistant_message: "Probe answer 4: done.", finish: "stop", stop_reason: "stop" });
    assert.equal(stop.events[0]?.kind, "assistant_message");
    assert.deepEqual(stop.events[0]?.ids, { turnId: "t1", messageId: "m2" });
    assert.equal((stop.events[0]?.payload as { messageId?: string }).messageId, "m2");
    assert.deepEqual(map("Stop", { session_id: "s" }).events, []);
    const turnStart = map("TurnStart", { session_id: "s", turn_id: "t1", at_wall: 1000 });
    assert.deepEqual(turnStart.turn, { id: "t1", phase: "started", at: 1000 });
    assert.deepEqual(turnStart.events, []);
    assert.deepEqual(map("TurnEnd", { session_id: "s", turn_id: "t1", at_wall: 1500 }).turn, { id: "t1", phase: "completed", at: 1500 });
    assert.equal(map("TurnEnd", { session_id: "s", turn_id: "t1" }).turn, null, "no wall stamp, no interval");
    const err = map("Error", { session_id: "s", name: "ProviderAuthError", message: "401" });
    assert.equal(err.events[0]?.kind, "error");
    assert.equal(err.events[0]?.outcome, "error");
    assert.deepEqual(map("SomethingNew", { session_id: "s" }).events, []);
  }
});

test("the final-output rule holds through the plugin ledgers: a Stop that carried tool calls is mid-turn", () => {
  const b = bridge("opencode");
  for (const e of mapOpenCodeHook("PostToolUse", { session_id: "s", message_id: "m1", tool_use_id: "c1", tool_name: "bash", tool_input: {}, tool_response: { output: "x" } }).events) b.record(e);
  for (const e of mapOpenCodeHook("Stop", { session_id: "s", message_id: "m1", last_assistant_message: "Now running the check.", finish: "tool-calls" }).events) b.record(e);
  // The tool call was recorded BEFORE the message text (OpenCode completes the
  // tool part first), so the message id must still pair them.
  const mid = b.finalOutputState();
  assert.equal(mid?.messageId, "m1");
  for (const e of mapOpenCodeHook("Stop", { session_id: "s", message_id: "m2", last_assistant_message: "All done.", finish: "stop" }).events) b.record(e);
  const closing = b.finalOutputState();
  assert.equal(closing?.messageId, "m2");
  assert.equal(closing?.turnClosing, true);
});

test("the opening prompt comes from the ledger's first operator prompt for THAT session, never an injected workflow", () => {
  const body = [
    JSON.stringify({ event: "SessionStart", at: "t", payload: { session_id: "a", cwd: "/w" } }),
    JSON.stringify({ event: "UserPromptSubmit", at: "t", payload: { session_id: "b", prompt: "other session" } }),
    JSON.stringify({ event: "UserPromptSubmit", at: "t", payload: { session_id: "a", prompt: "Connect this session to Jentrix …", injected: true } }),
    JSON.stringify({ event: "UserPromptSubmit", at: "t", payload: { session_id: "a", prompt: "Fix the flaky test in board.spec.ts" } }),
    "{truncated",
  ].join("\n");
  assert.equal(ledgerOpeningPromptOf(body, "a"), "Fix the flaky test in board.spec.ts");
  assert.equal(ledgerOpeningPromptOf(body, "zzz"), null);
});

test("model ids: OpenCode providerID/modelID, Pi provider/model", () => {
  assert.equal(openCodeModelIdOf({ providerID: "anthropic", modelID: "claude-sonnet-4-5" }), "anthropic/claude-sonnet-4-5");
  assert.equal(openCodeModelIdOf({ modelID: "gpt-5" }), "gpt-5");
  assert.equal(openCodeModelIdOf(null), null);
  assert.equal(piModelIdOf({ provider: "anthropic", model: "claude-sonnet-4-5" }), "anthropic/claude-sonnet-4-5");
  assert.equal(piModelIdOf({ model: "openai/gpt-5" }), "openai/gpt-5");
  assert.equal(piModelIdOf({}), null);
});
