/** Session provider context. */
import {
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { type SessionCommandDeps } from "./deps";
import { join } from "node:path";
import { UsageError } from "../tool-client";
import {
  SESSION_PROVIDERS,
  type SessionProvider,
} from "../session-host/session-events";

/**
 * A SessionStart with no SessionEnd is not evidence of a LIVE session — the
 * 2026-08-11 gap report found 45 unterminated starts on one machine, the
 * oldest 35 hours dead. Anything whose newest sign of life (the start itself,
 * or its transcript's mtime) is older than this is stale, not current.
 */
const STALE_HOOK_MS = 12 * 60 * 60 * 1000;

export interface ClaudeHookContext {
  sessionId: string;
  transcriptPath: string | null;
  /** One sentence naming HOW this record won — disclosed before submit. */
  basis: string;
  /**
   * A LIVE hook record NEWER than the winner, recorded in a directory this
   * checkout does NOT sit under — the F1 shape (Claude Code launched from
   * one directory, the CLI run in a sibling). Null when unambiguous.
   */
  newerElsewhere: {
    sessionId: string;
    cwd: string;
    startedAt: string | null;
  } | null;
}

interface HookStart {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string;
  at: string | null;
  startedMs: number;
}

/** Default mtime probe: epoch ms, or null when the file is not on disk. */
function transcriptMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** First 64 KiB of a transcript — enough for the first stamped record. */
function readTranscriptHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse the hooks ledger into its SessionStart records plus the newest
 * SessionEnd per session id. Both halves matter: the ledger is append-only,
 * so "is this session still running?" is only answerable by reading the ends.
 */
function parseHookLedger(body: string): {
  starts: HookStart[];
  endedAt: Map<string, number>;
  transcriptBySession: Map<string, string>;
} {
  const starts: HookStart[] = [];
  const endedAt = new Map<string, number>();
  const transcriptBySession = new Map<string, string>();
  for (const line of body.split("\n").filter(Boolean)) {
    let parsed: {
      event?: string;
      at?: string;
      payload?: {
        session_id?: string;
        transcript_path?: string;
        cwd?: string;
      };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    const sessionId = parsed.payload?.session_id;
    if (typeof sessionId !== "string") continue;
    const transcriptPath = parsed.payload?.transcript_path?.trim();
    if (transcriptPath) {
      transcriptBySession.set(sessionId, transcriptPath);
    }
    // A record written before the writer stamped `at`, or with an unparseable
    // one, reads as epoch 0: the transcript's mtime then has to carry the
    // liveness argument on its own, which is the honest fallback.
    const stamped = parsed.at ? Date.parse(parsed.at) : NaN;
    const ms = Number.isNaN(stamped) ? 0 : stamped;
    if (parsed.event === "SessionEnd") {
      endedAt.set(sessionId, Math.max(endedAt.get(sessionId) ?? 0, ms));
    } else if (
      parsed.event === "SessionStart" &&
      typeof parsed.payload?.cwd === "string"
    ) {
      starts.push({
        sessionId,
        transcriptPath: parsed.payload.transcript_path ?? null,
        cwd: parsed.payload.cwd,
        at: parsed.at ?? null,
        startedMs: ms,
      });
    }
  }
  return { starts, endedAt, transcriptBySession };
}

/** Newest transcript the ledger names for one session id, from any directory. */
function transcriptForSessionIn(
  ledger: { transcriptBySession: Map<string, string> },
  sessionId: string,
): string | null {
  return ledger.transcriptBySession.get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// W2 / JEN-163 — the telemetry SOURCE as an explicit three-value fact.
//
// The defect this replaces: `align` reported "host watches trusted Codex
// lifecycle hooks and provider-reported rollout usage" whenever a home
// directory was resolvable. A resolvable home says nothing about whether a
// hook has ever fired — so a session could report COMPLETE token coverage
// while prompts, tool calls, assistant messages and compaction boundaries
// were all silently unrecorded, and the operator read the one as the other.
//
// Decided from the hook LEDGER's record for THIS session, never from a
// directory and never from an installed plugin (C2.1/C2.5). One helper, three
// surfaces (align preconditions, `session status`, `session doctor`) — three
// surfaces that can disagree are three chances to be wrong (C2.4).
// ---------------------------------------------------------------------------

/** Where a connected session's local telemetry actually comes from (C2.1). */
export type TelemetrySource =
  "hooks+rollout" | "rollout-fallback" | "unavailable";

export interface TelemetrySourceFact {
  source: TelemetrySource;
  /** One line naming the source — the SAME words on every surface. */
  detail: string;
  /** What this source cannot record. Empty only when nothing is missing. */
  missing: string[];
  /** The one real remedy for `missing`, or null when nothing is missing. */
  remedy: string | null;
}

/**
 * What a Codex task's lifecycle hooks are the only source of. The rollout
 * carries token receipts and nothing else, so a hookless task is blind to all
 * five of these — and it is exactly this list an operator deserves to read
 * instead of the word COMPLETE (C2.3).
 */
const CODEX_HOOK_ONLY = [
  "prompts",
  "tool calls",
  "assistant messages",
  "final response",
  "compaction boundaries",
];

/**
 * Trusting hooks mid-task changes NOTHING for the task already running —
 * plugins and hooks load at task start. Saying "trust the hooks" without the
 * new task is the advice that looks like a fix and is not one.
 */
export const CODEX_HOOK_REMEDY =
  "type `/hooks` at Codex's own prompt (an in-session Codex CLI command, not a shell command), review and trust the Jentrix hooks, then start a NEW task — the trust persists, and hooks load at task start, so it covers tasks started after it";

/** How the two plugin hosts are named in prose. */
export const PLUGIN_HOST_LABEL: Record<"opencode" | "pi", string> = {
  opencode: "OpenCode",
  pi: "Pi",
};

/**
 * M2 (JEN-537): the one remedy for a plugin host that recorded nothing —
 * plugins load at startup on both hosts, and OpenCode's `--pure` disables
 * every external plugin for that run.
 */
export const PLUGIN_HOST_REMEDY: Record<"opencode" | "pi", string> = {
  opencode:
    "install the plugin (`jentrix plugin install opencode`), then restart OpenCode — plugins load at startup, and a run started with `--pure` loads none",
  pi: "install the package (`jentrix plugin install pi`), then restart Pi — extensions load at startup, and a run started with `--no-extensions` loads none",
};

/**
 * The three-value telemetry source (C2.1). `hookRecord` is whether the LEDGER
 * holds a record for this session; `boundPath` is the exact rollout (Codex) or
 * transcript (Claude) that was bound — never a "latest" substitute, which
 * would manufacture a receipt for a session we did not observe (C2.5).
 *
 * PURE: both inputs are facts the caller already has, so all three cases are
 * directly unit-testable without a filesystem.
 */
export function telemetrySourceFact(
  provider: SessionProvider,
  input: { hookRecord: boolean; boundPath: string | null },
): TelemetrySourceFact {
  const { hookRecord, boundPath } = input;
  const source: TelemetrySource = hookRecord
    ? "hooks+rollout"
    : boundPath
      ? "rollout-fallback"
      : "unavailable";
  if (provider === "opencode" || provider === "pi") {
    // M2 (JEN-537): the in-process plugin IS the only source — it appends
    // lifecycle, prompts, tool calls, assistant text AND token receipts to the
    // ledger, and there is no transcript to fall back on (OpenCode stores
    // sessions in SQLite; Pi's session file carries nothing the plugin does
    // not already see). Either the plugin recorded this session or nothing did.
    return hookRecord
      ? {
          source: "hooks+rollout",
          detail: `hooks+rollout — the Jentrix ${PLUGIN_HOST_LABEL[provider]} plugin recorded this session in its ledger (lifecycle, prompts, tool calls, assistant messages, token receipts)`,
          missing: [],
          remedy: null,
        }
      : {
          source: "unavailable",
          detail: `unavailable — no Jentrix ${PLUGIN_HOST_LABEL[provider]} plugin ledger line names this session, so nothing local can observe it`,
          missing: [...CODEX_HOOK_ONLY, "token receipts"],
          remedy: PLUGIN_HOST_REMEDY[provider],
        };
  }
  if (provider === "codex") {
    // Codex splits cleanly: the hook ledger is the ONLY source of the five
    // capabilities above, the rollout the ONLY source of token receipts.
    const missing = [
      ...(hookRecord ? [] : CODEX_HOOK_ONLY),
      ...(boundPath ? [] : ["token receipts"]),
    ];
    return {
      source,
      detail: hookRecord
        ? boundPath
          ? "hooks+rollout — trusted Codex lifecycle hooks recorded this task and its exact rollout is bound"
          : "hooks+rollout — trusted Codex lifecycle hooks recorded this task, but no rollout file is bound for it yet"
        : boundPath
          ? "rollout-fallback — NO Jentrix hook has fired for this task; the exact rollout was resolved from Codex's own sessions directory, so token receipts are the only thing observable"
          : "unavailable — no Jentrix hook record and no rollout for this task, so nothing local can observe it",
      missing,
      remedy: missing.length === 0 ? null : CODEX_HOOK_REMEDY,
    };
  }
  // Claude's transcript carries prompts, tool calls, messages AND receipts;
  // the hook ledger's job is to NAME it. So the hole here is a missing
  // transcript, and the pre-existing no-transcript warning is exactly this
  // `unavailable` case in the shared vocabulary (C2.6).
  if (!boundPath) {
    return {
      source: "unavailable",
      detail:
        "unavailable — no transcript is bound for this session, so nothing local can observe it",
      missing: [...CODEX_HOOK_ONLY, "token receipts"],
      remedy:
        "run `/jentrix-connect` inside the Claude session (the plugin's hooks record the transcript path), or re-align with `--transcript-path <this session's .jsonl>`",
    };
  }
  return {
    source,
    detail: hookRecord
      ? "hooks+rollout — a Jentrix hook record names this session and its transcript is bound"
      : "rollout-fallback — the transcript is bound, but NO Jentrix hook record names this session, so the binding is unattested: a transcript belonging to another session would look exactly like this",
    missing: [],
    remedy: null,
  };
}

/**
 * Does the provider hook LEDGER hold any record for this session id (C2.1)?
 * A SessionStart with no transcript is still a record — the hooks fired, which
 * is the whole question. Never asks whether a home directory exists, never
 * asks whether a plugin is installed.
 */
export function hookLedgerNamesSession(
  deps: Pick<SessionCommandDeps, "env">,
  provider: SessionProvider,
  sessionId: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  const dir = hooksDir(deps, provider);
  if (!dir) return false;
  let body: string;
  try {
    body = readFile(join(dir, "hooks.ndjson"));
  } catch {
    return false;
  }
  const { starts, endedAt, transcriptBySession } = parseHookLedger(body);
  return (
    transcriptBySession.has(sessionId) ||
    endedAt.has(sessionId) ||
    starts.some((start) => start.sessionId === sessionId)
  );
}

/**
 * The telemetry source for a SERVER-reported session row (`session status`).
 * Resolves the bound path exactly as align does — the session's OWN rollout
 * (Codex) or the transcript its own hook record names (Claude). Never a
 * "latest" file: a receipt for a session we did not observe is worse than no
 * receipt (C2.5).
 */
export function telemetrySourceForSessionRow(
  deps: Pick<SessionCommandDeps, "env">,
  provider: SessionProvider,
  providerSessionId: string | null,
): TelemetrySourceFact {
  const boundPath = providerSessionId
    ? provider === "codex"
      ? readCodexRolloutPath(deps, providerSessionId)
      : provider === "claude"
        ? readClaudeHookTranscript(deps, providerSessionId)
        : null // plugin hosts: the ledger is the source; no file is bound
    : null;
  return telemetrySourceFor(deps, provider, providerSessionId, boundPath);
}

/** Render one telemetry fact as the lines every surface prints (C2.4). */
export function telemetrySourceLines(fact: TelemetrySourceFact): string[] {
  return [
    `Telemetry source: ${fact.detail}`,
    ...(fact.missing.length > 0
      ? [`  NOT recorded: ${fact.missing.join(", ")}`]
      : []),
    ...(fact.remedy ? [`  Fix: ${fact.remedy}`] : []),
  ];
}

/** The telemetry source for one resolved binding — the one call every surface makes. */
export function telemetrySourceFor(
  deps: Pick<SessionCommandDeps, "env">,
  provider: SessionProvider,
  sessionId: string | null,
  boundPath: string | null,
  readFile?: (path: string) => string,
): TelemetrySourceFact {
  return telemetrySourceFact(provider, {
    hookRecord: sessionId
      ? hookLedgerNamesSession(deps, provider, sessionId, readFile)
      : false,
    boundPath,
  });
}

/**
 * Claude Code exports its session id into every command it runs. That is the
 * ONE thing the ledger can never derive: the ledger says which sessions exist,
 * the env var says which one is ASKING.
 */
const CLAUDE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";

const CODEX_THREAD_ENV = "CODEX_THREAD_ID";

const CODEX_SESSION_ENV = "CODEX_SESSION_ID";

/**
 * M2 (JEN-537): OpenCode exports no session env of its own — the Jentrix
 * plugin's `shell.env` hook injects this into every bash tool command (S0b
 * proved the value reaches the shell). Pi's bash tool exports its own.
 */
const OPENCODE_SESSION_ENV = "OPENCODE_SESSION_ID";
const PI_SESSION_ENV = "PI_SESSION_ID";
const PI_SESSION_FILE_ENV = "PI_SESSION_FILE";

export interface ProviderHookContext extends ClaudeHookContext {
  provider: SessionProvider;
}

export function hooksDir(
  deps: Pick<SessionCommandDeps, "env">,
  provider: SessionProvider,
): string | null {
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  return home ? join(home, ".config", "stacks", `${provider}-sessions`) : null;
}

/**
 * The ledger's current length in UTF-16 units — the unit `readHookLines`
 * counts in — taken by the CLI at launch so the host's tail starts BEFORE the
 * receipt of the step that ran `jentrix session connect` lands (JEN-537).
 * A missing ledger is offset 0: the first post-attach hook creates it.
 */
export function hookLedgerOffset(hookDir: string): number {
  try {
    return readFileSync(join(hookDir, "hooks.ndjson"), "utf8").length;
  } catch {
    return 0;
  }
}

export function codexHooksDir(
  deps: Pick<SessionCommandDeps, "env">,
): string | null {
  return hooksDir(deps, "codex");
}

/** Exact Codex rollout for a trusted task id when plugin hooks did not fire. */
export function readCodexRolloutPath(
  deps: Pick<SessionCommandDeps, "env">,
  sessionId: string,
): string | null {
  const configuredHome = deps.env.CODEX_HOME?.trim() || null;
  const userHome = deps.env.HOME ?? deps.env.USERPROFILE;
  const home = configuredHome ?? (userHome ? join(userHome, ".codex") : null);
  if (!home) return null;
  const root = join(home, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  try {
    const relative = readdirSync(root, {
      encoding: "utf8",
      recursive: true,
    }).find((path) => path.endsWith(suffix));
    return relative ? join(root, relative) : null;
  } catch {
    return null;
  }
}

/**
 * The TRUSTED provider lifecycle context the Claude plugin's hooks recorded
 * (AC17), narrowed to the session that is actually ASKING. Written by
 * `jentrix hook` from structured hook stdin — never
 * model-authored text. Null when no live hook context exists for this
 * checkout.
 *
 * `CLAUDE_CODE_SESSION_ID` decides FIRST when it is set, and then nothing else
 * gets a vote. Every rung below it is inference from the ledger, and inference
 * keyed on the checkout cannot tell two Claude Code sessions in ONE folder
 * apart: both match the same cwd, so both resolve to whichever started last,
 * and the folder behaves as though it holds a single alignment — the second
 * align re-aligns the first session, and both sessions' pushes land on the
 * newest. Claude Code stamps this id on the process, so each session names
 * ITSELF and concurrent sessions in one checkout stop colliding.
 *
 * The ledger still supplies the TRANSCRIPT for that id (from any directory —
 * `readClaudeHookTranscript`'s rule); a session whose SessionStart hook never
 * ran is identified with no transcript, which is honest and exactly what the
 * "no telemetry" disclosure already covers.
 *
 * Three discriminators, in order, when the env var is absent (2026-08-11 gap
 * report F1). A session with a later SessionEnd is never a candidate. A
 * candidate whose newest sign of life is older than STALE_HOOK_MS is never a
 * candidate — measured against max(start, transcript mtime), because a 20-hour
 * session is current and a 35-hour-abandoned one is not, and only the
 * transcript can tell them apart. Only then does the AGE-957 transcript-exists
 * preference run, WITHIN the survivors: it fixes a different failure (a
 * SessionStart naming a transcript that never materializes) and is orthogonal
 * to this one.
 *
 * cwd containment still selects on that path, because it is the only link
 * between a checkout and a session — but it can be WRONG (Claude Code launched
 * from a sibling directory), and being wrong here silently costs the session
 * its whole telemetry. So the result carries its own `basis` and names any
 * newer live session elsewhere; every caller is expected to disclose both.
 */
export function readClaudeHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  mtimeOf: (path: string) => number | null = transcriptMtime,
  now: () => number = Date.now,
): ClaudeHookContext | null {
  const own = deps.env[CLAUDE_SESSION_ENV]?.trim() || null;
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  let body = "";
  if (home) {
    try {
      body = readFile(
        join(home, ".config", "stacks", "claude-sessions", "hooks.ndjson"),
      );
    } catch {
      // No ledger. Fatal only for the inference path below — an env-named
      // session is still identified, just without a transcript.
    }
  }
  const ledger = parseHookLedger(body);
  const { starts, endedAt } = ledger;
  if (own) {
    const transcriptPath = transcriptForSessionIn(ledger, own);
    return {
      sessionId: own,
      transcriptPath,
      basis: `${CLAUDE_SESSION_ENV}=${own} — this session's own id${
        transcriptPath
          ? " (transcript from its hook record)"
          : " (no hook record names a transcript for it)"
      }`,
      // Nothing to be ambiguous about: the process named itself.
      newerElsewhere: null,
    };
  }
  if (!home || body === "") return null;
  const at = now();
  const live: Array<HookStart & { transcriptMs: number | null }> = [];
  for (const start of starts) {
    const ended = endedAt.get(start.sessionId);
    if (ended !== undefined && ended >= start.startedMs) continue;
    const transcriptMs = start.transcriptPath
      ? mtimeOf(start.transcriptPath)
      : null;
    if (at - Math.max(start.startedMs, transcriptMs ?? 0) > STALE_HOOK_MS) {
      continue;
    }
    live.push({ ...start, transcriptMs });
  }
  const cwd = deps.cwd();
  const matches = live.filter(
    (start) => cwd === start.cwd || cwd.startsWith(`${start.cwd}/`),
  );
  // AGE-957: prefer the newest match whose transcript file EXISTS. A startup
  // can fire two SessionStart hooks seconds apart, and the newest may name a
  // transcript that never materializes — a host launched on it tails ENOENT
  // silently forever (zero events, usage UNAVAILABLE) and the session binds
  // the wrong provider id. Evidence beats recency; newest-overall stays the
  // fallback (a brand-new session may not have written its transcript yet).
  let winner: (HookStart & { transcriptMs: number | null }) | null = null;
  for (let i = matches.length - 1; i >= 0 && !winner; i--) {
    if (matches[i]!.transcriptMs !== null) winner = matches[i]!;
  }
  winner ??= matches[matches.length - 1] ?? null;
  if (!winner) return null;
  const elsewhere = live
    .filter(
      (start) =>
        start.sessionId !== winner.sessionId &&
        !matches.includes(start) &&
        start.startedMs > winner.startedMs,
    )
    .sort((a, b) => b.startedMs - a.startedMs)[0];
  return {
    sessionId: winner.sessionId,
    transcriptPath: winner.transcriptPath,
    basis: `SessionStart${winner.at ? ` at ${winner.at}` : ""} in ${winner.cwd}${
      winner.transcriptMs !== null
        ? " (transcript on disk)"
        : " (transcript not written yet)"
    }`,
    newerElsewhere: elsewhere
      ? {
          sessionId: elsewhere.sessionId,
          cwd: elsewhere.cwd,
          startedAt: elsewhere.at,
        }
      : null,
  };
}

/**
 * Trusted Codex task identity. The process-owned thread/session environment
 * wins; the plugin ledger is the fallback. Unlike the older Claude cwd
 * heuristic, a ledger fallback must have exactly ONE live matching session —
 * Codex has no transcript stamp that could safely break a same-checkout tie.
 */
export function readCodexHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  now: () => number = Date.now,
): ClaudeHookContext | null {
  const threadId = deps.env[CODEX_THREAD_ENV]?.trim() || null;
  const sessionId = deps.env[CODEX_SESSION_ENV]?.trim() || null;
  if (threadId && sessionId && threadId !== sessionId) {
    throw new UsageError(
      `PROVIDER_SESSION_CONFLICT: ${CODEX_THREAD_ENV} and ${CODEX_SESSION_ENV} disagree — refusing to guess which Codex task owns this command`,
    );
  }
  const own = threadId ?? sessionId;
  const dir = hooksDir(deps, "codex");
  let body = "";
  if (dir) {
    try {
      body = readFile(join(dir, "hooks.ndjson"));
    } catch {
      // An environment-named task remains trusted without a ledger record.
    }
  }
  const ledger = parseHookLedger(body);
  const { starts, endedAt } = ledger;
  if (own) {
    const source = threadId ? CODEX_THREAD_ENV : CODEX_SESSION_ENV;
    const hookTranscript = transcriptForSessionIn(ledger, own);
    const transcriptPath = hookTranscript ?? readCodexRolloutPath(deps, own);
    return {
      sessionId: own,
      transcriptPath,
      basis: `${source}=${own} — this Codex task's own id${
        hookTranscript
          ? " (rollout from its hook record)"
          : transcriptPath
            ? " (rollout resolved from Codex sessions)"
            : ""
      }`,
      newerElsewhere: null,
    };
  }
  if (!dir || !body) return null;
  const cwd = deps.cwd();
  const liveIds = new Map<string, HookStart>();
  for (const start of starts) {
    const ended = endedAt.get(start.sessionId);
    if (ended !== undefined && ended >= start.startedMs) continue;
    if (now() - start.startedMs > STALE_HOOK_MS) continue;
    if (cwd !== start.cwd && !cwd.startsWith(`${start.cwd}/`)) continue;
    liveIds.set(start.sessionId, start);
  }
  const matches = [...liveIds.values()];
  if (matches.length > 1) {
    throw new UsageError(
      `PROVIDER_SESSION_AMBIGUOUS: ${matches.length} live Codex tasks match ${cwd} — use the command inside the target Codex task or pass --provider-session explicitly`,
    );
  }
  const match = matches[0];
  return match
    ? {
        sessionId: match.sessionId,
        transcriptPath:
          transcriptForSessionIn(ledger, match.sessionId) ??
          readCodexRolloutPath(deps, match.sessionId),
        basis: `unambiguous SessionStart${match.at ? ` at ${match.at}` : ""} in ${match.cwd}`,
        newerElsewhere: null,
      }
    : null;
}

/**
 * M2 (JEN-537): trusted identity for a PLUGIN host (OpenCode, Pi). The
 * process-owned session env wins (OpenCode: injected by the plugin's
 * `shell.env` hook; Pi: the bash tool's own `PI_SESSION_ID`). The plugin
 * ledger is the fallback under the Codex rule — exactly ONE live session
 * matching this checkout, never a same-checkout tie broken by recency.
 * `transcriptPath` is Pi's session file when the env names one (evidence of
 * the binding; the host reads the ledger, not the file); OpenCode has none.
 */
export function readPluginHostContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
  provider: "opencode" | "pi",
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  now: () => number = Date.now,
): ClaudeHookContext | null {
  const envName = provider === "pi" ? PI_SESSION_ENV : OPENCODE_SESSION_ENV;
  const own = deps.env[envName]?.trim() || null;
  const sessionFile =
    provider === "pi" ? deps.env[PI_SESSION_FILE_ENV]?.trim() || null : null;
  const dir = hooksDir(deps, provider);
  let body = "";
  if (dir) {
    try {
      body = readFile(join(dir, "hooks.ndjson"));
    } catch {
      // An environment-named session remains trusted without a ledger record.
    }
  }
  const ledger = parseHookLedger(body);
  const { starts, endedAt } = ledger;
  if (own) {
    return {
      sessionId: own,
      transcriptPath: sessionFile ?? transcriptForSessionIn(ledger, own),
      basis: `${envName}=${own} — this ${PLUGIN_HOST_LABEL[provider]} session's own id${
        sessionFile ? " (session file from its environment)" : ""
      }`,
      newerElsewhere: null,
    };
  }
  if (!dir || !body) return null;
  const cwd = deps.cwd();
  const liveIds = new Map<string, HookStart>();
  for (const start of starts) {
    const ended = endedAt.get(start.sessionId);
    if (ended !== undefined && ended >= start.startedMs) continue;
    if (now() - start.startedMs > STALE_HOOK_MS) continue;
    if (cwd !== start.cwd && !cwd.startsWith(`${start.cwd}/`)) continue;
    liveIds.set(start.sessionId, start);
  }
  const matches = [...liveIds.values()];
  if (matches.length > 1) {
    throw new UsageError(
      `PROVIDER_SESSION_AMBIGUOUS: ${matches.length} live ${PLUGIN_HOST_LABEL[provider]} sessions match ${cwd} — use the command inside the target session (its bash tool carries ${envName}) or pass --provider-session explicitly`,
    );
  }
  const match = matches[0];
  return match
    ? {
        sessionId: match.sessionId,
        transcriptPath: transcriptForSessionIn(ledger, match.sessionId),
        basis: `unambiguous SessionStart${match.at ? ` at ${match.at}` : ""} in ${match.cwd}`,
        newerElsewhere: null,
      }
    : null;
}

/** The named host's trusted context — the one dispatcher connect/align use. */
export function readProviderHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
  provider: SessionProvider,
): ClaudeHookContext | null {
  switch (provider) {
    case "claude":
      return readClaudeHookContext(deps);
    case "codex":
      return readCodexHookContext(deps);
    case "opencode":
    case "pi":
      return readPluginHostContext(deps, provider);
  }
}

/** Which providers' own environment identifies this process. */
function providersInEnv(env: Record<string, string | undefined>): SessionProvider[] {
  const named: SessionProvider[] = [];
  if (env[CODEX_THREAD_ENV]?.trim() || env[CODEX_SESSION_ENV]?.trim())
    named.push("codex");
  if (env[CLAUDE_SESSION_ENV]?.trim()) named.push("claude");
  if (env[OPENCODE_SESSION_ENV]?.trim()) named.push("opencode");
  if (env[PI_SESSION_ENV]?.trim()) named.push("pi");
  return named;
}

/** Current trusted provider context for implicit session correlation. */
export function readCurrentProviderHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
): ProviderHookContext | null {
  const named = providersInEnv(deps.env);
  if (named.length > 1) {
    throw new UsageError(
      `PROVIDER_SESSION_AMBIGUOUS: ${named.join(" and ")} identify this process — pass the target session explicitly`,
    );
  }
  if (named.length === 1) {
    const provider = named[0]!;
    const context = readProviderHookContext(deps, provider);
    return context ? { ...context, provider } : null;
  }
  // No environment identity: every provider's ledger may name a live session
  // in this checkout, and more than one is a tie nothing here can break.
  const live: ProviderHookContext[] = [];
  for (const provider of SESSION_PROVIDERS) {
    const context = readProviderHookContext(deps, provider);
    if (context) live.push({ ...context, provider });
  }
  if (live.length > 1) {
    throw new UsageError(
      `PROVIDER_SESSION_AMBIGUOUS: live ${live.map((c) => c.provider).join(" and ")} sessions both match this checkout — run inside the target provider task`,
    );
  }
  return live[0] ?? null;
}

/**
 * The transcript the hooks recorded for ONE session id, from any directory
 * (F1c). An explicitly-supplied `--provider-session` fixes the identity; this
 * is how the transcript follows it, instead of the host being launched on
 * whatever file the cwd-keyed resolution happened to name.
 */
export function readClaudeHookTranscript(
  deps: Pick<SessionCommandDeps, "env">,
  sessionId: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  if (!home) return null;
  try {
    return transcriptForSessionIn(
      parseHookLedger(
        readFile(
          join(home, ".config", "stacks", "claude-sessions", "hooks.ndjson"),
        ),
      ),
      sessionId,
    );
  } catch {
    // no ledger — the caller falls back to refusing the host launch
    return null;
  }
}

/**
 * Does this transcript belong to this provider session (F1c)? Claude Code
 * stamps `sessionId` on every record, so the file answers for itself — and it
 * has to, because `transcriptSeen: true` only reports that the host found A
 * transcript, not that it found THIS session's. Watching a foreign one yields
 * a healthy-looking host that matches no receipts and closes at exit 0 with
 * every token count null.
 *
 * Returns null when the file cannot be read or carries no session id at all:
 * unknown is not a mismatch, and refusing on unknown would break every
 * provider whose transcript does not stamp one.
 */
export function transcriptBelongsTo(
  transcriptPath: string,
  sessionId: string,
  // Head only: a transcript runs to hundreds of MB and the stamp is on the
  // first record. Reading the whole file to check one field is the kind of
  // cost that only shows up on someone else's machine.
  readFile: (path: string) => string = readTranscriptHead,
): boolean | null {
  let body: string;
  try {
    body = readFile(transcriptPath);
  } catch {
    return null;
  }
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const stamped = (JSON.parse(line) as { sessionId?: unknown }).sessionId;
      if (typeof stamped === "string") return stamped === sessionId;
    } catch {
      // keep scanning — a truncated tail line is not a verdict
    }
  }
  return null;
}
