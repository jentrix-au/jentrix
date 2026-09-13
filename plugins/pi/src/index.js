// @jentrix/plugin-pi — the official Jentrix package for Pi (M2, JEN-537).
// One extension that runs INSIDE Pi and does two things:
//
//  1. registers the seven `/jentrix-*` commands through `pi.registerCommand`;
//     each handler injects the generated workflow as a MARKED custom message
//     (`customType: "jentrix"`, D5) and waits for the turn it triggers —
//     print mode returns from prompt() the moment the handler resolves (S0b);
//  2. appends one NDJSON line per observed extension event to the provider
//     ledger (`~/.config/stacks/pi-sessions/hooks.ndjson`), the same shape
//     the Claude/Codex hook forwarder writes, which the CLI's watch host tails
//     and maps (src/session-host/session-pi-hooks.ts). Identity comes from
//     Pi itself: `PI_SESSION_ID`/`PI_SESSION_FILE` in every bash command.
//
// Token semantics from the S0b native proof on Pi 0.85.1: one `usage` per
// finalised assistant message whose ENTRY id exists only at `turn_end` (so
// the receipt is written there), one per compaction / branch-summary entry,
// `output` already including reasoning. Forked or switched history is
// copied with its original entry ids and produces no live event — nothing
// inherited is ever recharged.
//
// Zero dependencies, no network; the only process it starts is
// `jentrix session snapshot` at compaction boundaries.

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER = "pi";
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_CAP = 64 * 1024;
const PATH_CAP = 4096;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function pluginIdentity(packageDir = PACKAGE_DIR) {
  const pkg = readJson(join(packageDir, "package.json"));
  const manifest = readJson(join(packageDir, "manifest.json"));
  return {
    package: pkg.name ?? "@jentrix/plugin-pi",
    version: pkg.version ?? manifest.version ?? null,
    behaviorRevision: pkg.jentrix?.behaviorRevision ?? null,
    resourceDigest: pkg.jentrix?.resourceDigest ?? null,
    dir: packageDir,
  };
}

export function ledgerDir(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, ".config", "stacks", `${PROVIDER}-sessions`);
}

function hookEnv(env = process.env) {
  const path = env.PATH ?? env.Path ?? null;
  return {
    path: path === null ? null : path.slice(0, PATH_CAP),
    execPath: process.execPath,
    argv0: process.argv0,
    script: process.argv[1] ?? null,
  };
}

export function createLedgerWriter(options = {}) {
  const dir = options.dir ?? ledgerDir(options.env);
  const now = options.now ?? (() => new Date());
  const env = hookEnv(options.env);
  let ready = false;
  return (event, payload) => {
    if (!ready) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ready = true;
    }
    appendFileSync(
      join(dir, "hooks.ndjson"),
      `${JSON.stringify({ event, at: now().toISOString(), payload, env })}\n`,
      { mode: 0o600 },
    );
  };
}

export function parseCommandFile(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { description: "", template: text.trim() };
  const description =
    /^description:\s*(.*)$/m.exec(match[1])?.[1]?.trim() ?? "";
  return { description, template: text.slice(match[0].length).trim() };
}

export function loadCommands(dir = join(PACKAGE_DIR, "commands")) {
  const commands = {};
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^jentrix-[a-z]+\.md$/.test(f));
  } catch {
    return commands;
  }
  for (const file of files.sort()) {
    const { description, template } = parseCommandFile(
      readFileSync(join(dir, file), "utf8"),
    );
    commands[file.replace(/\.md$/, "")] = { description, template };
  }
  return commands;
}

/** `$ARGUMENTS`/`$@` and `$1..$n`, the way Pi's own prompt templates expand. */
export function expandTemplate(template, args) {
  const words = (args ?? "").trim() ? args.trim().split(/\s+/) : [];
  return template
    .replaceAll("$ARGUMENTS", args ?? "")
    .replaceAll("$@", args ?? "")
    .replace(/\$(\d+)/g, (_, n) => words[Number(n) - 1] ?? "");
}

function cap(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length > OUTPUT_CAP
    ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated by the Jentrix extension at ${OUTPUT_CAP} bytes]`
    : text;
}

function textBlocks(content) {
  if (typeof content === "string") return content.trim();
  return (content ?? [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function modelOf(ctx, fallback) {
  const m = ctx?.model;
  if (m && (m.id || m.provider)) return { provider: m.provider ?? null, model: m.id ?? null };
  return fallback;
}

/**
 * Build the extension. `options` exist for the runtime fixture tests (an
 * injected ledger writer, clock, snapshot spawner and command set); Pi gets
 * the defaults through the default export.
 */
export function createJentrixExtension(options = {}) {
  const write = options.write ?? createLedgerWriter(options);
  const now = options.now ?? (() => Date.now());
  const commands = options.commands ?? loadCommands(options.commandsDir);
  const identity = options.identity ?? pluginIdentity();
  const spawnSnapshot =
    options.spawnSnapshot ??
    ((event, payload, cwd) => {
      try {
        const child = spawn("jentrix", ["session", "snapshot", "--event", event], {
          cwd,
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", () => {});
        child.stdin.end(JSON.stringify(payload));
      } catch {
        // No CLI on PATH: the boundary is still in the ledger.
      }
    });

  return function jentrixPiExtension(pi) {
    const state = {
      sessionId: null,
      sessionFile: null,
      cwd: null,
      model: null,
      turnCounter: 0,
      turnId: null,
      pendingPrompt: null,
      started: false,
    };
    /** toolCallId → { toolName, args } */
    const tools = new Map();

    const sid = (ctx) => {
      try {
        return ctx?.sessionManager?.getSessionId?.() ?? state.sessionId;
      } catch {
        return state.sessionId;
      }
    };
    const refresh = (ctx) => {
      const id = sid(ctx);
      if (id) state.sessionId = id;
      try {
        state.sessionFile = ctx?.sessionManager?.getSessionFile?.() ?? state.sessionFile;
      } catch {
        // in-memory session
      }
      if (ctx?.cwd) state.cwd = ctx.cwd;
      state.model = modelOf(ctx, state.model);
      return state.sessionId;
    };
    const base = () => ({
      session_id: state.sessionId,
      ...(state.sessionFile ? { session_file: state.sessionFile } : {}),
      ...(state.model?.model ? { model: state.model.model } : {}),
      ...(state.model?.provider ? { provider: state.model.provider } : {}),
    });
    const startTurn = () => {
      state.turnCounter += 1;
      state.turnId = `${state.sessionId}:${state.turnCounter}`;
      return state.turnId;
    };
    const entryIdOf = (ctx, message) => {
      try {
        const branch = ctx.sessionManager.getBranch();
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry?.type === "message" && entry.message === message) return entry.id ?? null;
        }
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (
            entry?.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message?.timestamp === message?.timestamp
          ) {
            return entry.id ?? null;
          }
        }
      } catch {
        // no branch access: the receipt keeps the turn id only
      }
      return null;
    };

    pi.on("session_start", async (event, ctx) => {
      const id = refresh(ctx);
      if (!id) return;
      state.turnCounter = 0;
      state.turnId = null;
      state.started = true;
      let parent = null;
      try {
        parent = ctx.sessionManager.getHeader?.()?.parentSession ?? null;
      } catch {
        parent = null;
      }
      write("SessionStart", {
        ...base(),
        cwd: state.cwd ?? process.cwd(),
        reason: event?.reason ?? null,
        ...(event?.previousSessionFile ? { previous_session_file: event.previousSessionFile } : {}),
        ...(parent ? { parent_session_file: parent } : {}),
        mode: ctx?.mode ?? null,
        plugin: identity,
        at_wall: now(),
      });
    });
    pi.on("session_shutdown", async (event, ctx) => {
      refresh(ctx);
      if (!state.sessionId) return;
      if (state.turnId) {
        write("TurnEnd", { ...base(), turn_id: state.turnId, at_wall: now() });
        state.turnId = null;
      }
      write("SessionEnd", { ...base(), reason: event?.reason ?? null, at_wall: now() });
      state.started = false;
    });
    pi.on("model_select", async (event) => {
      if (event?.model) state.model = { provider: event.model.provider ?? null, model: event.model.id ?? null };
    });
    pi.on("before_agent_start", async (event, ctx) => {
      refresh(ctx);
      // The operator's prompt for the run about to start; the injected
      // command path sets its own pending prompt in the handler.
      if (!state.pendingPrompt) state.pendingPrompt = { prompt: cap(event?.prompt ?? ""), source: "prompt" };
    });
    pi.on("agent_start", async (_event, ctx) => {
      refresh(ctx);
      if (!state.sessionId) return;
      const turnId = startTurn();
      const pending = state.pendingPrompt;
      state.pendingPrompt = null;
      if (pending) {
        write("UserPromptSubmit", {
          ...base(),
          turn_id: turnId,
          prompt: pending.prompt,
          source: pending.source,
          ...(pending.injected ? { injected: true, command: pending.command } : {}),
          at_wall: now(),
        });
      }
      write("TurnStart", { ...base(), turn_id: turnId, at_wall: now() });
    });
    pi.on("agent_end", async (event, ctx) => {
      refresh(ctx);
      if (!state.turnId) return;
      const last = (event?.messages ?? []).slice(-1)[0];
      if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
        write("Error", {
          ...base(),
          turn_id: state.turnId,
          name: last.stopReason,
          ...(last.errorMessage ? { message: cap(last.errorMessage) } : {}),
          at_wall: now(),
        });
      }
      write("TurnEnd", { ...base(), turn_id: state.turnId, at_wall: now() });
      state.turnId = null;
    });
    pi.on("tool_execution_start", async (event) => {
      if (event?.toolCallId) tools.set(event.toolCallId, { toolName: event.toolName, args: event.args ?? null });
    });
    pi.on("tool_execution_end", async (event, ctx) => {
      refresh(ctx);
      if (!event?.toolCallId) return;
      const t = tools.get(event.toolCallId) ?? { toolName: event.toolName, args: null };
      tools.delete(event.toolCallId);
      write("PostToolUse", {
        ...base(),
        ...(state.turnId ? { turn_id: state.turnId } : {}),
        tool_use_id: event.toolCallId,
        tool_name: event.toolName ?? t.toolName ?? "unknown",
        tool_input: t.args,
        tool_response: {
          text: cap(textBlocks(event.result?.content ?? event.result)),
          isError: event.isError === true,
        },
        at_wall: now(),
      });
    });
    pi.on("turn_end", async (event, ctx) => {
      refresh(ctx);
      const message = event?.message;
      if (!message || message.role !== "assistant") return;
      const entryId = entryIdOf(ctx, message);
      const common = {
        ...base(),
        ...(state.turnId ? { turn_id: state.turnId } : {}),
        ...(entryId ? { message_id: entryId } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.provider ? { provider: message.provider } : {}),
        at_wall: typeof message.timestamp === "number" ? message.timestamp : now(),
      };
      write("Stop", {
        ...common,
        last_assistant_message: cap(textBlocks(message.content)),
        tool_calls: Array.isArray(message.content)
          ? message.content.filter((c) => c && c.type === "toolCall").length
          : 0,
        ...(message.stopReason ? { stop_reason: message.stopReason } : {}),
      });
      if (message.usage && entryId) {
        write("Usage", { ...common, entry_id: entryId, usage: message.usage, kind: "message" });
      }
    });
    pi.on("session_before_compact", async (_event, ctx) => {
      refresh(ctx);
      if (!state.sessionId) return;
      write("PreCompact", { ...base(), at_wall: now() });
      spawnSnapshot("PreCompact", { session_id: state.sessionId, cwd: state.cwd ?? process.cwd(), ...(state.sessionFile ? { transcript_path: state.sessionFile } : {}) }, state.cwd ?? process.cwd());
    });
    pi.on("session_compact", async (event, ctx) => {
      refresh(ctx);
      if (!state.sessionId) return;
      const entry = event?.compactionEntry;
      write("PostCompact", { ...base(), reason: event?.reason ?? null, ...(entry?.id ? { entry_id: entry.id } : {}), at_wall: now() });
      if (entry?.usage && entry.id) {
        write("Usage", { ...base(), entry_id: entry.id, usage: entry.usage, kind: "compaction", at_wall: now() });
      }
      spawnSnapshot("PostCompact", { session_id: state.sessionId, cwd: state.cwd ?? process.cwd(), ...(state.sessionFile ? { transcript_path: state.sessionFile } : {}) }, state.cwd ?? process.cwd());
    });
    pi.on("session_tree", async (event, ctx) => {
      refresh(ctx);
      const entry = event?.summaryEntry;
      if (entry?.usage && entry.id && state.sessionId) {
        write("Usage", { ...base(), entry_id: entry.id, usage: entry.usage, kind: "branch-summary", at_wall: now() });
      }
    });

    for (const [name, command] of Object.entries(commands)) {
      pi.registerCommand(name, {
        description: command.description || name,
        handler: async (args, ctx) => {
          refresh(ctx);
          const content = expandTemplate(command.template, args);
          state.pendingPrompt = { prompt: cap(content), source: "extension", injected: true, command: name };
          pi.sendMessage(
            { customType: "jentrix", content, display: true, details: { command: name, arguments: args ?? "" } },
            { triggerTurn: true },
          );
          // Print mode returns from prompt() when this handler resolves (S0b):
          // hold it until the turn the message triggered has settled.
          if (typeof ctx?.waitForIdle === "function") await ctx.waitForIdle();
        },
      });
    }
  };
}

export default createJentrixExtension();
