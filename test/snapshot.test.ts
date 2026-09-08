/**
 * P3 (2026-08-11 gap report) — the PreCompact handler. Two things the
 * evidence forces: it must resolve the alignment robustly, because the hook's
 * cwd is the SESSION's directory and in the reported run that directory had
 * no alignment marker at all (a cwd-first handler is a no-op in exactly the
 * sessions that need it); and it must never break the operator's `/compact`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  resolveSnapshotSession,
  runSessionSnapshot,
} from "../src/commands/snapshot";
import { type PushDeps } from "../src/commands/push";
import { writeAlignmentMarker } from "../src/session/state";

describe("resolveSnapshotSession", () => {
  const hosts: Record<string, { transcriptPath?: string }> = {
    ses_other: { transcriptPath: "/t/other.jsonl" },
    ses_mine: { transcriptPath: "/t/mine.jsonl" },
  };
  const readHost = (id: string) => hosts[id] ?? null;
  const list = () => Object.keys(hosts);

  it("matches the host that watches THIS transcript — cwd is irrelevant", () => {
    const resolved = resolveSnapshotSession(
      { transcript_path: "/t/mine.jsonl", cwd: "/repo/task-manager" },
      "/spool",
      "/cfg/config.json",
      // The hook's cwd resolves to a checkout with NO marker — the F1 shape.
      "/repo/task-manager",
      readHost,
      list,
    );
    assert.equal(resolved?.sessionId, "ses_mine");
    assert.match(resolved!.how, /host watching/);
  });

  it("falls back to the checkout's alignment marker", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "stacks-snapcfg-"));
    const configPath = join(cfgDir, "config.json");
    writeAlignmentMarker(
      configPath,
      "/repo/test-1",
      {
        sessionId: "ses_marker",
        workspaceId: "ws",
        projectId: "proj",
        taskId: null,
        capture: "off",
        alignedAt: "2026-08-11T02:46:21.036Z",
      },
      "codex-thread-1",
    );
    const resolved = resolveSnapshotSession(
      {
        session_id: "codex-thread-1",
        transcript_path: "/t/unknown.jsonl",
      },
      "/spool",
      configPath,
      "/repo/test-1",
      () => null,
      () => [],
    );
    assert.equal(resolved?.sessionId, "ses_marker");
  });

  it("does not borrow a lone marker when the hook has no provider id", () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "stacks-snapcfg-"));
    const configPath = join(cfgDir, "config.json");
    writeAlignmentMarker(
      configPath,
      "/repo/test-1",
      {
        sessionId: "ses_foreign",
        workspaceId: "ws",
        projectId: "proj",
        taskId: null,
        capture: "on",
        alignedAt: "2026-08-11T02:46:21.036Z",
      },
      "claude-session-1",
    );
    assert.equal(
      resolveSnapshotSession(
        {},
        "/spool",
        configPath,
        "/repo/test-1",
        () => null,
        () => [],
      ),
      null,
    );
  });

  it("REFUSES to guess when nothing proves a session", () => {
    // Mis-filing one session's history under another is worse than
    // preserving nothing, so there is deliberately no newest-marker rung.
    assert.equal(
      resolveSnapshotSession(
        { transcript_path: "/t/unknown.jsonl" },
        "/spool",
        "/cfg/config.json",
        null,
        () => null,
        () => [],
      ),
      null,
    );
  });
});

/** The push kinds the snapshot sent, in order — JEN-298 pins them to `log`. */
const pushedKinds: string[] = [];

function deps(spoolRoot: string, pushed: string[]): PushDeps {
  return {
    env: {},
    cwd: () => "/nowhere",
    configPath: join(spoolRoot, "config.json"),
    resolveTarget: () => ({ token: "tm_x", url: "https://s.example/api/mcp" }),
    ensureInstallationId: () => "i-1",
    connect: async () => {
      throw new Error("no MCP needed");
    },
    git: async () => ({ code: 1, stdout: "" }),
    writeOut: () => undefined,
    writeErr: () => undefined,
    isInteractive: false,
    readLine: async () => "",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => 1,
    spoolRoot,
    resolveSessionHost: () => "/tools/session-host-main.js",
    fetchImpl: (async (_url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as { body: string; kind: string };
      pushed.push(parsed.body);
      pushedKinds.push(parsed.kind);
      return {
        ok: true,
        status: 200,
        json: async () => ({ artifactId: "art_1", type: "LOG" }),
      };
    }) as unknown as typeof fetch,
  };
}

describe("runSessionSnapshot", () => {
  function scene(): {
    spool: string;
    transcript: string;
    pushed: string[];
  } {
    const spool = mkdtempSync(join(tmpdir(), "stacks-snap-"));
    mkdirSync(join(spool, "ses_1"), { recursive: true });
    const transcript = join(spool, "session.jsonl");
    writeFileSync(transcript, "AAAA\nBBBB\n");
    writeFileSync(
      join(spool, "ses_1", "host.json"),
      JSON.stringify({
        pid: process.pid,
        provider: "claude",
        mode: "watch",
        // Capture ON: preserving the range is what this session consented to.
        captureTrace: true,
        transcriptPath: transcript,
      }),
    );
    return { spool, transcript, pushed: [] };
  }

  it("preserves the range and records the offset", async () => {
    const { spool, transcript, pushed } = scene();
    const d = deps(spool, pushed);
    const code = await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...d,
        readStdin: async () =>
          JSON.stringify({
            session_id: "9c08e219",
            transcript_path: transcript,
            cwd: "/repo/task-manager",
            trigger: "manual",
          }),
      },
    );
    assert.equal(code, 0);
    assert.equal(pushed.length, 1);
    assert.match(pushed[0]!, /AAAA\nBBBB/);
    assert.match(pushed[0]!, /preservation,\nnot distillation/);
    assert.match(pushed[0]!, /9c08e219/);
    // JEN-298: preserved bytes are a RECORD (LOG), never an output — as
    // `report` they satisfied review-readiness check 3 on their own.
    assert.equal(pushedKinds.at(-1), "log");
    const offset = JSON.parse(
      readFileSync(join(spool, "ses_1", "snapshot.json"), "utf8"),
    ) as { offset: number };
    assert.equal(offset.offset, 10);

    // A second boundary with nothing new preserves nothing (no duplicate).
    await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...d,
        readStdin: async () =>
          JSON.stringify({ transcript_path: transcript, cwd: "/x" }),
      },
    );
    assert.equal(pushed.length, 1);

    // …and only the NEW bytes when the transcript grows.
    writeFileSync(transcript, "AAAA\nBBBB\nCCCC\n");
    await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...d,
        readStdin: async () =>
          JSON.stringify({ transcript_path: transcript, cwd: "/x" }),
      },
    );
    assert.equal(pushed.length, 2);
    assert.match(pushed[1]!, /CCCC/);
    assert.match(pushed[1]!, /byte range: 10–15 of 15/);
    // Only the NEW bytes ship — the already-preserved range is not re-sent.
    assert.doesNotMatch(pushed[1]!, /AAAA/);
  });

  it("tracks offsets in BYTES, not UTF-16 code units (STA-51)", async () => {
    const { spool, transcript, pushed } = scene();
    // 4 chars but 10 bytes: "héllo" is 6, "🦊" is 4 — a code-unit slice would
    // record offset 6 and re-preserve (or skip) bytes at the next boundary.
    writeFileSync(transcript, "héllo🦊");
    const size = Buffer.byteLength("héllo🦊");
    const d = deps(spool, pushed);
    await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...d,
        readStdin: async () =>
          JSON.stringify({ transcript_path: transcript, cwd: "/x" }),
      },
    );
    assert.equal(pushed.length, 1);
    assert.match(pushed[0]!, new RegExp(`byte range: 0–${size} of ${size}`));
    const offset = JSON.parse(
      readFileSync(join(spool, "ses_1", "snapshot.json"), "utf8"),
    ) as { offset: number };
    assert.equal(offset.offset, size);

    // Byte-true bookkeeping: the next boundary sees nothing new.
    await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...d,
        readStdin: async () =>
          JSON.stringify({ transcript_path: transcript, cwd: "/x" }),
      },
    );
    assert.equal(pushed.length, 1);
  });

  it("never breaks the operator's compact — every failure is exit 0", async () => {
    const { spool, pushed } = scene();
    const d = deps(spool, pushed);
    for (const stdin of [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ transcript_path: "/does/not/exist.jsonl" }),
      // Readable transcript, but nothing proves a session.
      JSON.stringify({
        transcript_path: join(spool, "session.jsonl"),
        cwd: "/x",
      }),
    ]) {
      assert.equal(
        await runSessionSnapshot({}, { ...d, readStdin: async () => stdin }),
        0,
        `exit 0 for payload: ${stdin.slice(0, 40)}`,
      );
    }
    // An UNEXPECTED throw past the handled paths must also exit 0 instead of
    // escaping to main.ts and exiting non-zero mid-/compact (STA-51). Here:
    // the "transcript" passes existsSync but is a directory, so the read
    // explodes — the same shape as the transcript vanishing mid-hook.
    const dir = join(spool, "not-a-file.jsonl");
    mkdirSync(dir);
    writeFileSync(
      join(spool, "ses_1", "host.json"),
      JSON.stringify({
        pid: process.pid,
        provider: "claude",
        mode: "watch",
        captureTrace: true,
        transcriptPath: dir,
      }),
    );
    const err: string[] = [];
    assert.equal(
      await runSessionSnapshot(
        {},
        {
          ...d,
          writeErr: (line: string) => err.push(line),
          readStdin: async () =>
            JSON.stringify({ transcript_path: dir, cwd: "/x" }),
        },
      ),
      0,
    );
    assert.match(err.join("\n"), /unexpected failure/);
  });
});

// ---------------------------------------------------------------------------
// Capture consent (2026-08-12). The alignment snapshot is a SERVER-CONFIRMED
// consent record, and `capture: "off"` is disclosed to the operator as
// "typed artifacts only, no transcript". Uploading transcript bytes under that
// record violates it — the content being wrapped in a typed artifact does not
// change what the content is. So the snapshot follows the capture decision:
// ON preserves the range, OFF records the BOUNDARY and no content.
// ---------------------------------------------------------------------------

describe("runSessionSnapshot — capture consent", () => {
  function scene(captureTrace: boolean): {
    spool: string;
    transcript: string;
    pushed: string[];
  } {
    const spool = mkdtempSync(join(tmpdir(), "stacks-consent-"));
    mkdirSync(join(spool, "ses_c"), { recursive: true });
    const transcript = join(spool, "session.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "user",
          sessionId: "p1",
          secret: "SENSITIVE-BODY-TEXT",
        }),
        JSON.stringify({ type: "assistant", sessionId: "p1" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(spool, "ses_c", "host.json"),
      JSON.stringify({
        pid: process.pid,
        provider: "claude",
        mode: "watch",
        captureTrace,
        transcriptPath: transcript,
      }),
    );
    return { spool, transcript, pushed: [] };
  }

  const hook = (transcript: string, event = "PreCompact") =>
    JSON.stringify({
      session_id: "p1",
      transcript_path: transcript,
      cwd: "/repo/elsewhere",
      hook_event_name: event,
      trigger: "manual",
    });

  it("capture OFF: records the boundary and uploads NO transcript content", async () => {
    const { spool, transcript, pushed } = scene(false);
    const code = await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...deps(spool, pushed),
        readStdin: async () => hook(transcript),
      },
    );
    assert.equal(code, 0);
    assert.equal(pushed.length, 1, "the boundary is still recorded");
    const body = pushed[0]!;
    // THE rule: not one byte of the transcript.
    assert.doesNotMatch(
      body,
      /SENSITIVE-BODY-TEXT/,
      "transcript content must never ship under capture-off consent",
    );
    assert.doesNotMatch(body, /"type":"assistant"/);
    // …and it must say so, rather than looking like a successful preservation.
    assert.match(body, /not preserved/i);
    assert.match(body, /capture is off/i);
    assert.match(body, /jentrix-checkpoint/);
    assert.match(body, /jentrix session align --task <id-or-key> --capture/);
    // JEN-298: the boundary is a RECORD (LOG). Pushed as `report` it counted
    // as an output artifact and made a session that produced nothing read
    // review-ready after one /compact (twice — PreCompact and PostCompact).
    assert.equal(pushedKinds.at(-1), "log");
  });

  it("capture ON: preserves the range, because that was consented to", async () => {
    const { spool, transcript, pushed } = scene(true);
    await runSessionSnapshot(
      { event: "PreCompact" },
      {
        ...deps(spool, pushed),
        readStdin: async () => hook(transcript),
      },
    );
    assert.equal(pushed.length, 1);
    assert.match(pushed[0]!, /SENSITIVE-BODY-TEXT/);
  });

  it("capture OFF still records EVERY boundary — no offset suppression", async () => {
    // A boundary marker carries no content, so the "nothing new since last
    // snapshot" short-circuit must not hide a second compaction.
    const { spool, transcript, pushed } = scene(false);
    const d = {
      ...deps(spool, pushed),
      readStdin: async () => hook(transcript),
    };
    await runSessionSnapshot({ event: "PreCompact" }, d);
    await runSessionSnapshot({ event: "PreCompact" }, d);
    assert.equal(
      pushed.length,
      2,
      "each compaction is its own recorded boundary",
    );
  });
});
