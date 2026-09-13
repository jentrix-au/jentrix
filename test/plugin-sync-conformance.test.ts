/**
 * plugin-sync G03 — the SHARED semantic scenarios, run through every enrolled
 * adapter. Each scenario is a corrected audit behaviour (R01–R08 of
 * prds/opencode-pi-plugins-prd.md §4.1) asserted as the DESIRED contract: a
 * defect the JEN-528 audit observed fails here until it is fixed, and is never
 * grandfathered as a passing expectation. Registered by id in
 * plugins/registry.json (`scenarios`); a host that does not observe a class of
 * event states it in its capability snapshot instead of silently passing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionBridge } from "../src/session-host/session-bridge.js";
import { mapClaudeTranscriptLine } from "../src/session-host/session-claude-transcript.js";
import { mapCodexHook } from "../src/session-host/session-codex-hooks.js";
import { createSessionRedactor } from "../src/session-host/session-redact.js";
import { SessionSkeleton } from "../src/session-host/session-skeleton.js";
import { SessionSpool } from "../src/session-host/session-spool.js";
import { parseSemanticHeader } from "../src/session-host/semantic-header.js";
import { buildVerificationReceipt } from "../src/commands/push.js";
import { boundedOpeningPrompt } from "../src/session-host/session-host.js";

const redactor = createSessionRedactor({ homedir: "/home/x" });

function bridge(provider: "claude" | "codex", captured: Array<{ url: string; body: unknown }>) {
  const dir = mkdtempSync(join(tmpdir(), `conformance-${provider}-`));
  const spool = new SessionSpool(dir, "ses_conf");
  const b = new SessionBridge({
    jentrixBaseUrl: "https://jentrix.test",
    bearer: "tm_0123456789abcdefTOKEN",
    sessionId: "ses_conf",
    provider,
    spool,
    redactor,
    callTool: async () => ({}),
    traceCapture: false,
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(JSON.stringify({ artifactId: `art_${captured.length}` }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { b, spoolDir: spool.directory };
}

function claudeAssistant(uuid: string, messageId: string, blocks: unknown[], at = "2026-09-12T09:00:00.000Z") {
  return JSON.stringify({ type: "assistant", uuid, timestamp: at, message: { id: messageId, role: "assistant", model: "claude-x", content: blocks, usage: { input_tokens: 1, output_tokens: 1 } } });
}

// ---------------------------------------------------------------------------
// S-R01-final-output-identity / S-R01-progress-note-not-final
// ---------------------------------------------------------------------------

test("S-R01-final-output-identity [claude]: the closing output carries message identity, an attempt id and a durable pending→acked state", async () => {
  const captured: Array<{ url: string; body: { body?: string } }> = [];
  const { b, spoolDir } = bridge("claude", captured);
  for (const line of [
    claudeAssistant("u1", "msg_1", [{ type: "text", text: "working" }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a.ts" } }]),
    claudeAssistant("u2", "msg_2", [{ type: "text", text: "All done — the fix is in." }], "2026-09-12T09:01:00.000Z"),
  ]) for (const e of mapClaudeTranscriptLine(line).events) b.record(e);
  const state = b.finalOutputState();
  assert.equal(state?.messageId, "msg_2");
  assert.equal(state?.state, "provisional"); // the host never certifies an explicit final
  assert.equal(state?.turnClosing, true);
  const first = await b.pushFinalResponse();
  assert.ok(first?.artifactId);
  assert.equal(first?.delivery, "acked");
  const header = parseSemanticHeader(captured[0]!.body.body ?? "");
  assert.equal(header?.kind, "final-output");
  assert.equal(header?.messageId, "msg_2");
  assert.equal(header?.state, "provisional");
  assert.ok(typeof header?.attemptId === "string" && header.attemptId.length > 8);
  // Durable: the pending/acked record survives in the spool.
  const record = JSON.parse(readFileSync(join(spoolDir, "final-output.json"), "utf8"));
  assert.equal(record.delivery, "acked");
  assert.equal(record.artifactId, first?.artifactId);
  // Idempotent retry of the SAME message: no second upload.
  const again = await b.pushFinalResponse();
  assert.equal(again?.artifactId, first?.artifactId);
  assert.equal(captured.length, 1);
});

test("S-R01-progress-note-not-final [claude]: a last message that carried tool calls is mid-turn, never a turn-closing final", () => {
  const captured: never[] = [];
  const { b } = bridge("claude", captured);
  for (const line of [
    claudeAssistant("u1", "msg_1", [{ type: "text", text: "Now the card comments naming commit, test and before/after." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "jentrix comment create" } }]),
  ]) for (const e of mapClaudeTranscriptLine(line).events) b.record(e);
  const state = b.finalOutputState();
  assert.equal(state?.turnClosing, false);
  assert.match(state?.reason ?? "", /tool call/);
});

test("S-R01-final-output-identity [codex]: the Stop hook's last assistant message carries turn identity", async () => {
  const captured: Array<{ url: string; body: { body?: string } }> = [];
  const { b } = bridge("codex", captured);
  for (const e of mapCodexHook("Stop", { last_assistant_message: "Done.", turn_id: "turn_9" }).events) b.record(e);
  const state = b.finalOutputState();
  assert.equal(state?.turnId, "turn_9");
  assert.equal(state?.turnClosing, true);
  const pushed = await b.pushFinalResponse();
  assert.equal(parseSemanticHeader(captured[0]!.body.body ?? "")?.turnId, "turn_9");
  assert.equal(pushed?.delivery, "acked");
});

// ---------------------------------------------------------------------------
// S-R03-receipt-structure
// ---------------------------------------------------------------------------

test("S-R03-receipt-structure: an attested log opens with a structured receipt, and `echo` is not a gate", () => {
  const receipt = buildVerificationReceipt({
    command: "pnpm test:mvp",
    exitCode: 0,
    output: "ok",
    cwd: "/repo",
    repo: { ownerName: "acme/api", revision: "abc123", dirtyDigest: "d1" },
    startedAt: "2026-09-12T09:00:00.000Z",
    endedAt: "2026-09-12T09:01:00.000Z",
    resolveScript: (_m, name) => (name === "test:mvp" ? { body: "STACKS_UNIT_LANE=product vitest run" } : null),
  });
  const header = parseSemanticHeader(receipt);
  assert.equal(header?.kind, "verification-receipt");
  assert.equal(header?.exitCode, 0);
  assert.equal(header?.outcome, "success");
  assert.equal(header?.revision, "abc123");
  assert.equal(header?.gateExecutable, "pnpm");
  assert.equal(header?.gateSource, "script");
  assert.deepEqual(header?.gateFamilies, ["test"]);
  // F01: the script definition rides the receipt — name, body, sha256.
  const scripts = header?.gateScripts as Array<Record<string, unknown>>;
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]!.name, "test:mvp");
  assert.equal(scripts[0]!.body, "STACKS_UNIT_LANE=product vitest run");
  assert.match(String(scripts[0]!.digest), /^[0-9a-f]{64}$/);
  const echo = parseSemanticHeader(
    buildVerificationReceipt({ command: "echo pnpm test", exitCode: 0, output: "pnpm test", cwd: "/repo", repo: null, startedAt: "t", endedAt: "t" }),
  );
  assert.equal(echo?.gateExecutable, "echo");
  assert.equal(echo?.gateAllowlisted, false);
  assert.deepEqual(echo?.gateFamilies, []);
});

// ---------------------------------------------------------------------------
// S-R05-image-only-input / S-R05-tool-correlation
// ---------------------------------------------------------------------------

test("S-R05-image-only-input [claude]: an image-only user entry is OBSERVED as an attachment, never dropped as recognized-empty", () => {
  const mapped = mapClaudeTranscriptLine(
    JSON.stringify({ type: "user", uuid: "u9", timestamp: "2026-09-12T09:00:00.000Z", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } }),
  );
  assert.equal(mapped.unrecognized, false);
  assert.equal(mapped.events.length, 1);
  assert.equal(mapped.events[0]!.kind, "user_message");
  assert.deepEqual(mapped.events[0]!.attachments, [{ kind: "image", mediaType: "image/png" }]);
});

test("S-R05-tool-correlation [claude+codex]: tool calls and results carry the common toolCallId", () => {
  const claude = mapClaudeTranscriptLine(claudeAssistant("u1", "msg_1", [{ type: "tool_use", id: "tu_77", name: "Read", input: { file_path: "a.ts" } }]));
  assert.equal(claude.events.find((e) => e.kind === "tool_call")?.ids?.toolCallId, "tu_77");
  assert.equal(claude.events.find((e) => e.kind === "tool_call")?.ids?.messageId, "msg_1");
  const codex = mapCodexHook("PostToolUse", { tool_name: "shell", tool_input: { cmd: "ls" }, tool_response: { exit_code: 0 }, tool_use_id: "call_5", turn_id: "turn_1" });
  assert.equal(codex.events.find((e) => e.kind === "tool_call")?.ids?.toolCallId, "call_5");
  assert.equal(codex.events.find((e) => e.kind === "tool_result")?.ids?.toolCallId, "call_5");
  assert.equal(codex.events.find((e) => e.kind === "tool_result")?.outcome, "ok");
  const failed = mapCodexHook("PostToolUse", { tool_name: "shell", tool_input: { cmd: "false" }, tool_response: { exit_code: 1 }, tool_use_id: "call_6" });
  assert.equal(failed.events.find((e) => e.kind === "tool_result")?.outcome, "error");
});

// ---------------------------------------------------------------------------
// S-R06-skeleton-*
// ---------------------------------------------------------------------------

test("S-R06-skeleton-cmd-and-absolute-paths: `cmd` and `command` both count, absolute and relative paths both count", () => {
  const s = new SessionSkeleton("codex");
  const at = "2026-09-12T09:00:00.000Z";
  s.observe({ version: 1, sequence: 0, at, provider: "codex", kind: "tool_call", payload: { name: "shell", input: { cmd: "cat /Users/x/repo/src/important.ts" } } });
  s.observe({ version: 1, sequence: 1, at, provider: "codex", kind: "tool_call", payload: { name: "shell", input: { command: "sed -n 1,5p src/other.ts" } } });
  const snap = s.snapshot();
  assert.deepEqual(snap.filesTouched.paths.sort(), ["/Users/x/repo/src/important.ts", "src/other.ts"]);
  assert.equal(snap.filesTouched.total, 2);
});

test("S-R06-skeleton-overflow-exact: repeated overflow paths never inflate the distinct total", () => {
  const s = new SessionSkeleton("claude");
  const at = "2026-09-12T09:00:00.000Z";
  for (let i = 0; i < 301; i++) {
    s.observe({ version: 1, sequence: i, at, provider: "claude", kind: "tool_call", payload: { name: "Read", input: { file_path: `src/f${i}.ts` } } });
  }
  for (let i = 0; i < 9; i++) {
    s.observe({ version: 1, sequence: 400 + i, at, provider: "claude", kind: "tool_call", payload: { name: "Read", input: { file_path: "src/f300.ts" } } });
  }
  const snap = s.snapshot();
  assert.equal(snap.filesTouched.total, 301);
  assert.equal(snap.filesTouched.totalExact, true);
});

// ---------------------------------------------------------------------------
// S-R07-prompt-truncation-declared
// ---------------------------------------------------------------------------

test("S-R07-prompt-truncation-declared: a capped opening prompt states original and retained bytes", () => {
  const big = "x".repeat(70 * 1024);
  const bounded = boundedOpeningPrompt(big);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.originalBytes, 70 * 1024);
  assert.ok(bounded.retainedBytes <= 64 * 1024);
  assert.match(bounded.body, /\[truncated: opening prompt was 71680 bytes; 6\d{4} retained/);
  const small = boundedOpeningPrompt("hello");
  assert.equal(small.truncated, false);
  assert.equal(small.body, "hello");
});
