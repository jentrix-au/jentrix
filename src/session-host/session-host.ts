/**
 * M20.1 §15 — the connected-session HOST: the runner-side orchestration that
 * launches (or drives) the interactive provider with capture running beside
 * it. Invoked by `stacks-runner session-run --plan-stdin`; the CLI (which may
 * not import provider SDKs — LRO-AC14) hands it a transient plan over stdin.
 *
 * Claude: the provider's own interactive UI runs untouched; a temp
 * hooks-settings file makes the SUPPORTED lifecycle hooks append their stdin
 * JSON to the session's hooks file via `stacks-runner session-hook`, giving
 * the bridge the TRUSTED `session_id` + `transcript_path` (AC17) and the
 * transcript tail to map. Hooks never carry credentials or transcript content
 * in argv.
 *
 * Codex: plugin watch mode consumes the supported lifecycle hook ledger for
 * one exact task id and token receipts from the rollout path those hooks
 * report. `jentrix session codex` remains the SDK-driven terminal fallback,
 * with every `runStreamed` event mapped deterministically.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  createConfigBearerSource,
  isUnauthorizedishError,
  staticBearerSource,
  type SessionBearerSource,
} from "./session-auth.js";
import { SessionBridge, type SessionCallTool } from "./session-bridge.js";
import {
  mapClaudeTranscriptLine,
  openingPromptOf,
} from "./session-claude-transcript.js";
import { ClaudeTimingTracker } from "./session-claude-timing.js";
import {
  codexOpeningPromptOf,
  lastCodexRolloutModelOf,
  mapCodexRolloutLine,
  mapCodexThreadEvent,
} from "./session-codex-events.js";
import { mapCodexHook } from "./session-codex-hooks.js";
import { createSessionRedactor } from "./session-redact.js";
import { readHookLines } from "./session-hook-log.js";
import {
  markHostExited,
  markHostFlushed,
  markHostTranscript,
  SessionSpool,
  writeHostMarker,
} from "./session-spool.js";
import { CLI_VERSION as RUNNER_VERSION } from "../client.js";

export interface SessionRunPlan {
  protocolVersion: 1;
  sessionId: string;
  provider: "claude" | "codex";
  jentrixBaseUrl: string;
  mcpUrl: string;
  /**
   * LEGACY (client-runtime v2 D18): pre-v2 CLIs wrote the bearer into the
   * plan; new plans NEVER carry one — the credential arrives as `configPath`
   * (rotation-following) or through the child environment (STACKS_TOKEN).
   * Read for the compatibility window only.
   */
  bearer?: string;
  /**
   * The CLI config file the bearer's OAuth rotations persist to. When set,
   * the host resolves its bearer through it (and can rotate) instead of
   * holding the spawn-time snapshot — a `tmo_` token is revoked the moment
   * any concurrent CLI call rotates, which is how a live capture-off host
   * lost its whole usage rollup (2026-08-08). Absent = PAT/static behavior.
   */
  configPath?: string | null;
  repoRoot: string;
  installationId: string;
  /**
   * "launch" (default) starts the provider; "watch" attaches BESIDE an
   * already-running provider session (the /jentrix-connect flow): no spawn,
   * hook + transcript polling only, ends on the SessionEnd hook.
   */
  mode?: "launch" | "watch";
  /** Watch mode: exact provider task id used to filter a shared hook ledger. */
  providerSessionId?: string | null;
  /** Watch mode: provider-global lifecycle ledger directory. */
  hookDir?: string | null;
  resumeProviderSessionId?: string | null;
  /** Watch mode: the trusted transcript path from the lifecycle hook. */
  transcriptPath?: string | null;
  /**
   * Watch mode: capture begins AT the attach point by default (§15.2 — the
   * tail starts at the transcript's current end); true reads from byte 0 so
   * prior VISIBLE history enters the trace (`--import-history`).
   */
  importHistory?: boolean;
  /**
   * Jentrix MVP (stacks-mvp PRD §6): false = TRACE capture OFF — the host
   * still heartbeats and aggregates provider usage receipts, but spools and
   * uploads NO trace parts and submits NO manifest. Default true (the 0.4.x
   * behavior); `jentrix align` sets false unless --capture re-enables it.
   */
  captureTrace?: boolean;
  /**
   * Session evidence floor (D3): false = no activity skeleton for this
   * session (`jentrix align --no-skeleton`). Default true, independent of
   * `captureTrace` — the skeleton is content-free metadata.
   */
  collectSkeleton?: boolean;
  executablePath?: string | null;
  spoolRoot?: string | null;
}

export function defaultSpoolRoot(): string {
  return join(homedir(), ".config", "stacks", "session-spool");
}

/** Read only complete lines appended since `offset`; never load prior chat. */
export function readTranscriptTail(
  path: string,
  offset: number,
): { body: string; offset: number } {
  const size = statSync(path).size;
  const start = size < offset ? 0 : offset;
  if (size === start) return { body: "", offset: start };

  const buffer = Buffer.allocUnsafe(size - start);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < buffer.byteLength) {
      const count = readSync(
        fd,
        buffer,
        read,
        buffer.byteLength - read,
        start + read,
      );
      if (count === 0) break;
      read += count;
    }
  } finally {
    closeSync(fd);
  }

  const newline = buffer.subarray(0, read).lastIndexOf(0x0a);
  if (newline === -1) return { body: "", offset: start };
  const consumed = newline + 1;
  return {
    body: buffer.subarray(0, consumed).toString("utf8"),
    offset: start + consumed,
  };
}

/**
 * The host's credential resolution (D18): config-following when the plan
 * names the CLI config; else the child environment (STACKS_TOKEN — how a
 * non-config token reaches a v2 host); else the legacy in-plan bearer for
 * the compatibility window. A plan with NO source at all fails fast — a
 * host that cannot authenticate records nothing and must say so, not 401
 * silently for its whole life.
 */
function bearerSourceOf(
  plan: Pick<SessionRunPlan, "bearer" | "configPath">,
  log: (line: string) => void,
): SessionBearerSource {
  const inline = plan.bearer ?? process.env.STACKS_TOKEN ?? "";
  if (plan.configPath) {
    return createConfigBearerSource({
      configPath: plan.configPath,
      fallback: inline,
      log,
    });
  }
  if (!inline) {
    throw new Error(
      "SESSION_PLAN_NO_CREDENTIAL: the plan names no configPath, the environment carries no STACKS_TOKEN, and no legacy bearer is present — the host cannot authenticate (D18: plans never persist bearer bytes).",
    );
  }
  return staticBearerSource(inline);
}

/**
 * One-shot MCP call carrying the bearer AND the session-correlation header.
 * The bearer comes from a source (not a snapshot): a `tmo_` access token is
 * revoked the moment any concurrent CLI call rotates it, so each attempt
 * resolves the CURRENT bearer, and one unauthorized failure gets one retry
 * after asking the source to refresh (2026-08-08 capture-off finding).
 */
export function sessionCallTool(
  mcpUrl: string,
  bearerSource: SessionBearerSource,
  sessionId: string,
): SessionCallTool {
  const attempt = async (
    bearer: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${bearer}`,
          "X-Stacks-Session-Id": sessionId,
        },
      },
    });
    const client = new Client({
      name: "stacks-session-host",
      version: RUNNER_VERSION,
    });
    await client.connect(transport, { timeout: 60_000 });
    try {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 60_000,
      });
      if (res.isError) {
        const text =
          Array.isArray(res.content) &&
          res.content[0] &&
          "text" in res.content[0]
            ? (res.content[0] as { text: string }).text
            : JSON.stringify(res.content);
        throw new Error(`${name} failed: ${text}`);
      }
      return (res.structuredContent ?? {}) as Record<string, unknown>;
    } finally {
      await client.close();
    }
  };
  return async (name, args) => {
    const bearer = bearerSource.get();
    try {
      return await attempt(bearer, name, args);
    } catch (error) {
      if (!isUnauthorizedishError(error)) throw error;
      const next = await bearerSource.refresh(bearer);
      if (!next || next === bearer) throw error;
      return attempt(next, name, args);
    }
  };
}

/**
 * JEN-167 — is this failed close the evidence floor REFUSING, or a real
 * failure? The distinction decides whether the host may keep running: a
 * refusal is a server-side 409 evaluated BEFORE any write (the session is
 * untouched and stays open, and the operator is expected to push the named
 * evidence and retry), while a crash, a dead bearer or a lost network leaves
 * the close genuinely unfinished. Returns the envelope's own message — the
 * text the CLI relays verbatim — or null when this is not a refusal.
 */
export function evidenceFloorRefusalOf(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (!raw.includes("EVIDENCE_FLOOR")) return null;
  // `sessionCallTool` wraps the MCP error envelope as `<tool> failed: <json>`;
  // unwrap it so the operator reads the refusal, not the transport.
  const start = raw.indexOf("{");
  if (start >= 0) {
    try {
      const envelope = JSON.parse(raw.slice(start)) as {
        error?: { message?: string };
      };
      const message = envelope.error?.message;
      if (typeof message === "string" && message.includes("EVIDENCE_FLOOR")) {
        return message;
      }
    } catch {
      // not an envelope — the raw text is the best available refusal
    }
  }
  return raw;
}

// The hook log moved to its own module so the `session-hook` verb — a Claude
// Code lifecycle hook, on the operator's critical path — can append a line
// without loading this file's MCP client and transports (P5). Re-exported here
// so every existing importer is unchanged; `readHookLines` is also imported
// above, because the watch loop below calls it.
export {
  appendHookEvent,
  readHookLines,
  safeParse,
  type HookLine,
} from "./session-hook-log.js";

/** The Claude hooks-settings document (temp file, referenced by --settings). */
export function claudeHookSettings(
  runnerBin: string,
  sessionDir: string,
): Record<string, unknown> {
  const hook = (event: string) => [
    {
      hooks: [
        {
          type: "command",
          // argv carries only the runner binary, the session DIRECTORY, and
          // the event name — never credentials or transcript content (§15.1).
          command: `${runnerBin} session-hook --dir ${JSON.stringify(sessionDir)} --event ${event}`,
        },
      ],
    },
  ];
  return {
    hooks: {
      SessionStart: hook("SessionStart"),
      UserPromptSubmit: hook("UserPromptSubmit"),
      Stop: hook("Stop"),
      SessionEnd: hook("SessionEnd"),
    },
  };
}

interface HostDeps {
  /** Test seam: the bridge's monotonic clock (heartbeat cadence). */
  monotonic?: () => number;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  /** Injectable MCP caller (integration tests); default opens a transport. */
  callTool?: SessionCallTool;
  log?: (line: string) => void;
}

async function endRepoState(repoRoot: string): Promise<{
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
}> {
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn("git", args, { cwd: repoRoot });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += String(chunk)));
      child.once("error", () => resolve({ code: 1, stdout: "" }));
      child.once("exit", (code) => resolve({ code: code ?? 1, stdout }));
    });
  const [branch, head, status] = await Promise.all([
    run(["symbolic-ref", "--short", "-q", "HEAD"]),
    run(["rev-parse", "HEAD"]),
    run(["status", "--porcelain"]),
  ]);
  return {
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
    head: head.code === 0 ? head.stdout.trim() || null : null,
    dirty: status.code === 0 ? status.stdout.trim().length > 0 : null,
  };
}

/**
 * Run a lifecycle-watched session. Claude launch/watch uses hooks plus its
 * supported transcript; Codex watch mode consumes the trusted plugin hook
 * ledger plus provider-reported rollout usage. Returns non-zero while capture
 * is pending (§20).
 */
export async function runClaudeSessionHost(
  plan: SessionRunPlan,
  deps: HostDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const spoolRoot = plan.spoolRoot ?? defaultSpoolRoot();
  const spool = new SessionSpool(spoolRoot, plan.sessionId);
  const sessionDir = spool.directory;
  // AGE-929: local liveness marker — `jentrix session status` probes this pid.
  writeHostMarker(sessionDir, {
    pid: process.pid,
    provider: plan.provider,
    mode: plan.mode === "watch" ? "watch" : "launch",
    captureTrace: plan.captureTrace !== false,
    // F1/P3: the transcript this host is bound to — what a compaction hook
    // matches on to find its session without guessing from cwd.
    ...(plan.transcriptPath ? { transcriptPath: plan.transcriptPath } : {}),
  });
  const traceCapture = plan.captureTrace !== false;
  const bearerSource = bearerSourceOf(plan, log);
  const bridge = new SessionBridge({
    jentrixBaseUrl: plan.jentrixBaseUrl,
    bearer: () => bearerSource.get(),
    onUnauthorized: (failed) => bearerSource.refresh(failed),
    sessionId: plan.sessionId,
    provider: plan.provider,
    spool,
    redactor: createSessionRedactor({ homedir: homedir() }),
    callTool:
      deps.callTool ??
      sessionCallTool(plan.mcpUrl, bearerSource, plan.sessionId),
    fetchImpl: deps.fetchImpl,
    monotonic: deps.monotonic,
    traceCapture,
    collectSkeleton: plan.collectSkeleton !== false,
    log,
  });
  bridge.recordCapabilities(
    plan.provider === "codex"
      ? {
          provider: "codex",
          providerVersion: null,
          observable: [
            "session",
            "user_message",
            "assistant_message",
            "tool_call",
            "tool_result",
            "usage",
          ],
          notObservable: ["command", "file_change", "plan", "error"],
        }
      : {
          provider: "claude",
          providerVersion: null,
          observable: [
            "session",
            "user_message",
            "assistant_message",
            "tool_call",
            "tool_result",
            "usage",
            "error",
          ],
          notObservable: ["command", "file_change", "plan"],
        },
  );
  bridge.startObserving();

  const watch = plan.mode === "watch";
  let child: ChildProcess | null = null;
  if (!watch) {
    const runnerBin = process.argv[1] ?? "stacks-runner";
    const settingsPath = join(sessionDir, "claude-hooks.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(claudeHookSettings(runnerBin, sessionDir), null, 2),
      { mode: 0o600 },
    );
    const args = ["--settings", settingsPath];
    if (plan.resumeProviderSessionId) {
      args.push("--resume", plan.resumeProviderSessionId);
    }
    child = (deps.spawnImpl ?? spawn)(plan.executablePath ?? "claude", args, {
      cwd: plan.repoRoot,
      stdio: "inherit",
    });
  }

  const hookDir = plan.hookDir ?? sessionDir;
  let hookOffset = 0;
  // Start at the ledger's current end. Codex replays it under
  // --import-history because its hooks ARE the events; Claude's plugin ledger
  // carries lifecycle only and is machine-global, so a replay would re-see
  // this session's own earlier SessionEnd (a `claude --resume`) and close the
  // host the moment it started (JEN-295).
  if (
    watch &&
    plan.hookDir &&
    (plan.provider === "claude" || !plan.importHistory)
  ) {
    try {
      hookOffset = readFileSync(join(hookDir, "hooks.ndjson"), "utf8").length;
    } catch {
      // The first post-attach hook creates the ledger.
    }
  }
  let transcriptPath: string | null = watch
    ? (plan.transcriptPath ?? null)
    : null;
  let transcriptOffset = 0;
  let codexTurnId: string | null = null;
  let codexModelId: string | null = null;
  const codexRolloutTurnStarts = new Map<string, number>();
  // control-room AC3.7 — one tracker per host, pairing observed transcript
  // timestamps into the provider-turn and tool intervals the usage aggregator
  // sums. Held here (not in the bridge) so the pairing rule stays a pure,
  // separately-tested module.
  const timing = new ClaudeTimingTracker();
  // AGE-957: a transcript path that never appears means the host observes
  // NOTHING (no events, no usage receipts) — track it, warn once after the
  // grace window, and stamp host.json so `session status` can say so.
  let transcriptSeen = false;
  let transcriptWarned = false;
  const hostStartedMs = Date.now();
  const noteTranscriptSeen = () => {
    if (!transcriptSeen) {
      transcriptSeen = true;
      markHostTranscript(sessionDir, true, transcriptPath ?? undefined);
    }
  };
  const observePriorCodexModel = (path: string) => {
    if (plan.provider !== "codex" || plan.importHistory) return;
    try {
      const modelId = lastCodexRolloutModelOf(readFileSync(path, "utf8"));
      if (modelId) {
        codexModelId = modelId;
        bridge.observeModel(modelId);
      }
    } catch {
      // The rollout may not exist yet; the normal tail observes it later.
    }
  };
  if (watch && transcriptPath && !plan.importHistory) {
    // Capture begins at attachment (§15.2): start the tail at the CURRENT
    // end of the transcript. `--import-history` reads from byte 0 instead.
    try {
      transcriptOffset = statSync(transcriptPath).size;
      observePriorCodexModel(transcriptPath);
      noteTranscriptSeen();
    } catch {
      // no transcript yet — everything it gains is post-attach anyway
    }
  }
  if (watch && !plan.importHistory) {
    // JEN-294: a RESTARTED host continues the session's totals from the
    // previous host's spool snapshot instead of restarting them at its own
    // window. Never while importing history (that replay re-reads the very
    // receipts the snapshot summarizes — seeding too would double count).
    const seededFrom = bridge.seedFromSpoolSnapshot();
    if (seededFrom) {
      log(
        `capture: usage baseline seeded from the spool snapshot of ${seededFrom} — totals continue from the previous host; coverage reads PARTIAL across the restart`,
      );
    }
  }
  let bound = watch; // watch mode attaches an ALREADY-bound provider session
  let sessionEnded = false;
  /**
   * JEN-295: WHICH end signal arrived. The operator's own `jentrix session
   * end` (end-request.json) is a COMPLETED close; the provider going away —
   * its SessionEnd hook, or the server already terminal — is not, because the
   * evidence floor is designed to refuse and be complied with, and nobody is
   * left to comply once the provider has exited.
   */
  let endRequested = false;
  // JEN-167: `session end --acknowledge-evidence-gaps` rides the end request
  // through to the host's own close. Without it the host would be refused by
  // the evidence floor on a close the operator explicitly acknowledged — the
  // CLI's fallback used to carry the flag only because the refusal killed the
  // host, and the host no longer dies.
  let endAcknowledgeGaps = false;
  /** CLI-counted commits for the session window — only the CLI can count them. */
  let endCommitCount: number | null = null;
  let lastPeriodicFlushAt = 0;
  // Taxonomy AC5.1 (D9) — the opening-prompt request `jentrix align` drops at
  // align-confirm. Attempted at most every 30s; filed EXACTLY once (the
  // filed-marker survives restarts, and the server dedupes by checksum
  // besides). Works with TRACE capture off — this never touches the spool.
  let lastPromptAttemptAt = 0;
  const promptRedactor = createSessionRedactor({ homedir: homedir() });
  const fileOpeningPrompt = async (): Promise<void> => {
    const requestPath = join(sessionDir, "prompt-request.json");
    const filedPath = join(sessionDir, "prompt-filed.json");
    if (!existsSync(requestPath)) return;
    if (existsSync(filedPath)) {
      try {
        unlinkSync(requestPath);
      } catch {
        // best-effort — the filed marker already guards re-filing
      }
      return;
    }
    if (!transcriptPath) return;
    const nowMs = Date.now();
    if (nowMs - lastPromptAttemptAt < 30_000) return;
    lastPromptAttemptAt = nowMs;
    let prompt: string | null = null;
    try {
      const transcript = readFileSync(transcriptPath, "utf8");
      prompt =
        plan.provider === "claude"
          ? openingPromptOf(transcript)
          : codexOpeningPromptOf(transcript);
    } catch {
      return; // absent transcript → no artifact, no error (D9); retry later
    }
    if (!prompt) return; // no visible user prompt yet — the transcript grows
    // Redact FIRST (a marker split at the cap is harmless; a secret split at
    // the cap is not), then bound to D9's 64 KB.
    let body = promptRedactor.text(prompt);
    while (Buffer.byteLength(body, "utf8") > 64 * 1024) {
      body = body.slice(0, -1024);
    }
    const post = async (bearer: string) =>
      (deps.fetchImpl ?? fetch)(
        new URL(
          `/api/agent-sessions/${plan.sessionId}/artifacts`,
          plan.jentrixBaseUrl,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "prompt",
            title: "Opening prompt",
            body,
          }),
        },
      );
    try {
      let response = await post(bearerSource.get());
      if (response.status === 401) {
        const next = await bearerSource.refresh(bearerSource.get());
        if (next) response = await post(next);
      }
      if (!response.ok) return; // retried on a later poll; never an error
      const payload = (await response.json().catch(() => ({}))) as {
        artifactId?: string;
        deduped?: boolean;
      };
      writeFileSync(
        filedPath,
        JSON.stringify({
          artifactId: payload.artifactId ?? null,
          filedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      try {
        unlinkSync(requestPath);
      } catch {
        // the filed marker guards re-filing
      }
      log(
        `Opening prompt filed as artifact ${payload.artifactId ?? "(unknown)"}${payload.deduped ? " (already stored)" : ""}`,
      );
    } catch {
      // network loss: retry on a later poll — a mint-class convenience must
      // never cost the session anything
    }
  };

  const poll = async (): Promise<void> => {
    // `jentrix session end` hands a live host the end request through the
    // spool dir — the host owns the manifest, so the CLI defers to it
    // instead of racing a direct server-side completion (F-4 follow-through).
    const endRequestPath = join(sessionDir, "end-request.json");
    if (!sessionEnded && existsSync(endRequestPath)) {
      try {
        const request = JSON.parse(readFileSync(endRequestPath, "utf8")) as {
          acknowledgeEvidenceGaps?: boolean;
          commitCount?: number;
        };
        endAcknowledgeGaps = request.acknowledgeEvidenceGaps === true;
        endCommitCount =
          typeof request.commitCount === "number" ? request.commitCount : null;
      } catch {
        endAcknowledgeGaps = false; // unreadable request: the floor still applies
        endCommitCount = null;
      }
      try {
        unlinkSync(endRequestPath);
      } catch {
        // best-effort — a leftover marker must not end a future resume
      }
      sessionEnded = true;
      endRequested = true;
    }
    const { lines, offset } = readHookLines(hookDir, hookOffset);
    hookOffset = offset;
    for (const line of lines) {
      // A watch host reads a PROVIDER-GLOBAL ledger (JEN-295): every Claude
      // Code / Codex session on the machine writes to it, so a line is this
      // session's only when its session_id is the bound provider id. Launch
      // mode has no providerSessionId and reads its own private ledger.
      if (
        plan.providerSessionId &&
        line.payload.session_id !== plan.providerSessionId
      ) {
        continue;
      }
      if (plan.provider === "codex") {
        const hookTranscript =
          typeof line.payload.transcript_path === "string" &&
          line.payload.transcript_path.trim()
            ? line.payload.transcript_path
            : null;
        if (hookTranscript && hookTranscript !== transcriptPath) {
          transcriptPath = hookTranscript;
          try {
            transcriptOffset = plan.importHistory
              ? 0
              : statSync(transcriptPath).size;
            observePriorCodexModel(transcriptPath);
            noteTranscriptSeen();
          } catch {
            transcriptOffset = 0;
          }
        }
        const mapped = mapCodexHook(line.event, line.payload);
        if (mapped.modelId) {
          codexModelId = mapped.modelId;
          bridge.observeModel(mapped.modelId);
        }
        const hookTurnId =
          typeof line.payload.turn_id === "string" &&
          line.payload.turn_id.trim()
            ? line.payload.turn_id
            : null;
        if (line.event === "UserPromptSubmit" && hookTurnId) {
          codexTurnId = hookTurnId;
          bridge.markTurnStarted(hookTurnId);
        }
        if (line.event === "Stop" && hookTurnId) {
          bridge.markTurnEnded(hookTurnId);
        }
        for (const event of mapped.events) bridge.record(event);
      }
      if (line.event === "SessionStart" && line.payload.session_id && !bound) {
        bound = true;
        transcriptPath = line.payload.transcript_path ?? null;
        try {
          // Trusted lifecycle context → late provider-ID binding (AC17).
          await bridge.tool("attach_agent_session", {
            sessionId: plan.sessionId,
            provider: plan.provider,
            connection: { kind: "local", installationId: plan.installationId },
            providerSessionId: line.payload.session_id,
            idempotencyKey: `bind:${plan.sessionId}:${line.payload.session_id}`,
          });
          log(
            `Capture connected · provider session ${line.payload.session_id}`,
          );
        } catch (error) {
          log(
            `capture: provider binding failed (${error instanceof Error ? error.message : "unknown"})`,
          );
        }
      }
      if (line.event === "SessionEnd" || line.event === "Stop") {
        await bridge.flushParts().catch(() => undefined);
        markHostFlushed(sessionDir, bridge.ackedPartCount);
      }
      if (line.event === "SessionEnd") sessionEnded = true;
    }
    if (plan.provider === "claude" && transcriptPath) {
      try {
        const tail = readTranscriptTail(transcriptPath, transcriptOffset);
        noteTranscriptSeen();
        transcriptOffset = tail.offset;
        if (tail.body) {
          for (const rawLine of tail.body.split("\n").filter(Boolean)) {
            const mapped = mapClaudeTranscriptLine(rawLine);
            if (mapped.unrecognized) bridge.countUnrecognized();
            if (mapped.modelId) bridge.observeModel(mapped.modelId);
            if (mapped.timing) {
              // control-room AC3.7: pair observed timestamps into the
              // intervals the usage aggregator has always known how to sum.
              for (const interval of timing.observe(mapped.timing)) {
                bridge.recordInterval(interval);
              }
            }
            for (const event of mapped.events) bridge.record(event);
          }
        }
      } catch {
        // transcript may rotate; next poll retries. But NEVER having seen it
        // is a different animal (AGE-957): warn once + stamp the marker so
        // the silence is visible instead of reading as a healthy host.
        if (
          !transcriptSeen &&
          !transcriptWarned &&
          Date.now() - hostStartedMs > 60_000
        ) {
          transcriptWarned = true;
          markHostTranscript(sessionDir, false);
          log(
            `capture: transcript never appeared at ${transcriptPath} — observing no events; usage will be unavailable. End the session and re-align to rebind.`,
          );
        }
      }
    }
    if (plan.provider === "codex" && transcriptPath) {
      try {
        const tail = readTranscriptTail(transcriptPath, transcriptOffset);
        noteTranscriptSeen();
        transcriptOffset = tail.offset;
        if (tail.body) {
          for (const rawLine of tail.body.split("\n").filter(Boolean)) {
            const mapped = mapCodexRolloutLine(rawLine);
            if (mapped.modelId) {
              codexModelId = mapped.modelId;
              bridge.observeModel(mapped.modelId);
            }
            if (mapped.turn?.phase === "started") {
              codexTurnId = mapped.turn.id;
              codexRolloutTurnStarts.set(mapped.turn.id, mapped.turn.at);
            } else if (mapped.turn?.phase === "completed") {
              const startedAt = codexRolloutTurnStarts.get(mapped.turn.id);
              if (startedAt !== undefined) {
                if (mapped.turn.at >= startedAt) {
                  bridge.recordInterval({
                    kind: "turn",
                    id: mapped.turn.id,
                    startedAt,
                    endedAt: mapped.turn.at,
                  });
                } else {
                  bridge.recordUnclosedInterval("turn", mapped.turn.id);
                }
                codexRolloutTurnStarts.delete(mapped.turn.id);
              }
              if (codexTurnId === mapped.turn.id) codexTurnId = null;
            }
            const event = mapped.event;
            if (!event) continue;
            bridge.record({
              ...event,
              payload: {
                ...(event.payload as object),
                ...(codexTurnId ? { turnId: codexTurnId } : {}),
                ...(codexModelId ? { modelId: codexModelId } : {}),
              },
            });
          }
        }
      } catch {
        if (
          !transcriptSeen &&
          !transcriptWarned &&
          Date.now() - hostStartedMs > 60_000
        ) {
          transcriptWarned = true;
          markHostTranscript(sessionDir, false, transcriptPath);
          log(
            `capture: Codex rollout never appeared at ${transcriptPath} — token usage will be unavailable. End the session and re-align to rebind.`,
          );
        }
      }
    }
    // TPM Slice 2 (AC2.5): `jentrix align --task <other>` asks the live host
    // to flush a usage receipt onto the OLD alignment before the server
    // closes its interval — the end-request.json idiom, acked by DELETING
    // the marker only after the server acknowledged the beat. Runs AFTER the
    // transcript tail above so the flush carries everything observed so far.
    // A failed post keeps the marker; the CLI's bounded wait times out and
    // discloses that the smear stays bounded by one beat window.
    const flushRequestPath = join(sessionDir, "flush-request.json");
    if (existsSync(flushRequestPath)) {
      const acked = await bridge.flushUsageNow().catch(() => false);
      if (acked) {
        try {
          unlinkSync(flushRequestPath);
        } catch {
          // unremovable marker: the CLI times out and proceeds — harmless
        }
      }
    }
    await fileOpeningPrompt();
    // Detached watch capture uploads as it goes (bounded to one flush per
    // 15s window) so `session end` finds little left to converge; the spool
    // advances past acked slots, so a flushed part number is never reused.
    const nowMs = Date.now();
    if (!sessionEnded && nowMs - lastPeriodicFlushAt >= 15_000) {
      lastPeriodicFlushAt = nowMs;
      await bridge.flushParts().catch(() => undefined);
      // Stamp the ack state so `session status` can tell an empty spool
      // (everything acknowledged) from a spool that never captured.
      markHostFlushed(sessionDir, bridge.ackedPartCount);
    }
    await bridge.maybeHeartbeat();
  };

  let timer = setInterval(() => {
    void poll();
  }, 2_000);

  // JEN-167: the close is a LOOP, not a straight line, because the evidence
  // floor is designed to refuse and be complied with. A refused close leaves
  // the session open, so the host that records it must stay up through the
  // comply work and close on the operator's NEXT `session end` — the tail
  // where the memo, the gap and the retry happen is exactly the segment a
  // dying host used to drop from the skeleton, the heartbeats and telemetry.
  let exitCode = 0;
  let result: Awaited<ReturnType<SessionBridge["complete"]>> | null = null;
  for (;;) {
    exitCode = await (watch
      ? // Watch mode: live capture beside the operator's own provider process.
        // End signals: the SessionEnd lifecycle hook, an end request from
        // `jentrix session end`, or a heartbeat 409 (session terminal
        // server-side — the out-of-band case the hooks can never deliver).
        new Promise<number>((resolve) => {
          const check = setInterval(() => {
            if (sessionEnded || bridge.sessionInactive) {
              clearInterval(check);
              resolve(0);
            }
          }, 1_000);
        })
      : new Promise<number>((resolve) => {
          child!.once("error", () => resolve(1));
          child!.once("exit", (code, signal) =>
            resolve(code ?? (signal ? 130 : 0)),
          );
        }));
    clearInterval(timer);
    await poll().catch(() => undefined);
    await bridge.flushParts().catch(() => undefined);
    // control-room AC3.7: a tool that never returned is a NAMED gap, not a
    // silently shorter total — the aggregator degrades coverage to PARTIAL on
    // an interval with no terminal event, which is the honest reading.
    for (const id of timing.unclosedToolIds()) {
      bridge.recordUnclosedInterval("tool", id);
    }
    for (const id of codexRolloutTurnStarts.keys()) {
      bridge.recordUnclosedInterval("turn", id);
    }

    // The forced pre-close beat (usage + skeleton, all providers) now lives in
    // bridge.complete() itself — no provider-specific flush here.

    const end = await endRepoState(plan.repoRoot);
    let failure: unknown = null;
    // JEN-295: only the operator's own `session end` is a COMPLETED close. A
    // provider exit with no end request used to attempt one too, and a floor
    // refusal then left the host up forever (observed: a host heartbeating 26
    // hours after its Claude Code session ended). It closes INTERRUPTED
    // instead — no floor, resumable, still pushable — and `jentrix session end
    // <id>` completes it properly later.
    const providerExit = watch && !endRequested;
    if (providerExit && !sessionEnded && bridge.sessionInactive) {
      // JEN-304: the SERVER already holds this session terminal — a heartbeat
      // answered 409 SESSION_NOT_ACTIVE (the liveness sweep, an end from
      // another machine). Nothing here ended it, so "the provider session
      // ended" would name a cause that did not happen, and completing it
      // again can only fail (observed 2026-09-02: the close's own
      // get_agent_session readback refused with SESSION_NOT_ACTIVE).
      log(
        `capture: the server reports session ${plan.sessionId} is no longer active (heartbeat 409) — this host stops; the spool is retained (\`jentrix session status ${plan.sessionId}\` shows the recorded state; a resume reconciles it)`,
      );
      markHostExited(sessionDir, 1);
      return 1;
    }
    if (providerExit) {
      log(
        `capture: the provider session ended with no \`jentrix session end\` — closing session ${plan.sessionId} as INTERRUPTED (typed pushes still land; \`jentrix session end ${plan.sessionId}\` completes it under the evidence floor)`,
      );
    }
    result = await bridge
      .complete({
        outcome: exitCode === 0 && !providerExit ? "COMPLETED" : "INTERRUPTED",
        end,
        acknowledgeEvidenceGaps: endAcknowledgeGaps,
        commitCount: endCommitCount,
      })
      .catch((error: unknown) => {
        failure = error;
        return null;
      });
    if (result) break;
    // A REFUSAL is not a crash: the server rejected the close and changed
    // nothing (the floor is evaluated before any write). Only a watched host
    // can be resumed — a launch-mode host has already lost its provider
    // process, so it exits and the CLI's server-side fallback relays.
    const refusal = watch ? evidenceFloorRefusalOf(failure) : null;
    if (refusal) {
      writeFileSync(
        join(sessionDir, "end-refusal.json"),
        JSON.stringify({
          refusedAt: new Date().toISOString(),
          message: refusal,
        }),
        { mode: 0o600 },
      );
      log(
        `capture: the close was refused by the evidence floor — this host (pid ${process.pid}) stays up; push the named evidence and re-run \`jentrix session end ${plan.sessionId}\``,
      );
      sessionEnded = false;
      endRequested = false;
      endAcknowledgeGaps = false;
      endCommitCount = null;
      timer = setInterval(() => {
        void poll();
      }, 2_000);
      continue;
    }
    log(
      `capture: completion failed (${failure instanceof Error ? failure.message : "unknown"}) — spool retained for retry`,
    );
    markHostExited(sessionDir, 1);
    return 1;
  }
  // AGE-649: the closing output is named in the same line as the summary, so an
  // operator can see whether it was stored without opening the session page.
  const output = result.finalResponseArtifactId
    ? ` · output ${result.finalResponseArtifactId}`
    : " · output not observed";
  // Say the status the server actually recorded — a provider-exit close is
  // INTERRUPTED, and "closed" over it would read as a completed session.
  const closed =
    result.status === "INTERRUPTED" ? "interrupted (resumable)" : "closed";
  log(
    !traceCapture
      ? `Session ${plan.sessionId} ${closed} · TRACE capture off (typed artifacts only) · summary ${result.summaryArtifactId ?? "—"}${output}`
      : result.captureComplete
        ? `Session ${plan.sessionId} ${closed} · capture complete · summary ${result.summaryArtifactId ?? "—"}${output}`
        : `Session ${plan.sessionId} ${closed} · CAPTURE PENDING (${result.pendingParts} part(s)) — re-run \`jentrix session status ${plan.sessionId}\``,
  );
  // Capture-off is a deliberate mode, not capture debt — never exit non-zero
  // for the transcript that was intentionally not recorded.
  const finalCode =
    result.captureComplete || !traceCapture ? exitCode : exitCode || 1;
  markHostExited(sessionDir, finalCode);
  return finalCode;
}

/**
 * Run a CODEX session: a persistent SDK Thread driven as a terminal REPL —
 * `runStreamed` per turn, structured events mapped deterministically, resume
 * through `resumeThread` (§15.2).
 */
export async function runCodexSessionHost(
  plan: SessionRunPlan,
  deps: HostDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const spoolRoot = plan.spoolRoot ?? defaultSpoolRoot();
  const spool = new SessionSpool(spoolRoot, plan.sessionId);
  // AGE-929: local liveness marker — `jentrix session status` probes this pid.
  writeHostMarker(spool.directory, {
    pid: process.pid,
    provider: "codex",
    mode: "launch",
  });
  const codexBearerSource = bearerSourceOf(plan, log);
  const bridge = new SessionBridge({
    jentrixBaseUrl: plan.jentrixBaseUrl,
    bearer: () => codexBearerSource.get(),
    onUnauthorized: (failed) => codexBearerSource.refresh(failed),
    sessionId: plan.sessionId,
    provider: "codex",
    spool,
    redactor: createSessionRedactor({ homedir: homedir() }),
    callTool: sessionCallTool(plan.mcpUrl, codexBearerSource, plan.sessionId),
    fetchImpl: deps.fetchImpl,
    collectSkeleton: plan.collectSkeleton !== false,
    log,
  });
  bridge.recordCapabilities({
    provider: "codex",
    providerVersion: null,
    observable: [
      "session",
      "assistant_message",
      "tool_call",
      "command",
      "file_change",
      "usage",
      "error",
    ],
    notObservable: ["plan", "tool_result"],
  });
  bridge.startObserving();

  // Provider SDK loaded lazily so probe/setup paths never touch it.
  const { Codex } = (await import("@openai/codex-sdk")) as {
    Codex: new (opts?: Record<string, unknown>) => {
      startThread(opts?: Record<string, unknown>): CodexThreadLike;
      resumeThread(id: string, opts?: Record<string, unknown>): CodexThreadLike;
    };
  };
  interface CodexThreadLike {
    id?: string | null;
    runStreamed(
      prompt: string,
    ): Promise<{ events: AsyncIterable<Record<string, unknown>> }>;
  }
  const codex = new Codex(
    plan.executablePath ? { codexPathOverride: plan.executablePath } : {},
  );
  const thread = plan.resumeProviderSessionId
    ? codex.resumeThread(plan.resumeProviderSessionId, {
        workingDirectory: plan.repoRoot,
        skipGitRepoCheck: true,
      })
    : codex.startThread({
        workingDirectory: plan.repoRoot,
        skipGitRepoCheck: true,
      });

  let bound = Boolean(plan.resumeProviderSessionId);
  // TPM Slice 2 (AC2.4): the model the runtime last named via turn_context;
  // null until one is observed — Codex receipts then stay in the null-model
  // bucket rather than carrying a guess.
  let currentModel: string | null = null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string) =>
    new Promise<string | null>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
      rl.once("close", () => resolve(null));
    });

  log("Codex connected session — empty line or Ctrl-D ends the session.");
  let outcome: "COMPLETED" | "INTERRUPTED" = "COMPLETED";
  try {
    for (;;) {
      const input = await ask("codex> ");
      if (input === null || input.trim() === "") break;
      const turnId = `turn:${Date.now()}`;
      bridge.markTurnStarted(turnId);
      bridge.record({ kind: "user_message", payload: { text: input } });
      try {
        const { events } = await thread.runStreamed(input);
        for await (const raw of events) {
          const mapped = mapCodexThreadEvent(raw);
          if (mapped.unrecognized) bridge.countUnrecognized();
          // TPM Slice 2 (AC2.4): a turn_context names the model for the
          // turns that follow — observed, and stamped onto their receipts.
          if (mapped.modelId) {
            currentModel = mapped.modelId;
            bridge.observeModel(mapped.modelId);
          }
          if (mapped.threadId && !bound) {
            bound = true;
            try {
              await bridge.tool("attach_agent_session", {
                sessionId: plan.sessionId,
                provider: "codex",
                connection: {
                  kind: "local",
                  installationId: plan.installationId,
                },
                providerSessionId: mapped.threadId,
                idempotencyKey: `bind:${plan.sessionId}:${mapped.threadId}`,
              });
              log(`Capture connected · provider thread ${mapped.threadId}`);
            } catch (error) {
              log(
                `capture: provider binding failed (${error instanceof Error ? error.message : "unknown"})`,
              );
            }
          }
          if (mapped.event) {
            const recorded = bridge.record({
              ...mapped.event,
              at: new Date().toISOString(),
              payload:
                mapped.event.kind === "usage"
                  ? {
                      ...(mapped.event.payload as object),
                      turnId,
                      // TPM Slice 2 (AC2.4): the model the runtime last named
                      // for this thread rides the receipt — absent when no
                      // turn_context was ever observed (null-model bucket,
                      // disclosed, never guessed).
                      ...(currentModel ? { modelId: currentModel } : {}),
                    }
                  : mapped.event.payload,
            });
            if (
              recorded.kind === "assistant_message" &&
              typeof (recorded.payload as { text?: string })?.text === "string"
            ) {
              process.stdout.write(
                `${(recorded.payload as { text: string }).text}\n`,
              );
            }
          }
        }
      } catch (error) {
        outcome = "INTERRUPTED";
        bridge.recordGap(
          `provider turn failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
        log("codex turn failed — session will close as INTERRUPTED");
        break;
      }
      bridge.markTurnEnded(turnId);
      await bridge.flushParts().catch(() => undefined);
      await bridge.maybeHeartbeat();
    }
  } finally {
    rl.close();
  }

  const end = await endRepoState(plan.repoRoot);
  const result = await bridge.complete({ outcome, end }).catch(() => null);
  if (!result) {
    markHostExited(spool.directory, 1);
    return 1;
  }
  log(
    result.captureComplete
      ? `Session ${plan.sessionId} closed · capture complete · output ${result.finalResponseArtifactId ?? "not observed"}`
      : `Session ${plan.sessionId} closed · CAPTURE PENDING (${result.pendingParts} part(s))`,
  );
  const finalCode = result.captureComplete ? 0 : 1;
  markHostExited(spool.directory, finalCode);
  return finalCode;
}

export async function runSessionHost(
  plan: SessionRunPlan,
  deps: HostDeps = {},
): Promise<number> {
  if (plan.mode !== "watch" && plan.provider === "codex") {
    // Client-runtime v2 (G6/§18): the CLI-shipped host carries NO provider
    // SDK, and Codex LAUNCH mode is the one arm that needs one
    // (`@openai/codex-sdk` below is deliberately left external and
    // unreachable here). The v2 shape is connect-beside: start Codex
    // yourself, then bind the live task.
    process.stderr.write(
      "CODEX_LAUNCH_UNAVAILABLE: the bundled session host cannot start a Codex conversation (no provider SDK ships with @jentrix/cli). Start Codex yourself, then run `jentrix session connect --provider codex` — capture attaches beside it.\n",
    );
    return 2;
  }
  return plan.mode === "watch" || plan.provider === "claude"
    ? runClaudeSessionHost(plan, deps)
    : runCodexSessionHost(plan, deps);
}
