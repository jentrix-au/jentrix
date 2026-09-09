/**
 * F1c/F3 (2026-08-11 MVP gap report) — the close that recorded nothing must
 * SAY so. The reported session closed at exit 0 with `captureStatus:
 * OFF_BY_DESIGN`, `coverage: "UNAVAILABLE"` and all four token kinds null,
 * having run a host for 23.7 minutes: indistinguishable from a healthy
 * capture-off close. Capture-off is a deliberate mode and stays exit 0; what
 * changes is that its UNEXPECTED form announces itself.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runSessionEnd } from "../src/session/end";
import { telemetryVerdict } from "../src/session/status";
import { type SessionCommandDeps } from "../src/session/deps";
import { type SessionToolCaller } from "../src/tool-client";
import { EXIT_CODES } from "../src/errors";

const FULL = {
  inputTokens: 1309413,
  outputTokens: 2034,
  cacheReadTokens: 1304628,
  cacheCreationTokens: 4776,
  wallDurationMs: 89753,
  coverage: "COMPLETE",
};

// Verbatim from the report's F1c block.
const EMPTY = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  wallDurationMs: 1420641,
  coverage: "UNAVAILABLE",
};

describe("telemetryVerdict", () => {
  it("reports the four-way split verbatim and warns about nothing", () => {
    const verdict = telemetryVerdict("ses_1", FULL, true);
    // JEN-494 AC1.7 — the aggregation rule, named once, on the line that
    // reports the figures it produced.
    assert.match(
      verdict.line,
      /· receipts: one per API message \(last record wins\)$/,
    );
    assert.equal(verdict.state, "recorded");
    assert.equal(verdict.warning, null);
    assert.match(verdict.line, /1309413/);
    assert.match(verdict.line, /2034/);
    assert.match(verdict.line, /1304628/);
    assert.match(verdict.line, /4776/);
    assert.match(verdict.line, /COMPLETE/);
  });

  it("names the F1c state: a host ran and attributed nothing", () => {
    const verdict = telemetryVerdict("cmso26frm", EMPTY, true);
    assert.equal(verdict.state, "unattributed");
    assert.match(verdict.warning!, /NO TOKEN TELEMETRY/);
    // It must name the CAUSE (the transcript binding) and a fix, the way
    // "SESSION BOUND BUT NOT RECORDING" already does for capture.
    assert.match(verdict.warning!, /transcript/i);
    assert.match(verdict.warning!, /--transcript-path/);
    assert.match(verdict.warning!, /cmso26frm/);
    // …and never invent a number: wall time is all that survived.
    assert.match(verdict.line, /1420641/);
    assert.doesNotMatch(verdict.line, /\b0 tokens\b/);
  });

  it("distinguishes 'no host ever ran' from 'a host ran and matched nothing'", () => {
    const verdict = telemetryVerdict("ses_2", EMPTY, false);
    assert.equal(verdict.state, "no-host");
    assert.match(verdict.warning!, /no local session host ever ran/i);
    // Not the F1c diagnosis — nothing was watching anything, so blaming the
    // transcript binding would send the operator after the wrong defect.
    assert.doesNotMatch(verdict.warning!, /matched no provider usage receipts/);
  });

  it("treats a partial split as recorded — one real number is not a gap", () => {
    assert.equal(
      telemetryVerdict("ses_3", { ...EMPTY, outputTokens: 12 }, true).state,
      "recorded",
    );
  });

  it("is a warning, never an exit code: capture debt (8) stays capture debt", () => {
    // The verdict carries no code at all — the caller's exit stays whatever
    // sessionCloseVerdict decided. Overloading 8 would make "capture debt"
    // mean two different things.
    assert.equal("code" in telemetryVerdict("ses_4", EMPTY, true), false);
  });

  it("says nothing confident when the session carries no usage block", () => {
    const verdict = telemetryVerdict("ses_5", null, true);
    assert.equal(verdict.state, "unattributed");
    assert.match(verdict.line, /no token telemetry/i);
  });
});

// ---------------------------------------------------------------------------
// Slice 10(a) — the same verdict rendered from REAL host files through
// `session end`, not from a mock. The reported failure was exactly this shape:
// a host marker on disk (`transcriptSeen: true`), OFF_BY_DESIGN capture, and a
// server row whose four token kinds are null.
// ---------------------------------------------------------------------------

function endDeps(
  spoolRoot: string,
  session: Record<string, unknown>,
): SessionCommandDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const caller: SessionToolCaller = {
    async callTool({ name }) {
      if (name === "get_agent_session") return { structuredContent: session };
      if (name === "complete_agent_session") {
        // The REAL server shape: lifecycle fields ONLY, no `usage` — the F2
        // false-warning bug hid behind a mock that echoed the whole row. The
        // telemetry verdict must come from the post-close get_agent_session.
        return {
          structuredContent: {
            id: session.id,
            status: "COMPLETED",
            captureComplete: session.captureComplete ?? false,
            captureStatus: session.captureStatus ?? null,
            summaryArtifactId: null,
          },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  return {
    out,
    err,
    env: {},
    cwd: () => "/nowhere",
    configPath: join(spoolRoot, "config.json"),
    resolveTarget: () => ({ token: "tm_x", url: "https://s.example/api/mcp" }),
    ensureInstallationId: () => "install-1",
    connect: async () => ({ caller, close: async () => undefined }),
    git: async () => ({ code: 1, stdout: "" }),
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    isInteractive: false,
    readLine: async () => "",
    resolveSessionHost: () => "/tools/session-host-main.js",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => 1,
    spoolRoot,
  };
}

describe("session end over real host files (F1c)", () => {
  it("announces the empty close a host produced, and still exits 0", async () => {
    const spool = mkdtempSync(join(tmpdir(), "stacks-tel-"));
    mkdirSync(join(spool, "ses_f1c"), { recursive: true });
    writeFileSync(
      join(spool, "ses_f1c", "host.json"),
      JSON.stringify({
        pid: 88078,
        provider: "claude",
        mode: "watch",
        captureTrace: false,
        transcriptSeen: true,
        exitedAt: "2026-08-11T03:10:00.000Z",
        exitCode: 0,
      }),
    );
    const d = endDeps(spool, {
      id: "ses_f1c",
      status: "ACTIVE",
      captureStatus: "OFF_BY_DESIGN",
      captureComplete: false,
      alignment: { capture: "off" },
      updatedAt: "2026-08-11T03:00:00.000Z",
      usage: EMPTY,
    });
    const code = await runSessionEnd("ses_f1c", {}, d);
    assert.equal(code, EXIT_CODES.OK, "capture-off is not capture debt");
    assert.match(d.err.join("\n"), /NO TOKEN TELEMETRY/);
    assert.match(d.err.join("\n"), /--transcript-path/);
    assert.match(d.out.join("\n"), /no token telemetry was recorded/);
  });

  it("states the four-way split on a healthy close (F4: the closing fact)", async () => {
    const spool = mkdtempSync(join(tmpdir(), "stacks-tel2-"));
    mkdirSync(join(spool, "ses_ok"), { recursive: true });
    writeFileSync(
      join(spool, "ses_ok", "host.json"),
      JSON.stringify({ pid: 1, exitedAt: "2026-08-11T03:10:00.000Z" }),
    );
    const d = endDeps(spool, {
      id: "ses_ok",
      status: "ACTIVE",
      captureStatus: "COMPLETE",
      captureComplete: true,
      updatedAt: "2026-08-11T03:00:00.000Z",
      usage: FULL,
    });
    assert.equal(await runSessionEnd("ses_ok", {}, d), EXIT_CODES.OK);
    assert.match(d.out.join("\n"), /in 1309413 · out 2034/);
    assert.equal(d.err.join("\n").includes("NO TOKEN TELEMETRY"), false);
  });

  it("keeps --json stdout a single parseable document", async () => {
    const spool = mkdtempSync(join(tmpdir(), "stacks-tel3-"));
    mkdirSync(join(spool, "ses_j"), { recursive: true });
    writeFileSync(
      join(spool, "ses_j", "host.json"),
      JSON.stringify({ pid: 1, exitedAt: "x" }),
    );
    const d = endDeps(spool, {
      id: "ses_j",
      status: "ACTIVE",
      captureStatus: "OFF_BY_DESIGN",
      alignment: { capture: "off" },
      updatedAt: "2026-08-11T03:00:00.000Z",
      usage: EMPTY,
    });
    await runSessionEnd("ses_j", { json: true }, d);
    const parsed = JSON.parse(d.out.join("\n")) as Record<string, unknown>;
    assert.equal(parsed.id, "ses_j");
    // The warning still reaches the operator — on stderr.
    assert.match(d.err.join("\n"), /NO TOKEN TELEMETRY/);
  });
});

// ---------------------------------------------------------------------------
// JEN-167 — an evidence-floor refusal must leave the local host RUNNING.
//
// The production dogfood (reports/session-evidence-prod-dogfood-2026-08-26.md
// §8.1) showed the opposite: the host died at the refusal, `session end`
// announced "exited without completing the session — completing server-side",
// and the comply-and-retry close ran hostless, so the skeleton stopped at the
// refusal. A surviving host writes `end-refusal.json` instead of an exit
// stamp; `session end` relays that envelope verbatim at exit 5 and must NOT
// complete server-side over a live host.
// ---------------------------------------------------------------------------

const REFUSAL = [
  "EVIDENCE_FLOOR: 1 evidence check(s) unmet — the session's durable record cannot support a later review.",
  "- E2: 1 commit(s) with no decision memo and no declared deviation. Fix: push the decision record (`jentrix push decision --basis <ref>`) or declare the deviation (`jentrix push gap`), then retry",
  "Close anyway with `jentrix session end --acknowledge-evidence-gaps` — each unmet check is then stamped MISSING into the summary's Review readiness.",
].join("\n");

describe("session end against a host that survived the evidence floor", () => {
  function refusingHostDeps(spool: string, sessionId: string) {
    const dir = join(spool, sessionId);
    mkdirSync(dir, { recursive: true });
    // A LIVE host: this process's own pid, no exit stamp.
    writeFileSync(
      join(dir, "host.json"),
      JSON.stringify({ pid: process.pid, provider: "claude", mode: "watch" }),
    );
    const d = endDeps(spool, {
      id: sessionId,
      status: "ACTIVE",
      captureStatus: "OFF_BY_DESIGN",
      alignment: { capture: "off" },
      updatedAt: "2026-08-26T03:00:00.000Z",
      usage: EMPTY,
    });
    return { dir, d };
  }

  it("relays the refusal verbatim at exit 5 and never completes server-side", async () => {
    const spool = mkdtempSync(join(tmpdir(), "stacks-jen167-"));
    const { dir, d } = refusingHostDeps(spool, "ses_refused");
    const completed: string[] = [];
    const inner = d.connect;
    d.connect = async (target) => {
      const { caller, close } = await inner(target);
      return {
        close,
        caller: {
          async callTool(req) {
            completed.push(req.name);
            return caller.callTool(req);
          },
        },
      };
    };
    // The host answers the end request by SURVIVING it: a refusal marker, no
    // exit stamp. Modelled on the wait's own clock so the test is not timed.
    d.sleep = async () => {
      writeFileSync(
        join(dir, "end-refusal.json"),
        JSON.stringify({
          refusedAt: "2026-08-26T03:05:00.000Z",
          message: REFUSAL,
        }),
      );
    };

    const code = await runSessionEnd("ses_refused", {}, d);
    assert.equal(code, EXIT_CODES.CONFLICT, "a refused end exits 5");
    const err = d.err.join("\n");
    assert.ok(err.includes(REFUSAL), "the envelope is relayed VERBATIM");
    assert.match(err, /--acknowledge-evidence-gaps/);
    assert.match(err, /host \(pid \d+\) is still running/);
    assert.doesNotMatch(err, /exited without completing/);
    assert.equal(
      completed.includes("complete_agent_session"),
      false,
      "never race a living host with a server-side completion",
    );
  });

  it("hands the acknowledgement and the commit count to the host's own close", async () => {
    const spool = mkdtempSync(join(tmpdir(), "stacks-jen167b-"));
    const { dir, d } = refusingHostDeps(spool, "ses_ack");
    d.sleep = async () => {
      writeFileSync(
        join(dir, "end-refusal.json"),
        JSON.stringify({ message: REFUSAL }),
      );
    };
    await runSessionEnd("ses_ack", { acknowledgeEvidenceGaps: true }, d);
    const request = JSON.parse(
      readFileSync(join(dir, "end-request.json"), "utf8"),
    ) as { acknowledgeEvidenceGaps?: boolean };
    assert.equal(
      request.acknowledgeEvidenceGaps,
      true,
      "the host closes the session, so the operator's --acknowledge-evidence-gaps must reach IT",
    );
  });

  it("drops a previous end's refusal so it cannot answer the next one", async () => {
    const spool = mkdtempSync(join(tmpdir(), "stacks-jen167c-"));
    const { dir, d } = refusingHostDeps(spool, "ses_stale");
    writeFileSync(
      join(dir, "end-refusal.json"),
      JSON.stringify({ message: REFUSAL }),
    );
    // This host answers by exiting cleanly; the STALE refusal must not win.
    d.sleep = async () => {
      writeFileSync(
        join(dir, "host.json"),
        JSON.stringify({
          pid: process.pid,
          exitedAt: "2026-08-26T03:06:00.000Z",
          exitCode: 0,
        }),
      );
    };
    const code = await runSessionEnd("ses_stale", {}, d);
    assert.notEqual(code, EXIT_CODES.CONFLICT);
    assert.doesNotMatch(d.err.join("\n"), /EVIDENCE_FLOOR/);
  });
});
