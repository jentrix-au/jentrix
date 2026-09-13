/**
 * M2 (JEN-537) — the Pi extension itself, replayed over the S0b native
 * fixtures (test/fixtures/s0b/pi/*.probe.ndjson: the extension events Pi
 * 0.85.1 delivered to the probe, in order, with the session identity the
 * context exposed). The extension's ledger is captured in memory and mapped
 * by the host's adapter into the bridge — the same path a live watch host
 * runs — so what is asserted is the whole chain from host event to receipt.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createJentrixExtension,
  expandTemplate,
  loadCommands,
  type ExtensionApi,
} from "../plugins/pi/src/index.js";
import { SessionBridge } from "../src/session-host/session-bridge.js";
import { ledgerOpeningPromptOf } from "../src/session-host/session-opencode-hooks.js";
import { mapPiHook } from "../src/session-host/session-pi-hooks.js";
import { createSessionRedactor } from "../src/session-host/session-redact.js";
import { SessionSpool } from "../src/session-host/session-spool.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(root, "test/fixtures/s0b/pi", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);

type Handler = (event: any, ctx: any) => Promise<void> | void;
interface FakePi extends ExtensionApi {
  handlers: Map<string, Handler[]>;
  commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
  sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }>;
  emit: (event: string, payload: any, ctx: any) => Promise<void>;
}
function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map();
  const sent: FakePi["sent"] = [];
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, definition: { description: string; handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, definition);
    },
    sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
      sent.push({ message, options });
    },
  };
  return {
    handlers,
    commands,
    sent,
    emit: async (event, payload, ctx) => {
      for (const h of handlers.get(event) ?? []) await h(payload, ctx);
    },
    ...api,
  };
}

/** A Pi ExtensionContext shaped from the probe's `ident` block. */
function ctxOf(ident: Record<string, any>, branch: unknown[] = [], header: Record<string, unknown> = {}) {
  const [provider, ...rest] = String(ident.model ?? "").split("/");
  return {
    sessionManager: {
      getSessionId: () => ident.sessionId,
      getSessionFile: () => ident.sessionFile ?? undefined,
      getBranch: () => branch,
      getHeader: () => header,
    },
    mode: ident.mode,
    hasUI: ident.hasUI,
    cwd: ident.cwd,
    model: ident.model ? { provider, id: rest.join("/") } : undefined,
    waitForIdle: async () => {},
    isIdle: () => true,
  };
}

interface Line { event: string; payload: Record<string, any> }

async function replay(name: string, options: { pi?: FakePi; write?: (e: string, p: Record<string, unknown>) => void } = {}) {
  const lines: Line[] = [];
  const snapshots: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let clock = 2_000_000;
  const pi = options.pi ?? fakePi();
  if (!options.pi) {
    createJentrixExtension({
      write: options.write ?? ((event, payload) => lines.push({ event, payload: payload as Record<string, any> })),
      now: () => (clock += 100),
      commands: { "jentrix-connect": { description: "Connect this Pi session to Jentrix", template: "Run `jentrix session connect --provider pi`. Extra: $ARGUMENTS" } },
      identity: { package: "@jentrix/plugin-pi", version: "0.1.0", behaviorRevision: "rev", resourceDigest: null, dir: "/pkg" },
      spawnSnapshot: (event, payload) => snapshots.push({ event, payload }),
    })(pi);
  }
  for (const line of fixture(name)) {
    if (line.event === "factory" || String(line.event).startsWith("command.") || String(line.event).startsWith("compact.")) continue;
    const ident = line.ident ?? {};
    let branch: unknown[] = [];
    if (line.event === "turn_end" && line.message) {
      branch = [{ type: "message", id: line.entryIdOfMessage, message: line.message }];
    }
    const ctx = ctxOf(ident, branch);
    const payload: Record<string, unknown> = { ...line };
    if (line.event === "tool_execution_end" && typeof line.result === "string") {
      try {
        payload.result = JSON.parse(line.result);
      } catch {
        payload.result = { content: [{ type: "text", text: line.result }] };
      }
    }
    if (line.event === "session_compact") {
      payload.compactionEntry = { id: line.entry?.id, tokensBefore: line.entry?.tokensBefore, usage: line.entry?.usage, summary: "…" };
    }
    if (line.event === "agent_end") {
      payload.messages = (line.messages ?? []).map((role: string) => ({ role }));
    }
    await pi.emit(line.event, payload, ctx);
  }
  return { lines, snapshots, pi };
}

function bridgeFor(lines: Line[], sessionId: string) {
  const dir = mkdtempSync(join(tmpdir(), "plugin-runtime-pi-"));
  const b = new SessionBridge({
    jentrixBaseUrl: "https://jentrix.test",
    bearer: "tm_0123456789abcdefTOKEN",
    sessionId: "ses_runtime",
    provider: "pi",
    spool: new SessionSpool(dir, "ses_runtime"),
    redactor: createSessionRedactor({ homedir: "/home/x" }),
    callTool: async () => ({}),
    traceCapture: false,
  });
  const turns = new Map<string, number>();
  for (const line of lines) {
    if (line.payload.session_id !== sessionId) continue;
    const mapped = mapPiHook(line.event, line.payload);
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

test("print-plain-prompt: one session, one tool turn — ledger, identity, receipts and final output (Pi 0.85.1)", async () => {
  const { lines, snapshots } = await replay("print-plain-prompt.probe.ndjson");
  const sid = "01a09a04-59b4-7754-b7da-22d5f69ac9ee";
  assert.deepEqual(
    lines.map((l) => l.event),
    ["SessionStart", "UserPromptSubmit", "TurnStart", "PostToolUse", "Stop", "Usage", "Stop", "Usage", "TurnEnd", "SessionEnd"],
  );
  const start = lines[0]!.payload;
  assert.equal(start.session_id, sid);
  assert.match(String(start.session_file), /\.jsonl$/);
  assert.equal(start.reason, "startup");
  assert.equal(start.mode, "print");
  assert.equal(start.cwd, "<m2>/fixtures/pi-project");
  assert.equal(start.model, "stub-model");
  assert.equal(start.provider, "jentrix-stub");
  const prompt = lines[1]!.payload;
  assert.equal(prompt.prompt, "Run echo jentrix-probe with the bash tool and report the output verbatim.");
  assert.equal(prompt.source, "prompt");
  assert.equal(prompt.turn_id, `${sid}:1`);
  const tool = lines[3]!.payload;
  assert.equal(tool.tool_use_id, "call_stub_3");
  assert.equal(tool.tool_name, "bash");
  assert.deepEqual(tool.tool_input, { command: "echo jentrix-probe" });
  assert.deepEqual(tool.tool_response, { text: "jentrix-probe", isError: false });
  const stops = lines.filter((l) => l.event === "Stop").map((l) => l.payload);
  assert.equal(stops[0]!.message_id, "9af2c7ce");
  assert.equal(stops[0]!.stop_reason, "toolUse");
  assert.equal(stops[1]!.message_id, "15316c38");
  assert.equal(stops[1]!.last_assistant_message, "Probe answer 4: the command printed jentrix-probe. Done.");
  assert.equal(stops[1]!.at_wall, 1789290371596);
  assert.equal(stops[0]!.tool_calls, 1);
  assert.equal(stops[1]!.tool_calls, 0);
  const usage = lines.filter((l) => l.event === "Usage").map((l) => l.payload);
  assert.equal(usage[0]!.entry_id, "9af2c7ce");
  assert.deepEqual(usage[0]!.usage, { input: 600, output: 103, cacheRead: 403, cacheWrite: 0, reasoning: 13, totalTokens: 1106, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.equal(usage[1]!.entry_id, "15316c38");
  assert.equal(usage[1]!.kind, "message");
  assert.equal(lines.at(-1)!.payload.reason, "quit");
  assert.deepEqual(snapshots, []);

  const b = bridgeFor(lines, sid);
  const rollup = b.usageRollup();
  assert.equal(rollup.inputTokens, 1003 + 1054);
  assert.equal(rollup.outputTokens, 103 + 154);
  assert.equal(rollup.reasoningOutputTokens, 13 + 64);
  assert.equal(rollup.cacheReadTokens, 403 + 454);
  assert.equal(rollup.perModel[0]?.modelId, "jentrix-stub/stub-model");
  assert.ok((rollup.providerActiveDurationMs ?? 0) > 0, "the agent run was recorded as a turn interval");
  const final = b.finalOutputState();
  assert.equal(final?.messageId, "15316c38");
  assert.equal(final?.turnClosing, true);
  assert.equal(ledgerOpeningPromptOf(lines.map((l) => JSON.stringify({ event: l.event, payload: l.payload })).join("\n"), sid), prompt.prompt);
});

test("a registered command injects the workflow as a marked custom message, waits for idle, and its prompt is never the opening prompt", async () => {
  const pi = fakePi();
  const lines: Line[] = [];
  let clock = 3_000_000;
  createJentrixExtension({
    write: (event, payload) => lines.push({ event, payload: payload as Record<string, any> }),
    now: () => (clock += 100),
    commands: { "jentrix-connect": { description: "Connect this Pi session to Jentrix", template: "Run `jentrix session connect --provider pi`. Extra: $ARGUMENTS" } },
    identity: { package: "@jentrix/plugin-pi", version: "0.1.0", behaviorRevision: "rev", resourceDigest: null, dir: "/pkg" },
    spawnSnapshot: () => {},
  })(pi);
  assert.deepEqual([...pi.commands.keys()], ["jentrix-connect"]);
  let waited = false;
  const startLine = fixture("print-command-waitforidle.probe.ndjson").find((l) => l.event === "session_start")!;
  const ctx = { ...ctxOf(startLine.ident), waitForIdle: async () => { waited = true; } };
  await pi.emit("session_start", startLine, ctx);
  await pi.commands.get("jentrix-connect")!.handler("alpha beta", ctx);
  assert.equal(waited, true, "print mode needs the handler to hold until the turn settles (S0b)");
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0]!.message.customType, "jentrix");
  assert.equal(pi.sent[0]!.message.content, "Run `jentrix session connect --provider pi`. Extra: alpha beta");
  assert.deepEqual(pi.sent[0]!.options, { triggerTurn: true });
  // The turn the message triggered, as the probe recorded it.
  const { lines: after } = await replay("print-command-waitforidle.probe.ndjson", { pi, write: (e, p) => lines.push({ event: e, payload: p as Record<string, any> }) });
  void after;
  const prompt = lines.find((l) => l.event === "UserPromptSubmit")!.payload;
  assert.equal(prompt.injected, true);
  assert.equal(prompt.command, "jentrix-connect");
  assert.equal(prompt.source, "extension");
  const body = lines.map((l) => JSON.stringify({ event: l.event, payload: l.payload })).join("\n");
  assert.equal(ledgerOpeningPromptOf(body, String(prompt.session_id)), null);
  assert.ok(lines.some((l) => l.event === "Stop" && l.payload.last_assistant_message === "Probe answer 2: the command printed jentrix-probe. Done."));
});

test("rpc-compact: the compaction entry's usage is one more receipt, and the boundary spawns the snapshot", async () => {
  const { lines, snapshots } = await replay("rpc-compact.probe.ndjson");
  const sid = lines[0]!.payload.session_id as string;
  assert.equal(lines[0]!.payload.mode, "rpc");
  const compaction = lines.find((l) => l.event === "Usage" && l.payload.kind === "compaction")!.payload;
  assert.equal(compaction.entry_id, "65416437");
  assert.deepEqual(compaction.usage, { input: 600, output: 194, cacheRead: 494, cacheWrite: 0, reasoning: 104, totalTokens: 1288, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  assert.ok(lines.some((l) => l.event === "PostCompact" && l.payload.entry_id === "65416437"));
  assert.deepEqual(snapshots.map((s) => s.event), ["PostCompact"], "the probe registered no session_before_compact, so only the post boundary was observed");
  const rollup = bridgeFor(lines, sid).usageRollup();
  assert.equal(rollup.inputTokens, (600 + 422) + (600 + 473) + (600 + 494));
  assert.equal(rollup.outputTokens, 122 + 173 + 194);
});

test("the seven generated command files load as Pi commands; templates expand $ARGUMENTS and $n", () => {
  const commands = loadCommands(join(root, "plugins/pi/commands"));
  assert.deepEqual(Object.keys(commands).sort(), [
    "jentrix-align",
    "jentrix-checkpoint",
    "jentrix-connect",
    "jentrix-end",
    "jentrix-plan",
    "jentrix-review",
    "jentrix-status",
  ]);
  assert.match(commands["jentrix-connect"]!.description, /Connect this Pi session/);
  assert.match(commands["jentrix-align"]!.template, /jentrix session align --provider pi/);
  assert.equal(expandTemplate("a $1 b $2 c $ARGUMENTS", "x y"), "a x b y c x y");
  assert.equal(expandTemplate("none $ARGUMENTS", undefined), "none ");
});
