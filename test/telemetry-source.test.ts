import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  hookLedgerNamesSession,
  runSessionStatus,
  telemetrySourceCheck,
  telemetrySourceFact,
  telemetrySourceFor,
  type SessionCommandDeps,
  type SessionToolCaller,
} from "../src/commands/session";

// ---------------------------------------------------------------------------
// W2 / JEN-163 — the telemetry SOURCE is one fact with three values, and the
// three surfaces that report it cannot disagree (PRD C2.1-C2.6, AC2.1-AC2.5).
//
// The defect: `align` read `ok` — "host watches trusted Codex lifecycle hooks
// and provider-reported rollout usage" — whenever a HOME directory was
// resolvable. A resolvable home says nothing about whether a hook ever fired,
// so a session could report COMPLETE coverage while prompts, tool calls,
// assistant messages and compaction boundaries went unrecorded.
// ---------------------------------------------------------------------------

const SESSION = "0199c0de-1111-2222-3333-444455556666";

/** A HOME with a Codex hook ledger, and a CODEX_HOME holding rollout files. */
function fixture(opts: { hookFor?: string; rolloutFor?: string }): {
  HOME: string;
  CODEX_HOME: string;
} {
  const root = mkdtempSync(join(tmpdir(), "jentrix-telemetry-"));
  const HOME = join(root, "home");
  const CODEX_HOME = join(root, "codex");
  const ledgerDir = join(HOME, ".config", "stacks", "codex-sessions");
  mkdirSync(ledgerDir, { recursive: true });
  mkdirSync(join(CODEX_HOME, "sessions", "2026", "08"), { recursive: true });
  writeFileSync(
    join(ledgerDir, "hooks.ndjson"),
    opts.hookFor
      ? `${JSON.stringify({
          event: "SessionStart",
          at: "2026-08-27T06:00:00.000Z",
          payload: { session_id: opts.hookFor, cwd: "/work/api" },
        })}\n`
      : "",
  );
  if (opts.rolloutFor) {
    writeFileSync(
      join(
        CODEX_HOME,
        "sessions",
        "2026",
        "08",
        `rollout-2026-08-27T06-00-00-${opts.rolloutFor}.jsonl`,
      ),
      "",
    );
  }
  return { HOME, CODEX_HOME };
}

describe("telemetrySourceFact — the three values (C2.1, AC2.5)", () => {
  it("codex: a ledger record for THIS task is hooks+rollout, and misses nothing", () => {
    const fact = telemetrySourceFact("codex", {
      hookRecord: true,
      boundPath: "/codex/sessions/rollout.jsonl",
    });
    assert.equal(fact.source, "hooks+rollout");
    assert.deepEqual(fact.missing, []);
    assert.equal(fact.remedy, null);
  });

  it("codex: an exact rollout with NO hook record is rollout-fallback, and names all five missing capabilities (C2.3)", () => {
    const fact = telemetrySourceFact("codex", {
      hookRecord: false,
      boundPath: "/codex/sessions/rollout.jsonl",
    });
    assert.equal(fact.source, "rollout-fallback");
    assert.deepEqual(fact.missing, [
      "prompts",
      "tool calls",
      "assistant messages",
      "final response",
      "compaction boundaries",
    ]);
    // The remedy is BOTH halves: trusting hooks mid-task repairs nothing.
    assert.match(fact.remedy!, /\/hooks/);
    assert.match(fact.remedy!, /NEW task/);
    assert.match(fact.detail, /rollout-fallback/);
    // …and it never claims the hooks are watching.
    assert.ok(!/trusted Codex lifecycle hooks recorded/.test(fact.detail));
  });

  it("codex: neither is unavailable, and token receipts join the missing list", () => {
    const fact = telemetrySourceFact("codex", {
      hookRecord: false,
      boundPath: null,
    });
    assert.equal(fact.source, "unavailable");
    assert.ok(fact.missing.includes("token receipts"));
    assert.ok(fact.missing.includes("prompts"));
  });

  it("codex: hooks firing but no rollout bound still misses TOKEN RECEIPTS, and says so", () => {
    const fact = telemetrySourceFact("codex", {
      hookRecord: true,
      boundPath: null,
    });
    assert.equal(fact.source, "hooks+rollout");
    assert.deepEqual(fact.missing, ["token receipts"]);
    assert.match(fact.detail, /no rollout file is bound/);
  });

  it("claude: no transcript is the SAME `unavailable` vocabulary the old warning had (C2.6)", () => {
    const fact = telemetrySourceFact("claude", {
      hookRecord: true,
      boundPath: null,
    });
    assert.equal(fact.source, "unavailable");
    assert.match(fact.detail, /^unavailable —/);
    assert.match(fact.remedy!, /jentrix-connect|transcript-path/);
  });

  it("claude: a transcript bound with no hook record is an UNATTESTED binding, not a silent ok", () => {
    const fact = telemetrySourceFact("claude", {
      hookRecord: false,
      boundPath: "/t/session.jsonl",
    });
    assert.equal(fact.source, "rollout-fallback");
    assert.match(fact.detail, /unattested/);
  });
});

describe("hookLedgerNamesSession — the LEDGER decides, never a directory (C2.1/AC2.4)", () => {
  it("flips the reported source when the ledger record is the only thing removed", () => {
    const withHook = fixture({ hookFor: SESSION, rolloutFor: SESSION });
    const withoutHook = fixture({ rolloutFor: SESSION });
    assert.equal(
      hookLedgerNamesSession({ env: withHook }, "codex", SESSION),
      true,
    );
    assert.equal(
      hookLedgerNamesSession({ env: withoutHook }, "codex", SESSION),
      false,
    );
    // Same rollout, same resolvable HOME — only the ledger record differs.
    const rollout = "/codex/sessions/rollout.jsonl";
    assert.equal(
      telemetrySourceFor({ env: withHook }, "codex", SESSION, rollout).source,
      "hooks+rollout",
    );
    assert.equal(
      telemetrySourceFor({ env: withoutHook }, "codex", SESSION, rollout)
        .source,
      "rollout-fallback",
    );
  });

  it("a ledger naming OTHER sessions does not vouch for this one", () => {
    const env = fixture({ hookFor: "some-other-task", rolloutFor: SESSION });
    assert.equal(hookLedgerNamesSession({ env }, "codex", SESSION), false);
  });

  it("an unreadable ledger (or no HOME at all) is false, never a guess", () => {
    assert.equal(hookLedgerNamesSession({ env: {} }, "codex", SESSION), false);
    assert.equal(
      hookLedgerNamesSession(
        { env: { HOME: "/nope/does/not/exist" } },
        "codex",
        SESSION,
      ),
      false,
    );
  });
});


describe("session doctor reads the same fact (AC2.1)", () => {
  const cwd = () => "/work/api";

  it("hook-active → ok", () => {
    const env = {
      ...fixture({ hookFor: SESSION, rolloutFor: SESSION }),
      CODEX_THREAD_ID: SESSION,
    };
    const check = telemetrySourceCheck({ env, cwd });
    assert.equal(check.status, "ok");
    assert.match(check.detail, /hooks\+rollout/);
  });

  it("hookless-exact-rollout → warn, with the capabilities and the remedy", () => {
    const env = {
      ...fixture({ rolloutFor: SESSION }),
      CODEX_THREAD_ID: SESSION,
    };
    const check = telemetrySourceCheck({ env, cwd });
    assert.equal(check.status, "warn");
    assert.match(check.detail, /rollout-fallback/);
    assert.match(check.detail, /compaction boundaries/);
    assert.match(check.fix!, /NEW task/);
  });

  it("unavailable → warn", () => {
    const env = { ...fixture({}), CODEX_THREAD_ID: SESSION };
    const check = telemetrySourceCheck({ env, cwd });
    assert.equal(check.status, "warn");
    assert.match(check.detail, /^unavailable —/);
  });

  it("no provider session identified → skip, never a guessed ok", () => {
    const check = telemetrySourceCheck({ env: {}, cwd });
    assert.equal(check.status, "skip");
  });
});

describe("session status reads the same fact (AC2.1-AC2.3)", () => {
  function statusDeps(
    env: Record<string, string | undefined>,
    session: Record<string, unknown>,
  ): SessionCommandDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const caller: SessionToolCaller = {
      async callTool({ name }) {
        if (name !== "get_agent_session") throw new Error(`unexpected ${name}`);
        return { structuredContent: session };
      },
    };
    return {
      out,
      err,
      env,
      cwd: () => "/work/api",
      configPath: "/tmp/config.json",
      resolveTarget: () => ({
        token: "tm_x",
        url: "https://s.example/api/mcp",
      }),
      ensureInstallationId: () => "install-uuid-1",
      connect: async () => ({ caller, close: async () => undefined }),
      git: async () => ({ code: 1, stdout: "" }),
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      isInteractive: false,
      readLine: async () => "",
      resolveSessionHost: () => "/tools/session-host-main.js",
      runSessionHost: async () => 0,
      spawnSessionHostDetached: () => 9999,
      spoolRoot: join(tmpdir(), "jentrix-telemetry-spool"),
    } as SessionCommandDeps & { out: string[]; err: string[] };
  }

  const codexSession = {
    id: "ses_codex",
    provider: "codex",
    status: "ACTIVE",
    projectName: "Atlas",
    projectId: "proj_1",
    repoOwnerName: "acme/api",
    providerSessionId: SESSION,
    captureComplete: false,
    captureError: null,
    summaryArtifactId: null,
    usage: {
      inputTokens: 1200,
      outputTokens: 34,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      coverage: "COMPLETE",
    },
  };

  it("AC2.2/AC2.3: a hookless session never shows an unqualified COMPLETE, and names what it lacks", async () => {
    const d = statusDeps(fixture({ rolloutFor: SESSION }), codexSession);
    assert.equal(await runSessionStatus("ses_codex", {}, d), 0);
    const detail = d.out.join("\n");
    // Every COMPLETE in the output is scoped to token receipts, in words.
    const hits = [...detail.matchAll(/COMPLETE/g)];
    assert.ok(hits.length > 0, "the fixture's coverage COMPLETE must render");
    for (const hit of hits) {
      assert.ok(
        detail.slice(0, hit.index).endsWith("token-receipt coverage "),
        `unqualified COMPLETE at ${hit.index}: ${detail}`,
      );
    }
    assert.match(detail, /Telemetry source: .*rollout-fallback/);
    assert.match(detail, /NOT recorded: prompts, tool calls/);
    assert.match(detail, /\/hooks/);
    assert.match(detail, /NEW task/);
  });

  it("a hook-active session reports hooks+rollout with nothing missing", async () => {
    const d = statusDeps(
      fixture({ hookFor: SESSION, rolloutFor: SESSION }),
      codexSession,
    );
    assert.equal(await runSessionStatus("ses_codex", {}, d), 0);
    const detail = d.out.join("\n");
    assert.match(detail, /Telemetry source: .*hooks\+rollout/);
    assert.ok(!/NOT recorded/.test(detail), detail);
  });

  it("an unresolvable rollout reports unavailable — never a 'latest' substitute (C2.5)", async () => {
    const d = statusDeps(fixture({}), codexSession);
    assert.equal(await runSessionStatus("ses_codex", {}, d), 0);
    assert.match(d.out.join("\n"), /Telemetry source: unavailable/);
  });
});
