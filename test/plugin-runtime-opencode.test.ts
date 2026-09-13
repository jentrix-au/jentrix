/**
 * M2 (JEN-537) — the OpenCode plugin itself, replayed over the S0b native
 * fixtures (test/fixtures/s0b/opencode/*.probe.ndjson: the hooks and events
 * OpenCode 1.18.9 delivered to the probe, in order). The plugin's ledger is
 * captured in memory, then mapped by the host's adapter into the bridge —
 * the same path a live watch host runs — so what is asserted is the whole
 * chain from host event to receipt.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createJentrixPlugin,
  loadCommands,
  parseCommandFile,
} from "../plugins/opencode/src/index.js";
import { SessionBridge } from "../src/session-host/session-bridge.js";
import {
  ledgerOpeningPromptOf,
  mapOpenCodeHook,
} from "../src/session-host/session-opencode-hooks.js";
import { createSessionRedactor } from "../src/session-host/session-redact.js";
import { SessionSpool } from "../src/session-host/session-spool.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(root, "test/fixtures/s0b/opencode", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);

interface Ledger {
  lines: Array<{ event: string; payload: Record<string, any> }>;
  write: (event: string, payload: Record<string, unknown>) => void;
}
function ledger(): Ledger {
  const lines: Ledger["lines"] = [];
  return { lines, write: (event, payload) => lines.push({ event, payload: payload as Record<string, any> }) };
}

/** Replay one probe log through a plugin instance; returns its ledger and env injections. */
async function replay(name: string, options: { compactOnIdle?: boolean } = {}) {
  const led = ledger();
  const snapshots: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let clock = 1_000_000;
  const plugin = createJentrixPlugin({
    write: led.write,
    now: () => (clock += 100),
    commands: { "jentrix-connect": { description: "c", template: "connect" } },
    identity: { package: "@jentrix/plugin-opencode", version: "0.1.0", behaviorRevision: "rev", resourceDigest: null, dir: "/pkg" },
    spawnSnapshot: (event, payload) => snapshots.push({ event, payload }),
  });
  let hooks: Record<string, (...args: any[]) => Promise<void>> | null = null;
  const envs: Array<Record<string, string>> = [];
  const sessionOfMessage = new Map<string, string>();
  for (const line of fixture(name)) {
    switch (line.hook) {
      case "init":
        hooks = await plugin({ directory: line.directory, worktree: line.worktree, project: { id: line.projectId } });
        break;
      case "config": {
        const cfg: { command?: Record<string, unknown> } = { command: {} };
        await hooks!.config!(cfg);
        assert.ok(cfg.command!["jentrix-connect"], "config hook registers the commands");
        break;
      }
      case "chat.message":
        await hooks!["chat.message"]!(
          { sessionID: line.sessionID, messageID: line.messageID, agent: line.agent, model: line.model },
          { message: { id: line.messageInfoId, role: line.role }, parts: line.parts },
        );
        break;
      case "command.execute.before":
        await hooks!["command.execute.before"]!({ command: line.command, sessionID: line.sessionID, arguments: line.arguments }, { parts: line.parts });
        break;
      case "tool.execute.before":
        await hooks!["tool.execute.before"]!({ tool: line.tool, sessionID: line.sessionID, callID: line.callID }, { args: line.args });
        break;
      case "tool.execute.after":
        await hooks!["tool.execute.after"]!({ tool: line.tool, sessionID: line.sessionID, callID: line.callID }, { title: line.title, output: line.output });
        break;
      case "shell.env": {
        const out = { env: {} as Record<string, string> };
        await hooks!["shell.env"]!({ cwd: line.cwd, sessionID: line.sessionID, callID: line.callID }, out);
        envs.push(out.env);
        break;
      }
      case "experimental.session.compacting":
        await hooks!["experimental.session.compacting"]!({ sessionID: line.sessionID }, { context: line.context, prompt: undefined });
        break;
      case "dispose":
        await hooks!.dispose!();
        break;
      case "event": {
        let properties: Record<string, unknown> = {};
        if (line.info) {
          if (line.type.startsWith("message.")) sessionOfMessage.set(line.info.id, line.info.sessionID);
          properties = { info: line.info };
        } else if (line.part) {
          const part = { ...line.part, sessionID: sessionOfMessage.get(line.part.messageID) ?? null };
          // The probe kept text lengths, not text: synthesise a body of the same length.
          if (part.type === "text") part.text = "t".repeat(part.textLen ?? 0);
          if (part.type === "tool") part.state = { status: part.status, input: part.input, output: part.output, time: part.time, error: part.error };
          properties = { part, delta: undefined };
        } else if (line.props) {
          properties = line.props;
        }
        await hooks!.event!({ event: { type: line.type, properties } });
        break;
      }
      default:
        break;
    }
  }
  return { ledger: led.lines, envs, snapshots };
}

function bridgeFor(lines: Ledger["lines"], sessionId: string) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-runtime-oc-"));
  const b = new SessionBridge({
    jentrixBaseUrl: "https://jentrix.test",
    bearer: "tm_0123456789abcdefTOKEN",
    sessionId: "ses_runtime",
    provider: "opencode",
    spool: new SessionSpool(dir, "ses_runtime"),
    redactor: createSessionRedactor({ homedir: "/home/x" }),
    callTool: async () => ({}),
    traceCapture: false,
  });
  const turns = new Map<string, number>();
  for (const line of lines) {
    if (line.payload.session_id !== sessionId) continue;
    const mapped = mapOpenCodeHook(line.event, line.payload);
    if (mapped.modelId) b.observeModel(mapped.modelId);
    if (mapped.turn?.phase === "started") turns.set(mapped.turn.id, mapped.turn.at);
    if (mapped.turn?.phase === "completed") {
      const startedAt = turns.get(mapped.turn.id);
      if (startedAt !== undefined) b.recordInterval({ kind: "turn", id: mapped.turn.id, startedAt, endedAt: mapped.turn.at });
    }
    for (const event of mapped.events) b.record(event);
  }
  return b;
}

test("run-plain-prompt: one session, one tool turn — ledger, identity, receipts and final output (OpenCode 1.18.9)", async () => {
  const { ledger: lines, envs, snapshots } = await replay("run-plain-prompt.probe.ndjson");
  const sid = "ses_f65fa317cffekVOcNzey50P6wQ";
  assert.deepEqual(
    lines.map((l) => l.event),
    ["SessionStart", "UserPromptSubmit", "TurnStart", "PostToolUse", "Usage", "Stop", "Usage", "Stop", "TurnEnd", "SessionEnd"],
  );
  const start = lines[0]!.payload;
  assert.equal(start.session_id, sid);
  assert.equal(start.cwd, "<m2>/fixtures/oc-probe");
  assert.equal(start.resumed, false);
  assert.equal(start.plugin.package, "@jentrix/plugin-opencode");
  const prompt = lines[1]!.payload;
  assert.equal(prompt.message_id, "msg_09a05cef4001vb7ZaAcZJiDfdp");
  assert.equal(prompt.turn_id, prompt.message_id);
  assert.match(prompt.prompt, /Run echo jentrix-probe/);
  assert.deepEqual(prompt.model, { providerID: "jentrix-stub", modelID: "stub-model" });
  assert.equal(prompt.injected, undefined);
  const tool = lines[3]!.payload;
  assert.equal(tool.tool_use_id, "call_stub_2");
  assert.equal(tool.tool_name, "bash");
  assert.deepEqual(tool.tool_input, { command: "echo jentrix-probe" });
  assert.equal(tool.tool_response.output, "jentrix-probe\n");
  assert.equal(tool.message_id, "msg_09a05cfa8001so4fkAkVCpxPra");
  const [usage1, usage2] = lines.filter((l) => l.event === "Usage").map((l) => l.payload);
  assert.deepEqual(usage1!.tokens, { total: 1104, input: 600, output: 90, reasoning: 12, cache: { write: 0, read: 402 } });
  assert.equal(usage1!.finish, "tool-calls");
  assert.equal(usage1!.inherited, undefined);
  assert.equal(usage2!.part_id, "prt_09a05d2ac001MHtrCuxKh1wa4Z");
  assert.deepEqual(usage2!.model, { providerID: "jentrix-stub", modelID: "stub-model" });
  const stops = lines.filter((l) => l.event === "Stop").map((l) => l.payload);
  assert.equal(stops[0]!.last_assistant_message, "", "the tool-calling message carried no text");
  assert.equal(stops[0]!.tool_calls, 1);
  assert.equal(stops[1]!.tool_calls, 0);
  assert.equal(stops[1]!.message_id, "msg_09a05d284001aIFqCQgo1oWsoD");
  assert.equal(stops[1]!.finish, "stop");
  assert.equal(stops[1]!.at_wall, 1789290468014);
  assert.equal(lines.at(-1)!.payload.reason, "dispose");
  // D4: the shell.env hook handed the session id to the bash command.
  assert.deepEqual(envs, [{ OPENCODE_SESSION_ID: sid, JENTRIX_PROVIDER: "opencode" }]);
  assert.deepEqual(snapshots, []);

  // Through the host's adapter and bridge: two receipts, provider totals.
  const b = bridgeFor(lines, sid);
  const rollup = b.usageRollup();
  assert.equal(rollup.inputTokens, 1002 + 1053);
  assert.equal(rollup.outputTokens, 102 + 153);
  assert.equal(rollup.reasoningOutputTokens, 12 + 63);
  assert.equal(rollup.cacheReadTokens, 402 + 453);
  assert.equal(rollup.perModel[0]?.modelId, "jentrix-stub/stub-model");
  assert.ok((rollup.providerActiveDurationMs ?? 0) > 0, "the turn interval was recorded");
  const final = b.finalOutputState();
  assert.equal(final?.messageId, "msg_09a05d284001aIFqCQgo1oWsoD");
  assert.equal(final?.turnClosing, true);
  assert.equal(ledgerOpeningPromptOf(lines.map((l) => JSON.stringify({ event: l.event, payload: l.payload })).join("\n"), sid)?.slice(0, 20), "\"Run echo jentrix-pr");
});

test("run-command: a config-hook command marks its prompt injected, so it is never the opening prompt", async () => {
  const { ledger: lines } = await replay("run-command.probe.ndjson");
  const prompt = lines.find((l) => l.event === "UserPromptSubmit")!.payload;
  assert.equal(prompt.injected, true);
  assert.equal(prompt.command, "jentrix-probe");
  assert.equal(prompt.arguments, '"arg-one arg-two"');
  assert.equal(prompt.agent, "build");
  const body = lines.map((l) => JSON.stringify({ event: l.event, payload: l.payload })).join("\n");
  assert.equal(ledgerOpeningPromptOf(body, prompt.session_id), null);
  const events = mapOpenCodeHook("UserPromptSubmit", prompt).events;
  assert.equal((events[0]!.payload as { injected?: boolean }).injected, true);
});

test("serve: two sessions in one process stay apart; compaction boundaries fire; a fork's replayed history is inherited and yields no receipt", async () => {
  const { ledger: lines, snapshots } = await replay("serve-two-sessions-compact-fork.probe.ndjson");
  const a = "ses_f65f694d0ffe4W7soZQ4QyGj1G";
  const bId = "ses_f65f69090ffeB6LPfXujQk0d51";
  const fork = "ses_f65f6882bffeCdY14H3JyXfjUJ";
  const per = (sid: string) => lines.filter((l) => l.payload.session_id === sid);
  assert.deepEqual(per(a).map((l) => l.event).slice(0, 4), ["SessionStart", "UserPromptSubmit", "TurnStart", "PostToolUse"]);
  assert.deepEqual(per(bId).map((l) => l.event).slice(0, 4), ["SessionStart", "UserPromptSubmit", "TurnStart", "PostToolUse"]);
  // Compaction on A: the experimental hook and the compacted event, both spawning a snapshot.
  assert.ok(per(a).some((l) => l.event === "PreCompact"));
  assert.ok(per(a).some((l) => l.event === "PostCompact"));
  assert.deepEqual(snapshots.map((s) => s.event), ["PreCompact", "PostCompact"]);
  assert.deepEqual(snapshots[0]!.payload, { session_id: a, cwd: "<m2>/fixtures/oc-probe" });
  // A's receipts: two turn steps + the compaction summary step.
  const usageA = per(a).filter((l) => l.event === "Usage");
  assert.equal(usageA.length, 3);
  assert.ok(usageA.every((l) => l.payload.inherited === undefined));
  assert.equal(bridgeFor(lines, a).usageRollup().inputTokens, 1017 + 1068 + 1091);
  // The fork replayed A's history with new ids and A's timestamps: every
  // copied Usage/Stop is inherited, and the adapter records NO receipt for it.
  const forkLines = per(fork);
  assert.equal(forkLines[0]!.event, "SessionStart");
  assert.equal(forkLines[0]!.payload.title, "serve probe A (fork #1)");
  const forkUsage = forkLines.filter((l) => l.event === "Usage");
  assert.equal(forkUsage.length, 3);
  assert.ok(forkUsage.every((l) => l.payload.inherited === true), "replayed step-finish parts are inherited");
  assert.ok(forkLines.filter((l) => l.event === "Stop").every((l) => l.payload.inherited === true));
  assert.equal(bridgeFor(lines, fork).usageRollup().inputTokens, null);
  // Session B's rollup is B's alone.
  assert.equal(bridgeFor(lines, bId).usageRollup().inputTokens, 1019 + 1070);
  // No dispose on a SIGTERM'd server: no SessionEnd lines (S0b).
  assert.equal(lines.filter((l) => l.event === "SessionEnd").length, 0);
});

test("the seven generated command files load as OpenCode commands", () => {
  const commands = loadCommands(join(root, "plugins/opencode/commands"));
  assert.deepEqual(Object.keys(commands).sort(), [
    "jentrix-align",
    "jentrix-checkpoint",
    "jentrix-connect",
    "jentrix-end",
    "jentrix-plan",
    "jentrix-review",
    "jentrix-status",
  ]);
  assert.match(commands["jentrix-connect"]!.description, /Connect this OpenCode session/);
  assert.match(commands["jentrix-connect"]!.template, /jentrix session connect --provider opencode/);
  assert.doesNotMatch(commands["jentrix-connect"]!.template, /^---/);
  assert.deepEqual(parseCommandFile("no frontmatter\n"), { description: "", template: "no frontmatter" });
});
