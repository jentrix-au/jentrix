// @jentrix/plugin-opencode — the official Jentrix plugin for OpenCode
// (M2, JEN-537). Runs INSIDE OpenCode (Bun) and does three things:
//
//  1. registers the seven `/jentrix-*` commands through the supported
//     `config` hook, from the generated files in ./commands (D6);
//  2. hands this session's identity to every bash command through the
//     `shell.env` hook — `OPENCODE_SESSION_ID` — so `jentrix session connect
//     --provider opencode` binds the RIGHT session without guessing (D4);
//  3. appends one NDJSON line per observed host event to the provider ledger
//     (`~/.config/stacks/opencode-sessions/hooks.ndjson`), the same file shape
//     the Claude/Codex hook forwarder writes, which the CLI's watch host tails
//     and maps (src/session-host/session-opencode-hooks.ts in jentrix-au/
//     jentrix). Lifecycle, prompts, tool calls, assistant messages,
//     compaction boundaries and ONE token receipt per `step-finish` part.
//
// Token semantics and event order were settled by the S0b native proof on
// OpenCode 1.18.9 (task-manager reports/plugin-sync-2026-09-12/
// m2-s0b-native-proof.md): a new assistant message per step, `message.tokens`
// equal to that step, forks REPLAYING history with new ids and original
// timestamps. Messages created before the session itself are therefore
// marked `inherited` and yield no receipt.
//
// Zero dependencies, no network: the ledger is local and 0600; the only
// process it starts is `jentrix session snapshot` at compaction boundaries.

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER = "opencode";
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

/** What the SessionStart line says about the copy that wrote it (doctor G06). */
export function pluginIdentity(packageDir = PACKAGE_DIR) {
  const pkg = readJson(join(packageDir, "package.json"));
  const manifest = readJson(join(packageDir, "manifest.json"));
  return {
    package: pkg.name ?? "@jentrix/plugin-opencode",
    version: pkg.version ?? manifest.version ?? null,
    behaviorRevision: pkg.jentrix?.behaviorRevision ?? null,
    resourceDigest: pkg.jentrix?.resourceDigest ?? null,
    dir: packageDir,
  };
}

/** The provider ledger directory — the SAME path the CLI resolves. */
export function ledgerDir(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, ".config", "stacks", `${PROVIDER}-sessions`);
}

/** Mirrors the CLI's `hookEnv`: which copy answered, never a secret. */
function hookEnv(env = process.env) {
  const path = env.PATH ?? env.Path ?? null;
  return {
    path: path === null ? null : path.slice(0, PATH_CAP),
    execPath: process.execPath,
    argv0: process.argv0,
    script: process.argv[1] ?? null,
  };
}

/** Append one ledger line: `{event, at, payload, env}` (the CLI's shape). */
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

/** Parse one generated command file: frontmatter `description`, body = template. */
export function parseCommandFile(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { description: "", template: text.trim() };
  const description =
    /^description:\s*(.*)$/m.exec(match[1])?.[1]?.trim() ?? "";
  return { description, template: text.slice(match[0].length).trim() };
}

/** The seven commands from ./commands/jentrix-*.md, keyed by command name. */
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

function textOf(parts) {
  return (parts ?? [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function cap(value) {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length > OUTPUT_CAP
    ? `${text.slice(0, OUTPUT_CAP)}\n…[truncated by the Jentrix plugin at ${OUTPUT_CAP} bytes]`
    : text;
}

/**
 * Build the plugin. `options` exist for the runtime fixture tests: an
 * injected ledger writer, clock, snapshot spawner and command set; OpenCode
 * itself gets the defaults.
 */
export function createJentrixPlugin(options = {}) {
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
          detached: false,
        });
        child.on("error", () => {});
        child.stdin.end(JSON.stringify(payload));
      } catch {
        // No CLI on PATH: the boundary is still in the ledger.
      }
    });

  return async function JentrixOpenCodePlugin(input) {
    const directory = input?.directory ?? process.cwd();
    /** sessionID → { createdAt, turnId, ended } */
    const sessions = new Map();
    /** messageID → { sessionID, createdAt, model, finish, summary, stopped, texts: Map(partID→text) } */
    const messages = new Map();
    /** callID → { messageID, tool, args, done } */
    const tools = new Map();
    const usageParts = new Set();
    /** sessionID → pending command name for the next chat.message */
    const pendingCommand = new Map();

    const session = (sessionID) => {
      let s = sessions.get(sessionID);
      if (!s) {
        s = { createdAt: null, turnId: null, ended: false, started: false };
        sessions.set(sessionID, s);
      }
      return s;
    };
    const ensureStarted = (sessionID, info) => {
      const s = session(sessionID);
      if (s.started) return s;
      s.started = true;
      s.createdAt = info?.time?.created ?? s.createdAt;
      write("SessionStart", {
        session_id: sessionID,
        cwd: directory,
        directory,
        worktree: input?.worktree ?? null,
        ...(info?.title ? { title: info.title } : {}),
        ...(info?.parentID ? { parent_session_id: info.parentID } : {}),
        created_at: s.createdAt,
        resumed: !info,
        plugin: identity,
        at_wall: now(),
      });
      return s;
    };
    const endSession = (sessionID, reason) => {
      const s = session(sessionID);
      if (s.ended) return;
      s.ended = true;
      if (s.turnId) {
        write("TurnEnd", { session_id: sessionID, turn_id: s.turnId, at_wall: now() });
        s.turnId = null;
      }
      write("SessionEnd", { session_id: sessionID, reason, at_wall: now() });
    };
    const inherited = (sessionID, createdAt) => {
      const s = sessions.get(sessionID);
      return Boolean(
        s?.createdAt && typeof createdAt === "number" && createdAt < s.createdAt,
      );
    };
    const message = (info) => {
      let m = messages.get(info.id);
      if (!m) {
        m = {
          sessionID: info.sessionID,
          createdAt: info.time?.created ?? null,
          model: null,
          finish: null,
          summary: false,
          stopped: false,
          texts: new Map(),
        };
        messages.set(info.id, m);
      }
      if (info.providerID || info.modelID) {
        m.model = { providerID: info.providerID ?? null, modelID: info.modelID ?? null };
      }
      if (info.finish) m.finish = info.finish;
      if (info.summary === true) m.summary = true;
      return m;
    };

    return {
      async config(cfg) {
        // D6: the supported registration path. An operator's own command of
        // the same name wins; ours fill the gaps.
        cfg.command = { ...commands, ...(cfg.command ?? {}) };
      },
      async "shell.env"(i, out) {
        if (!i?.sessionID) return;
        out.env.OPENCODE_SESSION_ID = i.sessionID;
        out.env.JENTRIX_PROVIDER = PROVIDER;
      },
      async "command.execute.before"(i) {
        if (i?.sessionID && i.command) {
          pendingCommand.set(i.sessionID, { name: i.command, arguments: i.arguments ?? "" });
        }
      },
      async "chat.message"(i, out) {
        const sessionID = i?.sessionID;
        if (!sessionID || out?.message?.role !== "user") return;
        const s = ensureStarted(sessionID);
        const messageID = out.message.id;
        const command = pendingCommand.get(sessionID) ?? null;
        pendingCommand.delete(sessionID);
        if (s.turnId) {
          // A prompt while a turn is open closes it (OpenCode queues prompts).
          write("TurnEnd", { session_id: sessionID, turn_id: s.turnId, at_wall: now() });
        }
        s.turnId = messageID;
        write("UserPromptSubmit", {
          session_id: sessionID,
          message_id: messageID,
          turn_id: messageID,
          prompt: cap(textOf(out.parts)),
          ...(i.agent ? { agent: i.agent } : {}),
          ...(i.model ? { model: i.model } : {}),
          ...(command ? { injected: true, command: command.name, arguments: command.arguments } : {}),
          at_wall: now(),
        });
        write("TurnStart", { session_id: sessionID, turn_id: messageID, at_wall: now() });
      },
      async "tool.execute.before"(i, out) {
        if (!i?.callID) return;
        const t = tools.get(i.callID) ?? { messageID: null, tool: i.tool, args: null, done: false };
        t.tool = i.tool ?? t.tool;
        t.args = out?.args ?? t.args;
        tools.set(i.callID, t);
      },
      async "tool.execute.after"(i, out) {
        if (!i?.sessionID || !i.callID) return;
        const t = tools.get(i.callID) ?? { messageID: null, tool: i.tool, args: null, done: false };
        t.done = true;
        tools.set(i.callID, t);
        const s = session(i.sessionID);
        write("PostToolUse", {
          session_id: i.sessionID,
          ...(s.turnId ? { turn_id: s.turnId } : {}),
          ...(t.messageID ? { message_id: t.messageID } : {}),
          tool_use_id: i.callID,
          tool_name: i.tool ?? t.tool ?? "unknown",
          tool_input: t.args ?? null,
          tool_response: {
            ...(out?.title !== undefined ? { title: out.title } : {}),
            output: cap(out?.output),
          },
          at_wall: now(),
        });
      },
      async "experimental.session.compacting"(i) {
        if (!i?.sessionID) return;
        write("PreCompact", { session_id: i.sessionID, at_wall: now() });
        spawnSnapshot("PreCompact", { session_id: i.sessionID, cwd: directory }, directory);
      },
      async event({ event }) {
        const type = event?.type;
        const p = event?.properties ?? {};
        if (type === "session.created" && p.info?.id) {
          const s = session(p.info.id);
          s.createdAt = p.info.time?.created ?? null;
          ensureStarted(p.info.id, p.info);
          return;
        }
        if (type === "session.deleted" && p.info?.id) {
          endSession(p.info.id, "deleted");
          return;
        }
        if (type === "session.error" && p.sessionID) {
          write("Error", {
            session_id: p.sessionID,
            name: p.error?.name ?? "unknown",
            ...(p.error?.data?.message ? { message: cap(p.error.data.message) } : {}),
            at_wall: now(),
          });
          return;
        }
        if (type === "session.idle" && p.sessionID) {
          const s = session(p.sessionID);
          if (s.turnId) {
            write("TurnEnd", { session_id: p.sessionID, turn_id: s.turnId, at_wall: now() });
            s.turnId = null;
          }
          return;
        }
        if (type === "session.compacted" && p.sessionID) {
          write("PostCompact", { session_id: p.sessionID, at_wall: now() });
          spawnSnapshot("PostCompact", { session_id: p.sessionID, cwd: directory }, directory);
          return;
        }
        if (type === "message.updated" && p.info?.id && p.info.sessionID) {
          const info = p.info;
          if (info.role === "user") {
            ensureStarted(info.sessionID); // a resumed session has no session.created
            return;
          }
          if (info.role !== "assistant") return;
          ensureStarted(info.sessionID);
          const m = message(info);
          if (!info.time?.completed || m.stopped) return;
          m.stopped = true;
          const s = session(info.sessionID);
          write("Stop", {
            session_id: info.sessionID,
            message_id: info.id,
            ...(s.turnId ? { turn_id: s.turnId } : {}),
            last_assistant_message: cap([...m.texts.values()].join("\n").trim()),
            tool_calls: [...tools.values()].filter((t) => t.messageID === info.id).length,
            ...(m.finish ? { finish: m.finish } : {}),
            ...(m.model ? { model: m.model } : {}),
            ...(m.summary ? { summary: true } : {}),
            ...(inherited(info.sessionID, m.createdAt) ? { inherited: true } : {}),
            at_wall: info.time.completed,
          });
          return;
        }
        if (type === "message.part.updated" && p.part?.id && p.part.messageID) {
          const part = p.part;
          if (part.type === "text" && typeof part.text === "string") {
            const m = messages.get(part.messageID);
            if (m) m.texts.set(part.id, part.text);
            return;
          }
          if (part.type === "tool" && part.callID) {
            const t = tools.get(part.callID) ?? { messageID: null, tool: part.tool, args: null, done: false };
            t.messageID = part.messageID;
            t.tool = part.tool ?? t.tool;
            if (part.state?.input && !t.args) t.args = part.state.input;
            tools.set(part.callID, t);
            if (part.state?.status === "error" && !t.done) {
              // A tool that errored never reaches tool.execute.after.
              t.done = true;
              const s = session(part.sessionID);
              write("PostToolUse", {
                session_id: part.sessionID,
                ...(s.turnId ? { turn_id: s.turnId } : {}),
                message_id: part.messageID,
                tool_use_id: part.callID,
                tool_name: t.tool ?? "unknown",
                tool_input: t.args ?? null,
                tool_response: { error: cap(part.state.error ?? "error") },
                at_wall: part.state.time?.end ?? now(),
              });
            }
            return;
          }
          if (part.type === "step-finish" && part.tokens) {
            if (usageParts.has(part.id)) return;
            usageParts.add(part.id);
            const m = messages.get(part.messageID);
            const s = session(part.sessionID);
            write("Usage", {
              session_id: part.sessionID,
              message_id: part.messageID,
              part_id: part.id,
              ...(s.turnId ? { turn_id: s.turnId } : {}),
              ...(m?.model ? { model: m.model } : {}),
              tokens: part.tokens,
              ...(typeof part.cost === "number" ? { cost: part.cost } : {}),
              ...(part.reason ? { finish: part.reason } : {}),
              ...(m?.summary ? { compaction: true } : {}),
              ...(inherited(part.sessionID, m?.createdAt) ? { inherited: true } : {}),
              at_wall: now(),
            });
          }
        }
      },
      async dispose() {
        for (const sessionID of sessions.keys()) endSession(sessionID, "dispose");
      },
    };
  };
}

/** The plugin OpenCode loads (one export, one instance). */
export const JentrixOpenCodePlugin = createJentrixPlugin();
