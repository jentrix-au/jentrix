/**
 * Slice 5(a) of the capture-honesty goal — the watch host END TO END against
 * a synthetic transcript that grows over time: spool dir + host.json appear,
 * transcript events become spool parts, `jentrix session end`'s end-request
 * marker finalizes the host (flush → manifest → complete → exit stamp), and
 * every liveness file the CLI's `session status` reads is the REAL file the
 * host writes — not a mock of it. Network + MCP are stubbed; timers, files,
 * and the poll loop are real.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendHookEvent,
  evidenceFloorRefusalOf,
  readTranscriptTail,
  runClaudeSessionHost,
  runSessionHost,
  type SessionRunPlan,
} from "../src/session-host/session-host.js";

function transcriptLine(uuid: string, text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  })}\n`;
}

function codexUsageLine(
  ordinal: number,
  input: number,
  output: number,
  timestamp = new Date().toISOString(),
): string {
  return `${JSON.stringify({
    timestamp,
    ordinal,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 20,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 3,
        },
      },
    },
  })}\n`;
}

function codexTurnLine(
  timestamp: string,
  type: "task_started" | "task_complete",
  turnId: string,
): string {
  return `${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type, turn_id: turnId },
  })}\n`;
}

function codexTurnContextLine(
  timestamp: string,
  turnId: string,
  model: string,
): string {
  return `${JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { turn_id: turnId, model },
  })}\n`;
}

function codexUserLine(content: string[]): string {
  return `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: content.map((text) => ({ type: "input_text", text })),
    },
  })}\n`;
}

async function until(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(predicate(), `timed out waiting for: ${label}`);
}

test("transcript tail reads appended complete lines only", () => {
  const dir = mkdtempSync(join(tmpdir(), "stacks-tail-"));
  const path = join(dir, "rollout.jsonl");
  const prior = `${"private history ".repeat(1_000)}\n`;
  writeFileSync(path, `${prior}{"partial":`);

  const first = readTranscriptTail(path, Buffer.byteLength(prior));
  assert.deepEqual(first, { body: "", offset: Buffer.byteLength(prior) });

  appendFileSync(path, "true}\n");
  const second = readTranscriptTail(path, first.offset);
  assert.equal(second.body, '{"partial":true}\n');
  assert.equal(second.offset, Buffer.byteLength(`${prior}{"partial":true}\n`));
});

test("watch host: growing transcript → spool → end request → honest completion", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-watch-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-watch-repo-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptLine("u1", "first turn"));

  const partUploads: Array<{ part: number; body: string }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/parts")) {
      const body = JSON.parse(String(init?.body)) as {
        part: number;
        body: string;
      };
      partUploads.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ checksum: `ack-${body.part}` }),
        text: async () => "{}",
      } as unknown as Response;
    }
    if (target.includes("/heartbeat")) {
      // First heartbeat waits out the 30s throttle window (AC42), longer
      // than this whole test — throttling itself is unit-tested on the bridge.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => "{}",
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${target}`);
  }) as typeof fetch;

  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    toolCalls.push({ name, args });
    if (name === "get_agent_session") {
      return { updatedAt: "2026-08-07T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      return {
        status: "COMPLETED",
        captureComplete: true,
        summaryArtifactId: "art_summary",
      };
    }
    return {};
  };

  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_watch_1",
      provider: "claude",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_watch_bearer",
      repoRoot: workDir, // not a git repo — end state degrades to nulls
      installationId: "install-watch",
      mode: "watch",
      transcriptPath,
      spoolRoot,
      // This variant IMPORTS the pre-attach history (the "first turn"
      // assertions below depend on it); the default-mode test asserts the
      // converse — capture starts at the attach point.
      importHistory: true,
    },
    { fetchImpl, callTool, log: () => undefined },
  );

  const sessionDir = join(spoolRoot, "ses_watch_1");

  // The host marks itself LIVE and captures the pre-existing transcript line.
  await until(
    () => existsSync(join(sessionDir, "host.json")),
    5_000,
    "host.json liveness marker",
  );
  const marker = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { pid: number; mode: string; exitedAt?: string };
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.mode, "watch");
  assert.equal(marker.exitedAt, undefined, "live host has no exit stamp");

  // The pre-existing transcript line reaches the SERVER (the periodic flush
  // uploads and deletes spooled parts in the same poll tick, so the upload
  // stream — not the transient on-disk file — is the observable).
  await until(
    () => partUploads.some((upload) => upload.body.includes("first turn")),
    6_000,
    "first transcript line uploaded",
  );

  // The transcript grows mid-session; the tail spools it into the NEXT part
  // (an acked slot is never reused), which stays on disk until the next
  // flush window — the stable moment `session status` would see parts.
  appendFileSync(transcriptPath, transcriptLine("u2", "second turn"));
  await until(
    () => {
      const parts = readdirSync(sessionDir).filter((name) =>
        /^part-\d{6}\.ndjson$/.test(name),
      );
      return parts.some((name) =>
        readFileSync(join(sessionDir, name), "utf8").includes("second turn"),
      );
    },
    6_000,
    "second transcript line spooled",
  );

  // `jentrix session end` hands the live host the end request.
  writeFileSync(
    join(sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  const exitCode = await hostPromise;
  assert.equal(exitCode, 0);

  // Marker stamped, request consumed, spool converged (every part acked).
  const exited = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { exitedAt?: string; exitCode?: number };
  assert.ok(exited.exitedAt, "exit stamped for `session end` to observe");
  assert.equal(exited.exitCode, 0);
  assert.ok(
    !existsSync(join(sessionDir, "end-request.json")),
    "a consumed end request cannot end a future resume",
  );
  assert.ok(partUploads.length >= 1, "trace parts uploaded");
  assert.ok(
    partUploads.some((upload) => upload.body.includes("second turn")),
    "the mid-session growth reached the server",
  );
  assert.equal(
    readdirSync(sessionDir).filter((name) => /^part-\d{6}\.ndjson$/.test(name))
      .length,
    0,
    "acked parts deleted — nothing pending",
  );

  const complete = toolCalls.find((c) => c.name === "complete_agent_session");
  assert.ok(complete, "the HOST completed the session (owns the manifest)");
  assert.equal(complete!.args.outcome, "COMPLETED");
  const manifest = complete!.args.manifest as {
    parts: Array<{ part: number; checksum: string }>;
  };
  assert.ok(manifest.parts.length >= 1, "manifest names the acked parts");
  assert.equal(complete!.args.captureError, null);
});

test("default watch capture starts AT the attach point — history needs importHistory", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-watch2-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-watch2-repo-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  // Multibyte pre-attach content: byte length ≠ character length, so a
  // char-indexed tail would misalign the very first post-attach read.
  writeFileSync(
    transcriptPath,
    transcriptLine("u1", "pre-attach history — стенограмма №1 →"),
  );

  const partUploads: Array<{ part: number; body: string }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/parts")) {
      const body = JSON.parse(String(init?.body)) as {
        part: number;
        body: string;
      };
      partUploads.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ checksum: `ack-${body.part}` }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;
  const callTool = async (name: string) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-08-07T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      return {
        status: "COMPLETED",
        captureComplete: true,
        summaryArtifactId: "art",
      };
    }
    return {};
  };

  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_watch_2",
      provider: "claude",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_watch_bearer",
      repoRoot: workDir,
      installationId: "install-watch",
      mode: "watch",
      transcriptPath,
      spoolRoot,
      // Deliberately NO importHistory — the documented default.
    },
    { fetchImpl, callTool, log: () => undefined },
  );

  const sessionDir = join(spoolRoot, "ses_watch_2");
  await until(
    () => existsSync(join(sessionDir, "host.json")),
    5_000,
    "host.json liveness marker",
  );
  appendFileSync(transcriptPath, transcriptLine("u2", "post-attach turn"));
  await until(
    () => partUploads.some((u) => u.body.includes("post-attach turn")),
    8_000,
    "post-attach growth uploaded",
  );

  // The flush stamped its ack state for `session status` to read (the
  // "spool empty" ambiguity: nothing captured vs everything acknowledged).
  const flushed = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { ackedParts?: number; lastFlushAt?: string };
  assert.ok(
    (flushed.ackedParts ?? 0) >= 1,
    "host.json carries the acked-part count after a flush",
  );
  assert.ok(flushed.lastFlushAt, "host.json carries the last flush time");

  writeFileSync(
    join(sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  const exitCode = await hostPromise;
  assert.equal(exitCode, 0);
  assert.ok(
    !partUploads.some((u) => u.body.includes("pre-attach history")),
    "pre-attach history stays OUT of capture without importHistory",
  );
  assert.ok(
    partUploads.some((u) => u.body.includes("post-attach turn")),
    "post-attach events are captured",
  );
});

test("Codex watch host filters hooks and records rollout token receipts", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-codex-watch-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-codex-watch-repo-"));
  const hookDir = mkdtempSync(join(tmpdir(), "stacks-codex-hooks-"));
  const transcriptPath = join(workDir, "rollout-thread-own.jsonl");
  writeFileSync(
    transcriptPath,
    [
      codexUserLine([
        "<recommended_plugins>hidden",
        "# AGENTS.md instructions\nhidden",
        "<environment_context>hidden",
      ]),
      "partial json\n",
      codexUserLine(["  Owned opening prompt.  "]),
      codexUserLine(["later prompt"]),
      codexTurnLine("2026-08-24T07:59:59.800Z", "task_started", "turn-own"),
      codexTurnContextLine(
        "2026-08-24T07:59:59.900Z",
        "turn-own",
        "gpt-5.6-sol",
      ),
      codexUsageLine(1, 999, 999),
    ].join(""),
  );
  const partUploads: Array<{ part: number; body: string }> = [];
  const artifactUploads: Array<Record<string, unknown>> = [];
  const heartbeats: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    if (String(url).includes("/artifacts")) {
      artifactUploads.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ artifactId: "art_prompt" }),
      } as unknown as Response;
    }
    if (String(url).includes("/parts")) {
      const body = JSON.parse(String(init?.body)) as {
        part: number;
        body: string;
      };
      partUploads.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ checksum: `ack-${body.part}` }),
        text: async () => "{}",
      } as unknown as Response;
    }
    if (String(url).includes("/heartbeat")) {
      heartbeats.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    toolCalls.push({ name, args });
    return name === "get_agent_session"
      ? { updatedAt: "2026-08-07T00:00:00.000Z" }
      : name === "complete_agent_session"
        ? {
            status: "COMPLETED",
            captureComplete: true,
            summaryArtifactId: "art_summary",
          }
        : {};
  };

  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_codex_watch",
      provider: "codex",
      providerSessionId: "thread-own",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_watch_bearer",
      repoRoot: workDir,
      installationId: "install-watch",
      mode: "watch",
      hookDir,
      spoolRoot,
    },
    { fetchImpl, callTool, log: () => undefined },
  );

  await until(
    () => existsSync(join(spoolRoot, "ses_codex_watch", "host.json")),
    5_000,
    "Codex host marker",
  );
  writeFileSync(
    join(spoolRoot, "ses_codex_watch", "prompt-request.json"),
    "{}",
  );
  appendHookEvent(
    hookDir,
    "UserPromptSubmit",
    JSON.stringify({ session_id: "thread-foreign", prompt: "foreign prompt" }),
  );
  appendHookEvent(
    hookDir,
    "UserPromptSubmit",
    JSON.stringify({
      session_id: "thread-own",
      prompt: "owned prompt",
      transcript_path: transcriptPath,
    }),
  );
  await until(
    () => {
      const marker = JSON.parse(
        readFileSync(join(spoolRoot, "ses_codex_watch", "host.json"), "utf8"),
      ) as { transcriptSeen?: boolean };
      return marker.transcriptSeen === true;
    },
    5_000,
    "Codex rollout binding",
  );
  appendFileSync(
    transcriptPath,
    [
      codexTurnLine("2026-08-24T08:00:00.000Z", "task_started", "turn-two"),
      codexUsageLine(2, 42, 7, "2026-08-24T08:00:04.000Z"),
      codexTurnContextLine(
        "2026-08-24T08:00:04.100Z",
        "turn-two",
        "gpt-5.6-sol",
      ),
      codexTurnLine("2026-08-24T08:00:06.000Z", "task_complete", "turn-two"),
    ].join(""),
  );
  appendHookEvent(
    hookDir,
    "PostToolUse",
    JSON.stringify({
      session_id: "thread-own",
      tool_name: "shell",
      tool_input: { command: "pwd" },
      tool_response: "ok",
    }),
  );
  appendHookEvent(
    hookDir,
    "Stop",
    JSON.stringify({
      session_id: "thread-own",
      last_assistant_message: "owned response",
    }),
  );
  appendHookEvent(
    hookDir,
    "SessionEnd",
    JSON.stringify({ session_id: "thread-own" }),
  );

  assert.equal(await hostPromise, 0);
  const capture = partUploads.map((part) => part.body).join("\n");
  assert.match(capture, /owned prompt/);
  assert.match(capture, /owned response/);
  assert.match(capture, /tool_call/);
  assert.doesNotMatch(capture, /foreign prompt/);
  assert.match(capture, /\"kind\":\"usage\"/);
  assert.doesNotMatch(capture, /999/);
  assert.deepEqual(
    artifactUploads.filter((upload) => upload.kind === "prompt"),
    [
      {
        kind: "prompt",
        title: "Opening prompt",
        body: "Owned opening prompt.",
      },
    ],
  );
  assert.equal(
    existsSync(join(spoolRoot, "ses_codex_watch", "prompt-request.json")),
    false,
  );
  assert.equal(
    existsSync(join(spoolRoot, "ses_codex_watch", "prompt-filed.json")),
    true,
  );
  const complete = toolCalls.find(
    (call) => call.name === "complete_agent_session",
  );
  const usage = complete?.args.usage as Record<string, unknown>;
  assert.equal(usage.inputTokens, 42);
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.cacheReadTokens, 20);
  assert.equal(usage.cacheCreationTokens, 0);
  assert.equal(usage.reasoningOutputTokens, 3);
  assert.equal(usage.toolDurationMs, null);
  assert.equal(usage.coverage, "COMPLETE");
  assert.equal(usage.providerActiveDurationMs, 6_000);
  assert.ok(
    heartbeats.some((heartbeat) => heartbeat.modelId === "gpt-5.6-sol"),
    "rollout turn_context reaches the session model heartbeat",
  );
  assert.ok(
    heartbeats.some((heartbeat) => {
      const live = heartbeat.usage as
        { perModel?: Array<{ modelId?: string | null }> } | undefined;
      return live?.perModel?.some((bucket) => bucket.modelId === "gpt-5.6-sol");
    }),
    "pre-attach turn_context prices the first post-attach token receipt",
  );
});

// ---------------------------------------------------------------------------
// JEN-295 — the Claude watch host and the machine-global plugin ledger. The
// host used to read `<spool>/<session>/hooks.ndjson`, a file nothing writes in
// watch mode, so it never saw its own session's SessionEnd and outlived its
// Claude Code process indefinitely (observed: a host heartbeating 26 hours
// after the provider exited). Given the ledger, it must (a) ignore every other
// session's lines and (b) close on its OWN SessionEnd — as INTERRUPTED, since
// no operator `session end` asked for a COMPLETED close and nobody is left to
// comply with an evidence-floor refusal.
// ---------------------------------------------------------------------------

test("Claude watch host: filters the shared ledger by provider session id and closes INTERRUPTED on its own SessionEnd", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-jen295-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-jen295-repo-"));
  const hookDir = mkdtempSync(join(tmpdir(), "stacks-jen295-hooks-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptLine("u1", "before attach"));
  // Pre-attach history in the ledger — including THIS session's own earlier
  // start/end pair (a `claude --resume`), which a replay would trip over.
  appendHookEvent(
    hookDir,
    "SessionStart",
    JSON.stringify({ session_id: "cc-own", transcript_path: transcriptPath }),
  );
  appendHookEvent(
    hookDir,
    "SessionEnd",
    JSON.stringify({ session_id: "cc-own" }),
  );
  appendHookEvent(
    hookDir,
    "SessionStart",
    JSON.stringify({ session_id: "cc-own", transcript_path: transcriptPath }),
  );

  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, checksum: "ack" }),
      text: async () => "{}",
    }) as unknown as Response) as typeof fetch;
  const completions: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      completions.push(args);
      return {
        status: String(args.outcome),
        captureComplete: true,
        summaryArtifactId: "art_summary",
      };
    }
    return {};
  };
  const logs: string[] = [];
  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_jen295",
      provider: "claude",
      providerSessionId: "cc-own",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_watch_bearer",
      repoRoot: workDir,
      installationId: "install-watch",
      mode: "watch",
      transcriptPath,
      hookDir,
      spoolRoot,
      captureTrace: false,
    },
    { fetchImpl, callTool, log: (line) => logs.push(line) },
  );
  const sessionDir = join(spoolRoot, "ses_jen295");
  await until(
    () => existsSync(join(sessionDir, "host.json")),
    5_000,
    "host.json liveness marker",
  );

  // Another Claude Code session on the same machine ends — not ours.
  appendHookEvent(
    hookDir,
    "SessionEnd",
    JSON.stringify({ session_id: "cc-foreign", reason: "other" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  assert.equal(completions.length, 0, "a foreign SessionEnd must not close us");
  const live = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { exitedAt?: string };
  assert.equal(live.exitedAt, undefined, "still running");

  // Our own provider session ends — Claude Code exited without /jentrix-end.
  appendHookEvent(
    hookDir,
    "SessionEnd",
    JSON.stringify({ session_id: "cc-own", reason: "prompt_input_exit" }),
  );
  assert.equal(await hostPromise, 0);
  assert.equal(completions.length, 1);
  assert.equal(
    completions[0]!.outcome,
    "INTERRUPTED",
    "a provider exit is not the operator's COMPLETED close",
  );
  assert.ok(
    logs.some((line) => /closing session ses_jen295 as INTERRUPTED/.test(line)),
    logs.join("\n"),
  );
  assert.ok(
    logs.some((line) => /interrupted \(resumable\)/.test(line)),
    "the closing line names the recorded status, not 'closed'",
  );
  const exited = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { exitedAt?: string; exitCode?: number };
  assert.ok(exited.exitedAt, "the exit is stamped");
  assert.equal(exited.exitCode, 0);
});

test("watch host: the operator's end request still closes COMPLETED, even with the ledger present", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-jen295b-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-jen295b-repo-"));
  const hookDir = mkdtempSync(join(tmpdir(), "stacks-jen295b-hooks-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptLine("u1", "work"));
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, checksum: "ack" }),
      text: async () => "{}",
    }) as unknown as Response) as typeof fetch;
  const completions: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      completions.push(args);
      return { status: "COMPLETED", captureComplete: true };
    }
    return {};
  };
  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_jen295b",
      provider: "claude",
      providerSessionId: "cc-own-b",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_watch_bearer",
      repoRoot: workDir,
      installationId: "install-watch",
      mode: "watch",
      transcriptPath,
      hookDir,
      spoolRoot,
      captureTrace: false,
    },
    { fetchImpl, callTool, log: () => undefined },
  );
  const sessionDir = join(spoolRoot, "ses_jen295b");
  await until(
    () => existsSync(join(sessionDir, "host.json")),
    5_000,
    "host.json liveness marker",
  );
  writeFileSync(
    join(sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await hostPromise, 0);
  assert.equal(completions[0]!.outcome, "COMPLETED");
});

// ---------------------------------------------------------------------------
// JEN-167 — an evidence-floor refusal is not a crash. The floor is DESIGNED to
// be followed by more in-session work (push the memo or gap, retry), so the
// host that records that work must survive its own refused close: no exit
// stamp, a refusal marker for `session end` to relay, and a poll loop still
// tailing the transcript. The production dogfood
// (reports/session-evidence-prod-dogfood-2026-08-26.md §8.1) recorded the
// opposite — the host exited (code 1) at the refusal and the comply tail went
// unrecorded.
// ---------------------------------------------------------------------------

function floorRefusal(): Error {
  // Verbatim shape of what `sessionCallTool` throws: the tool name, then the
  // MCP error envelope the server's 409 produced.
  return new Error(
    `complete_agent_session failed: ${JSON.stringify({
      error: {
        code: "CONFLICT",
        message:
          "EVIDENCE_FLOOR: 1 evidence check(s) unmet — the session's durable record cannot support a later review.\n- E2: 1 commit(s) with no decision memo and no declared deviation. Fix: push the decision record, then retry",
        hint: "retry after pushing the named evidence",
      },
    })}`,
  );
}

test("evidenceFloorRefusalOf unwraps the envelope and ignores real failures", () => {
  const refusal = evidenceFloorRefusalOf(floorRefusal());
  assert.ok(refusal);
  assert.ok(
    refusal.startsWith("EVIDENCE_FLOOR: 1 evidence check(s) unmet"),
    "the CLI relays the envelope's own message, not the transport wrapper",
  );
  assert.match(refusal, /E2: 1 commit\(s\)/);
  // A crash, a dead bearer, a lost network: NOT a refusal — the host must
  // still exit and leave the CLI its server-side fallback.
  assert.equal(evidenceFloorRefusalOf(new Error("fetch failed")), null);
  assert.equal(evidenceFloorRefusalOf(null), null);
  // A refusal that never went through the MCP wrapper still reads as one.
  assert.equal(
    evidenceFloorRefusalOf(new Error("EVIDENCE_FLOOR: 2 checks unmet")),
    "EVIDENCE_FLOOR: 2 checks unmet",
  );
});

test("watch host survives an evidence-floor refusal and closes on the retry", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-jen167-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-jen167-repo-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptLine("u1", "work before the end"));

  const partUploads: Array<{ part: number; body: string }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    if (String(url).includes("/parts")) {
      const body = JSON.parse(String(init?.body)) as {
        part: number;
        body: string;
      };
      partUploads.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ checksum: `ack-${body.part}` }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;

  const completions: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-08-26T03:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      completions.push(args);
      // The floor refuses the FIRST close and nothing else.
      if (completions.length === 1) throw floorRefusal();
      return {
        status: "COMPLETED",
        captureComplete: true,
        summaryArtifactId: "art_summary",
      };
    }
    return {};
  };

  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_floor",
      provider: "claude",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_floor_bearer",
      repoRoot: workDir,
      installationId: "install-floor",
      mode: "watch",
      transcriptPath,
      spoolRoot,
      importHistory: true,
    },
    { fetchImpl, callTool, log: () => undefined },
  );

  const sessionDir = join(spoolRoot, "ses_floor");
  await until(
    () => existsSync(join(sessionDir, "host.json")),
    5_000,
    "host.json liveness marker",
  );

  // First `jentrix session end` — refused by the floor.
  writeFileSync(
    join(sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  await until(
    () => existsSync(join(sessionDir, "end-refusal.json")),
    8_000,
    "the refusal marker `session end` relays",
  );
  const refusal = JSON.parse(
    readFileSync(join(sessionDir, "end-refusal.json"), "utf8"),
  ) as { message?: string };
  assert.match(refusal.message ?? "", /^EVIDENCE_FLOOR: /);

  // …and the host is STILL RUNNING: no exit stamp, and `session status` reads
  // exactly this file to report local liveness.
  const live = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { pid: number; exitedAt?: string };
  assert.equal(live.pid, process.pid);
  assert.equal(live.exitedAt, undefined, "a refused close is not an exit");

  // The comply work still reaches the record — the whole point of surviving.
  appendFileSync(transcriptPath, transcriptLine("u2", "the comply tail"));
  await until(
    () => partUploads.some((upload) => upload.body.includes("comply tail")),
    8_000,
    "post-refusal transcript growth captured",
  );

  // The retry closes — with the operator's acknowledgement and the CLI's own
  // commit count, both of which only reach the server through the request.
  writeFileSync(
    join(sessionDir, "end-request.json"),
    JSON.stringify({
      requestedAt: new Date().toISOString(),
      acknowledgeEvidenceGaps: true,
      commitCount: 3,
    }),
    { mode: 0o600 },
  );
  assert.equal(await hostPromise, 0);
  assert.equal(completions.length, 2, "one refused close, one that landed");
  assert.equal(completions[0].acknowledgeEvidenceGaps, undefined);
  assert.equal(completions[1].acknowledgeEvidenceGaps, true);
  assert.equal(completions[1].commitCount, 3);
  const exited = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { exitedAt?: string; exitCode?: number };
  assert.ok(
    exited.exitedAt,
    "the retry stamps the exit `session end` waits on",
  );
  assert.equal(exited.exitCode, 0);
});

test("a close that FAILS for any other reason still exits — the fallback stands", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-jen167b-spool-"));
  const workDir = mkdtempSync(join(tmpdir(), "stacks-jen167b-repo-"));
  const transcriptPath = join(workDir, "transcript.jsonl");
  writeFileSync(transcriptPath, transcriptLine("u1", "work"));

  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "{}",
    }) as unknown as Response) as typeof fetch;
  const callTool = async (name: string) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-08-26T03:00:00.000Z" };
    }
    // A dead bearer, a lost network, a crash mid-finalize: NOT a refusal.
    if (name === "complete_agent_session") throw new Error("fetch failed");
    return {};
  };

  const hostPromise = runClaudeSessionHost(
    {
      protocolVersion: 1,
      sessionId: "ses_dead",
      provider: "claude",
      jentrixBaseUrl: "https://stacks.example",
      mcpUrl: "https://stacks.example/api/mcp",
      bearer: "tmo_dead_bearer",
      repoRoot: workDir,
      installationId: "install-dead",
      mode: "watch",
      transcriptPath,
      spoolRoot,
    },
    { fetchImpl, callTool, log: () => undefined },
  );
  const sessionDir = join(spoolRoot, "ses_dead");
  await until(
    () => existsSync(join(sessionDir, "host.json")),
    5_000,
    "host.json liveness marker",
  );
  writeFileSync(
    join(sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await hostPromise, 1, "a failed close still exits non-zero");
  const marker = JSON.parse(
    readFileSync(join(sessionDir, "host.json"), "utf8"),
  ) as { exitedAt?: string; exitCode?: number };
  assert.ok(marker.exitedAt, "the exit stamp the CLI's fallback waits on");
  assert.equal(marker.exitCode, 1);
  assert.equal(
    existsSync(join(sessionDir, "end-refusal.json")),
    false,
    "a crash must never masquerade as a refusal the CLI would relay",
  );
});

// Client-runtime v2 G6: the CLI-shipped host carries no provider SDK, so the
// one arm that needs one — codex LAUNCH — refuses with guidance BEFORE any
// SDK import can be reached. Watch mode (the MVP connect-beside path) is
// unaffected.
test("codex launch mode refuses in the CLI host (G6) — before any SDK import", async () => {
  const errs: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runSessionHost({
      protocolVersion: 1,
      sessionId: "s_refuse",
      provider: "codex",
      jentrixBaseUrl: "https://example.invalid",
      mcpUrl: "https://example.invalid/api/mcp",
      repoRoot: "/nowhere",
      installationId: "i-1",
      mode: "launch",
    } as SessionRunPlan);
    assert.equal(code, 2);
  } finally {
    process.stderr.write = original;
  }
  const err = errs.join("");
  assert.match(err, /CODEX_LAUNCH_UNAVAILABLE/);
  assert.match(err, /jentrix session connect --provider codex/);
});

// ---------------------------------------------------------------------------
// JEN-294 — a RESTARTED watch host used to tail from the transcript's current
// end and heartbeat a rollup over its own window only; the server wrote that
// as the session's totals while SessionUsageSegment kept history, so tokens
// under-stated after every restart. The spool already holds the previous
// host's last rollup (`usage.json`, written after every receipt): a watch host
// that is NOT importing history seeds one delta receipt per perModel bucket
// from it, names the seam (coverage PARTIAL, the range in missingRanges), and
// never unlinks the snapshot on start. Importing history replays the receipts
// the snapshot summarizes, so that variant must not seed.
// ---------------------------------------------------------------------------

function modelUsageLine(
  uuid: string,
  model: string,
  input: number,
  output: number,
): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      model,
      content: [{ type: "text", text: `turn ${uuid}` }],
      usage: { input_tokens: input, output_tokens: output },
    },
  })}\n`;
}

interface HeartbeatBody {
  usage?: {
    inputTokens: number | null;
    outputTokens: number | null;
    coverage: string;
    missingRanges?: string[];
    perModel?: Array<{
      modelId: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
    }>;
  };
}

interface SpoolSnapshot {
  rollup: {
    inputTokens: number;
    outputTokens: number;
    perModel: Array<{
      modelId: string | null;
      inputTokens: number;
      outputTokens: number;
    }>;
  };
  updatedAt: string;
}

function restartFixture(label: string) {
  const spoolRoot = mkdtempSync(join(tmpdir(), `stacks-${label}-spool-`));
  const workDir = mkdtempSync(join(tmpdir(), `stacks-${label}-repo-`));
  const transcriptPath = join(workDir, "transcript.jsonl");
  // Pre-attach history: outside every host's window unless imported.
  writeFileSync(transcriptPath, modelUsageLine("u0", "claude-a", 1000, 100));
  const heartbeats: HeartbeatBody[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    if (String(url).includes("/heartbeat")) {
      heartbeats.push(JSON.parse(String(init?.body)) as HeartbeatBody);
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, checksum: "ack" }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;
  const sessionId = `ses_${label}`;
  const plan = (overrides: Partial<SessionRunPlan> = {}): SessionRunPlan => ({
    protocolVersion: 1,
    sessionId,
    provider: "claude",
    providerSessionId: `cc-${label}`,
    jentrixBaseUrl: "https://stacks.example",
    mcpUrl: "https://stacks.example/api/mcp",
    bearer: "tmo_watch_bearer",
    repoRoot: workDir,
    installationId: "install-watch",
    mode: "watch",
    transcriptPath,
    spoolRoot,
    captureTrace: false,
    ...overrides,
  });
  const sessionDir = join(spoolRoot, sessionId);
  const readSnapshot = (): SpoolSnapshot | null => {
    try {
      return JSON.parse(
        readFileSync(join(sessionDir, "usage.json"), "utf8"),
      ) as SpoolSnapshot;
    } catch {
      return null;
    }
  };
  // A monotonic clock already past the 30 s heartbeat window, so a host's
  // FIRST poll beats — the assertions below are about that first beat.
  const monotonic = () => performance.now() + 60_000;
  return {
    transcriptPath,
    heartbeats,
    fetchImpl,
    plan,
    sessionDir,
    readSnapshot,
    monotonic,
  };
}

/**
 * A first host that records two models' receipts, then dies WITHOUT completing
 * (its close fails) — exactly the host a restart follows. The snapshot it wrote
 * after every receipt stays in the spool.
 */
async function runFirstHostThatDies(
  f: ReturnType<typeof restartFixture>,
): Promise<SpoolSnapshot> {
  const callTool = async (name: string) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      throw new Error("simulated host death before completion");
    }
    return {};
  };
  const host = runClaudeSessionHost(f.plan(), {
    fetchImpl: f.fetchImpl,
    callTool,
    log: () => undefined,
  });
  await until(
    () => existsSync(join(f.sessionDir, "host.json")),
    5_000,
    "first host live",
  );
  appendFileSync(f.transcriptPath, modelUsageLine("u1", "claude-a", 500, 50));
  appendFileSync(f.transcriptPath, modelUsageLine("u2", "claude-b", 300, 30));
  await until(
    () => (f.readSnapshot()?.rollup.perModel.length ?? 0) === 2,
    6_000,
    "the first host snapshotted both models",
  );
  writeFileSync(
    join(f.sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await host, 1, "the first host died before completing");
  const snapshot = f.readSnapshot();
  assert.ok(snapshot, "a failed close leaves the snapshot in the spool");
  assert.equal(snapshot!.rollup.inputTokens, 800, "its own window only");
  return snapshot!;
}

test("JEN-294: a restarted watch host seeds the session's totals from the spool snapshot and names the seam", async () => {
  const f = restartFixture("jen294");
  const snapshot = await runFirstHostThatDies(f);
  const beatsBefore = f.heartbeats.length;
  const completions: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      completions.push(args);
      return {
        status: "COMPLETED",
        captureComplete: true,
        summaryArtifactId: "art",
      };
    }
    return {};
  };
  const logs: string[] = [];
  const second = runClaudeSessionHost(f.plan(), {
    fetchImpl: f.fetchImpl,
    callTool,
    log: (line) => logs.push(line),
    monotonic: f.monotonic,
  });
  await until(
    () => f.heartbeats.length > beatsBefore,
    6_000,
    "the second host's first heartbeat",
  );
  const first = f.heartbeats[beatsBefore]!;
  assert.ok(
    first.usage,
    "the first beat carries usage — seeded, before any new receipt",
  );
  assert.ok(first.usage!.inputTokens! >= snapshot.rollup.inputTokens);
  assert.ok(first.usage!.outputTokens! >= snapshot.rollup.outputTokens);
  for (const bucket of snapshot.rollup.perModel) {
    const mine = first.usage!.perModel!.find(
      (b) => b.modelId === bucket.modelId,
    );
    assert.ok(mine, `bucket ${bucket.modelId} survives the restart`);
    assert.ok(mine!.inputTokens! >= bucket.inputTokens);
    assert.ok(mine!.outputTokens! >= bucket.outputTokens);
  }
  assert.equal(
    first.usage!.coverage,
    "PARTIAL",
    "coverage never reads COMPLETE across a restart",
  );
  const range = `restart baseline seeded from the spool snapshot of ${snapshot.updatedAt}`;
  assert.ok(
    first.usage!.missingRanges!.includes(range),
    JSON.stringify(first.usage!.missingRanges),
  );
  assert.ok(
    logs.some((l) => /usage baseline seeded from the spool snapshot/.test(l)),
  );
  assert.ok(f.readSnapshot(), "the snapshot is never unlinked on start");

  // Work after the restart lands ON TOP of the baseline.
  appendFileSync(f.transcriptPath, modelUsageLine("u3", "claude-a", 200, 20));
  await until(
    () =>
      (f.readSnapshot()?.rollup.inputTokens ?? 0) >=
      snapshot.rollup.inputTokens + 200,
    6_000,
    "a post-restart receipt lands on top of the baseline",
  );
  writeFileSync(
    join(f.sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await second, 0);
  const usage = completions[0]!.usage as {
    inputTokens: number;
    coverage: string;
    missingRanges: string[];
  };
  assert.equal(usage.inputTokens, snapshot.rollup.inputTokens + 200);
  assert.equal(usage.coverage, "PARTIAL");
  assert.ok(usage.missingRanges.includes(range));
  assert.equal(
    f.readSnapshot(),
    null,
    "a successful close unlinks the snapshot",
  );
});

test("JEN-294: a restarted host that imports history does NOT seed — the replay is the record", async () => {
  const f = restartFixture("jen294h");
  await runFirstHostThatDies(f);
  const beatsBefore = f.heartbeats.length;
  const completions: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      completions.push(args);
      return { status: "COMPLETED", captureComplete: true };
    }
    return {};
  };
  const logs: string[] = [];
  const second = runClaudeSessionHost(f.plan({ importHistory: true }), {
    fetchImpl: f.fetchImpl,
    callTool,
    log: (line) => logs.push(line),
    monotonic: f.monotonic,
  });
  await until(
    () => f.heartbeats.length > beatsBefore,
    6_000,
    "the second host's first heartbeat",
  );
  const first = f.heartbeats[beatsBefore]!;
  assert.ok(
    !(first.usage?.missingRanges ?? []).some((r) =>
      r.startsWith("restart baseline"),
    ),
    "no seed when importing history",
  );
  assert.ok(!logs.some((l) => /baseline seeded/.test(l)));
  writeFileSync(
    join(f.sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await second, 0);
  const usage = completions[0]!.usage as { inputTokens: number };
  assert.equal(
    usage.inputTokens,
    1800,
    "exactly the replayed receipts (u0+u1+u2) — the snapshot was not added on top",
  );
});

// JEN-304 — the close path used to log "the provider session ended" for BOTH
// end signals. When the SERVER already holds the session terminal (a heartbeat
// answered 409 SESSION_NOT_ACTIVE — the liveness sweep, an end from another
// machine), nothing here ended it and completing it again can only fail.
test("JEN-304: a heartbeat answered 409 SESSION_NOT_ACTIVE stops the host without a doomed completion and names the real cause", async () => {
  const f = restartFixture("jen304");
  const fetchImpl = (async (url: URL | string) => {
    if (String(url).includes("/heartbeat")) {
      const body = JSON.stringify({
        error: "SESSION_NOT_ACTIVE",
        status: "INTERRUPTED",
      });
      return {
        ok: false,
        status: 409,
        json: async () => JSON.parse(body),
        text: async () => body,
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, checksum: "ack" }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;
  const toolCalls: string[] = [];
  const callTool = async (name: string) => {
    toolCalls.push(name);
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    return {};
  };
  const logs: string[] = [];
  const code = await runClaudeSessionHost(f.plan(), {
    fetchImpl,
    callTool,
    log: (line) => logs.push(line),
    monotonic: f.monotonic,
  });
  assert.equal(code, 1);
  assert.ok(
    !toolCalls.includes("complete_agent_session"),
    "no completion attempted against a session the server holds terminal",
  );
  assert.ok(
    logs.some((l) => /no longer active \(heartbeat 409\)/.test(l)),
    logs.join("\n"),
  );
  assert.ok(
    !logs.some((l) => /the provider session ended/.test(l)),
    "the provider-exit wording is reserved for a provider exit",
  );
  const exited = JSON.parse(
    readFileSync(join(f.sessionDir, "host.json"), "utf8"),
  ) as { exitedAt?: string; exitCode?: number };
  assert.ok(exited.exitedAt);
  assert.equal(exited.exitCode, 1);
});

// JEN-294, operator return (2026-09-02): the seed rebuilt the totals but
// carried only the NEWEST restart note into namedGaps, then rewrote
// usage.json — a second restart permanently dropped every earlier specific
// gap. The previous host's missingRanges now travel with its totals.
test("JEN-294: a second restart keeps the earlier restart's ranges — usage.json never loses a previous host's gaps", async () => {
  const f = restartFixture("jen294c");
  const first = await runFirstHostThatDies(f);
  const firstRanges =
    (first.rollup as { missingRanges?: string[] }).missingRanges ?? [];
  const noteOf = (updatedAt: string) =>
    `restart baseline seeded from the spool snapshot of ${updatedAt}`;

  // Host B: seeds from A's snapshot, records one receipt, dies before
  // completing — its snapshot must carry A's ranges AND its own note.
  const dyingCallTool = async (name: string) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      throw new Error("simulated host death before completion");
    }
    return {};
  };
  const second = runClaudeSessionHost(f.plan(), {
    fetchImpl: f.fetchImpl,
    callTool: dyingCallTool,
    log: () => undefined,
    monotonic: f.monotonic,
  });
  await until(
    () =>
      (
        f.readSnapshot()?.rollup as { missingRanges?: string[] } | undefined
      )?.missingRanges?.includes(noteOf(first.updatedAt)) ?? false,
    6_000,
    "the second host rewrote usage.json with its restart note",
  );
  const rewritten = f.readSnapshot()!;
  const rewrittenRanges =
    (rewritten.rollup as { missingRanges?: string[] }).missingRanges ?? [];
  for (const range of firstRanges) {
    assert.ok(
      rewrittenRanges.includes(range),
      `the rewrite kept the earlier range: ${range}`,
    );
  }
  appendFileSync(f.transcriptPath, modelUsageLine("u3", "claude-a", 200, 20));
  await until(
    () =>
      (f.readSnapshot()?.rollup.inputTokens ?? 0) >=
      first.rollup.inputTokens + 200,
    6_000,
    "the second host's receipt landed on top of the baseline",
  );
  writeFileSync(
    join(f.sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await second, 1, "the second host died before completing");
  const secondSnapshot = f.readSnapshot()!;

  // Host C: seeds from B's snapshot. Its first heartbeat must name BOTH
  // restarts and carry the accumulated totals — nothing from A was lost.
  const beatsBefore = f.heartbeats.length;
  const completions: Array<Record<string, unknown>> = [];
  const callTool = async (name: string, args: Record<string, unknown>) => {
    if (name === "get_agent_session") {
      return { updatedAt: "2026-09-02T00:00:00.000Z" };
    }
    if (name === "complete_agent_session") {
      completions.push(args);
      return { status: "COMPLETED", captureComplete: true };
    }
    return {};
  };
  const third = runClaudeSessionHost(f.plan(), {
    fetchImpl: f.fetchImpl,
    callTool,
    log: () => undefined,
    monotonic: f.monotonic,
  });
  await until(
    () => f.heartbeats.length > beatsBefore,
    6_000,
    "the third host's first heartbeat",
  );
  const beat = f.heartbeats[beatsBefore]!.usage!;
  assert.ok(
    beat.missingRanges!.includes(noteOf(first.updatedAt)),
    "A→B note kept",
  );
  assert.ok(
    beat.missingRanges!.includes(noteOf(secondSnapshot.updatedAt)),
    "B→C note present",
  );
  assert.equal(
    beat.missingRanges!.filter((r) => r === noteOf(first.updatedAt)).length,
    1,
    "carried ranges are deduplicated",
  );
  assert.equal(beat.inputTokens, first.rollup.inputTokens + 200);
  assert.equal(beat.coverage, "PARTIAL");
  writeFileSync(
    join(f.sessionDir, "end-request.json"),
    JSON.stringify({ requestedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  assert.equal(await third, 0);
  const usage = completions[0]!.usage as { missingRanges: string[] };
  assert.ok(usage.missingRanges.includes(noteOf(first.updatedAt)));
  assert.ok(usage.missingRanges.includes(noteOf(secondSnapshot.updatedAt)));
});
