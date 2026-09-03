import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ToolCaller } from "../src/call";
import { ConfigError } from "../src/config";
import type { ToolCommandDeps } from "../src/commands/tool";
import {
  redactToken,
  runWhoamiCommand,
  WHOAMI_SCOPE_NOTE,
  type WhoamiFlags,
  type WhoamiReport,
} from "../src/commands/whoami";

/** The full secret token used across tests — must NEVER appear in any output. */
const FULL_TOKEN = "tm_super_secret_value_1a2b3c4d";

/** A success result the way the server's ok() builds it (P2.2 contract). */
function okWorkspaces(rows: unknown[]) {
  const payload = { workspaces: rows };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(envelope: unknown) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}

/** A get_token_context success result the way the server's ok() builds it. */
function okTokenContext(ctx: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(ctx) }],
    structuredContent: ctx,
  };
}

/** A representative get_token_context payload (grandfathered, unpinned). */
const SAMPLE_CTX = {
  tokenId: "tok_1",
  tokenName: "Provisioner",
  userId: "user_1",
  displayName: "Provisioner Bot",
  emoji: "🤖",
  scopes: ["read", "write", "admin"],
  storedScopes: [] as string[],
  grandfathered: true,
  workspacePinned: false,
  workspaceId: null,
  expiresAt: null,
  rateLimit: {
    limitPerMinute: 120,
    used: 4,
    remaining: 116,
    resetInSeconds: 30,
  },
};

interface Recorded {
  calls: { name: string; arguments?: Record<string, unknown> }[];
  out: string[];
  err: string[];
  closed: number;
  connects: { url: string; token: string }[];
}

function makeDeps(
  overrides: Partial<ToolCommandDeps> & {
    result?: unknown;
    /** Result returned specifically for the get_token_context call (M19.1 R8). */
    tokenContext?: unknown;
    connectError?: unknown;
  } = {},
): { deps: ToolCommandDeps; rec: Recorded } {
  const rec: Recorded = {
    calls: [],
    out: [],
    err: [],
    closed: 0,
    connects: [],
  };
  const caller: ToolCaller = {
    callTool: (async (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      rec.calls.push(params);
      // get_token_context is a distinct call; when the test provides a payload
      // for it, return that — otherwise it falls through to the generic result
      // (a non-context shape, which the parser drops to the honest note).
      if (
        params.name === "get_token_context" &&
        overrides.tokenContext !== undefined
      ) {
        return overrides.tokenContext;
      }
      return (
        overrides.result ??
        okWorkspaces([
          { id: "ws_1", name: "Acme", slug: "acme", role: "ADMIN" },
        ])
      );
    }) as ToolCaller["callTool"],
  };
  const deps: ToolCommandDeps = {
    env: { STACKS_TOKEN: FULL_TOKEN },
    configFile: () => null,
    knownTools: new Set(["list_workspaces"]),
    connect: async (target) => {
      if (overrides.connectError !== undefined) throw overrides.connectError;
      rec.connects.push(target);
      return {
        caller,
        close: async () => {
          rec.closed += 1;
        },
      };
    },
    readStdin: async () => "{}",
    readFile: () => {
      throw new Error("readFile not stubbed");
    },
    writeOut: (text) => rec.out.push(text),
    writeErr: (text) => rec.err.push(text),
    sleep: async () => undefined,
    now: () => 0,
    ...overrides,
  };
  return { deps, rec };
}

function flags(overrides: Partial<WhoamiFlags> = {}): WhoamiFlags {
  return { ...overrides };
}

/** Assert the raw token appears in NO captured stream. */
function assertNoTokenLeak(rec: Recorded) {
  const all = [...rec.out, ...rec.err].join("\n");
  assert.ok(
    !all.includes(FULL_TOKEN),
    `full token leaked into output:\n${all}`,
  );
}

describe("redactToken (unit — token hygiene)", () => {
  it("shows the PAT prefix + last 4 only", () => {
    assert.deepEqual(redactToken("tm_super_secret_value_1a2b3c4d"), {
      type: "pat",
      display: "tm_…3c4d",
    });
  });

  it("shows the OAuth prefix + last 4 only", () => {
    assert.deepEqual(redactToken("tmo_abcdefgh_wxyz"), {
      type: "oauth",
      display: "tmo_…wxyz",
    });
  });

  it("classifies an unknown prefix and still hides the body", () => {
    const { type, display } = redactToken("mystery_token_9999");
    assert.equal(type, "unknown");
    assert.equal(display, "…9999");
  });

  it("never returns the full token even for short tokens", () => {
    // A short token cannot spare a 4-char suffix without BEING the suffix, so
    // it collapses to a bare "…" — the redaction must never echo it in full.
    assert.deepEqual(redactToken("abc"), { type: "unknown", display: "…" });
    assert.deepEqual(redactToken("tm_short"), { type: "pat", display: "tm_…" });
    // A real (long) PAT still shows its identifying last 4.
    assert.deepEqual(redactToken("tm_super_secret_value_1a2b3c4d"), {
      type: "pat",
      display: "tm_…3c4d",
    });
  });
});

describe("runWhoamiCommand — happy path", () => {
  it("calls list_workspaces then get_token_context (no args each), exits 0, closes the client", async () => {
    const { deps, rec } = makeDeps();
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 0);
    // list_workspaces proves identity; get_token_context (M19.1 R8) reports the
    // token's own scopes/pinning/rate window. Both take no args.
    assert.deepEqual(rec.calls, [
      { name: "list_workspaces", arguments: {} },
      { name: "get_token_context", arguments: {} },
    ]);
    assert.equal(rec.closed, 1);
    assertNoTokenLeak(rec);
  });

  it("human output reports config sources, workspaces, and the scope note", async () => {
    const { deps, rec } = makeDeps({
      result: okWorkspaces([
        { id: "ws_1", name: "Acme", slug: "acme", role: "ADMIN" },
        { id: "ws_2", name: "Beta Co", slug: "beta", role: "MEMBER" },
      ]),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 0);
    const out = rec.out.join("\n");
    // Redacted token + its source (env here).
    assert.match(out, /tm_…3c4d/);
    assert.match(out, /environment/);
    // Default URL + source label.
    assert.match(out, /tm\.jentrix\.ai/);
    assert.match(out, /\(default\)/);
    // Both workspaces with roles.
    assert.match(out, /Acme\s+acme\s+ADMIN/);
    assert.match(out, /Beta Co\s+beta\s+MEMBER/);
    // The honest limitation line, verbatim.
    assert.ok(out.includes(WHOAMI_SCOPE_NOTE));
    assertNoTokenLeak(rec);
  });

  it("--json emits a stable structured report and NEVER the full token", async () => {
    const { deps, rec } = makeDeps({
      result: okWorkspaces([
        { id: "ws_1", name: "Acme", slug: "acme", role: "ADMIN" },
      ]),
    });
    const code = await runWhoamiCommand(flags({ json: true }), deps);
    assert.equal(code, 0);
    assert.equal(rec.out.length, 1);
    const report = JSON.parse(rec.out[0]) as WhoamiReport;
    assert.equal(report.url, "https://tm.jentrix.ai/api/mcp");
    assert.equal(report.urlSource, "default");
    assert.equal(report.tokenType, "pat");
    assert.equal(report.tokenDisplay, "tm_…3c4d");
    assert.equal(report.tokenSource, "env");
    assert.deepEqual(report.workspaces, [
      { id: "ws_1", name: "Acme", slug: "acme", role: "ADMIN" },
    ]);
    assert.equal(report.note, WHOAMI_SCOPE_NOTE);
    // The load-bearing hygiene assertion, in --json mode specifically.
    assert.ok(!rec.out[0].includes(FULL_TOKEN));
    assertNoTokenLeak(rec);
  });

  it("renders 'none visible' when the token sees no workspaces", async () => {
    const { deps, rec } = makeDeps({ result: okWorkspaces([]) });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 0);
    assert.match(rec.out.join("\n"), /Workspaces: \(none visible/);
    assertNoTokenLeak(rec);
  });

  it("scrubs the token even if server data (list_workspaces) echoes it (--json, exit 0)", async () => {
    // Load-bearing for the SUCCESS-path redaction (SVR C4.1-R1-1): the
    // workspace fields are server-controlled, so a value equal to the token
    // must NOT survive onto stdout. Without redact() on the success write this
    // fails; the token appears verbatim in the printed `workspaces`.
    const { deps, rec } = makeDeps({
      result: okWorkspaces([
        { id: FULL_TOKEN, name: FULL_TOKEN, slug: "x", role: "ADMIN" },
      ]),
    });
    const code = await runWhoamiCommand(flags({ json: true }), deps);
    assert.equal(code, 0);
    assertNoTokenLeak(rec);
    // The scrubbed placeholder is what shows up instead.
    assert.match(rec.out.join("\n"), /<redacted token>/);
  });

  it("masks EVERY candidate token, not just the winning one (--token wins, env also set)", async () => {
    // SVR C4.1-R1-1 refinement: when a --token flag wins but STACKS_TOKEN is
    // also set to a DIFFERENT value, and server data echoes both, NEITHER may
    // leak. A redactor that scrubs only the winner would leak the env token.
    const FLAG_TOKEN = "tm_flag_secret_1111aaaa";
    const ENV_TOKEN = "tm_env_secret_2222bbbb";
    const { deps, rec } = makeDeps({
      env: { STACKS_TOKEN: ENV_TOKEN },
      result: okWorkspaces([
        { id: FLAG_TOKEN, name: ENV_TOKEN, slug: "s", role: "ADMIN" },
      ]),
    });
    const code = await runWhoamiCommand(
      flags({ json: true, token: FLAG_TOKEN }),
      deps,
    );
    assert.equal(code, 0);
    const out = rec.out.join("\n");
    assert.ok(!out.includes(FLAG_TOKEN), "winning flag token leaked");
    assert.ok(!out.includes(ENV_TOKEN), "env token leaked");
  });
});

describe("runWhoamiCommand — get_token_context (M19.1 R8)", () => {
  it("renders the token context (human) when the server returns it", async () => {
    const { deps, rec } = makeDeps({
      tokenContext: okTokenContext(SAMPLE_CTX),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 0);
    const out = rec.out.join("\n");
    assert.match(out, /scopes:\s+read, write, admin/);
    assert.match(out, /grandfathered/);
    assert.match(out, /workspace:\s+not pinned/);
    assert.match(out, /Provisioner Bot/);
    assert.match(out, /user:\s+user_1/);
    assert.match(out, /116\/120 left this minute \(resets in 30s\)/);
    // The real context REPLACES the honest limitation note.
    assert.ok(!out.includes(WHOAMI_SCOPE_NOTE));
    assertNoTokenLeak(rec);
  });

  it("--json includes the parsed tokenContext and NO bearer material", async () => {
    const { deps, rec } = makeDeps({
      tokenContext: okTokenContext(SAMPLE_CTX),
    });
    const code = await runWhoamiCommand(flags({ json: true }), deps);
    assert.equal(code, 0);
    const report = JSON.parse(rec.out[0]) as WhoamiReport;
    assert.deepEqual(report.tokenContext, {
      scopes: ["read", "write", "admin"],
      grandfathered: true,
      workspacePinned: false,
      workspaceId: null,
      userId: "user_1",
      displayName: "Provisioner Bot",
      emoji: "🤖",
      rateLimit: {
        limitPerMinute: 120,
        used: 4,
        remaining: 116,
        resetInSeconds: 30,
      },
    });
    assertNoTokenLeak(rec);
  });

  it("renders a pinned workspace and explicit (non-grandfathered) scopes", async () => {
    const { deps, rec } = makeDeps({
      tokenContext: okTokenContext({
        ...SAMPLE_CTX,
        scopes: ["read"],
        storedScopes: ["read"],
        grandfathered: false,
        workspacePinned: true,
        workspaceId: "ws_9",
      }),
    });
    await runWhoamiCommand(flags(), deps);
    const out = rec.out.join("\n");
    assert.match(out, /workspace:\s+pinned to ws_9/);
    assert.ok(!out.includes("grandfathered"));
    assertNoTokenLeak(rec);
  });

  it("falls back to the honest note when get_token_context is unavailable (older server)", async () => {
    // Best-effort: an older server refuses the tool. whoami still prints the
    // config + workspaces it proved and shows the scope note instead.
    const { deps, rec } = makeDeps({
      tokenContext: errorResult({
        error: { code: "INVALID_INPUT", message: "unknown tool" },
      }),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 0);
    assert.ok(rec.out.join("\n").includes(WHOAMI_SCOPE_NOTE));
    assertNoTokenLeak(rec);
  });

  it("falls back to the note when get_token_context returns a non-context payload", async () => {
    // The parser drops anything without the context shape rather than crash.
    const { deps, rec } = makeDeps({
      tokenContext: okWorkspaces([
        { id: "ws_1", name: "Acme", slug: "acme", role: "ADMIN" },
      ]),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 0);
    const report = JSON.parse(
      await (async () => {
        const j = makeDeps({
          tokenContext: okWorkspaces([
            { id: "ws_1", name: "Acme", slug: "acme", role: "ADMIN" },
          ]),
        });
        await runWhoamiCommand(flags({ json: true }), j.deps);
        return j.rec.out[0];
      })(),
    ) as WhoamiReport;
    assert.equal(report.tokenContext, null);
    assert.ok(rec.out.join("\n").includes(WHOAMI_SCOPE_NOTE));
    assertNoTokenLeak(rec);
  });
});

describe("runWhoamiCommand — config source reporting", () => {
  it("reports the --token/--url flag source", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runWhoamiCommand(
      flags({ token: "tm_flag_token_zzzz", url: "https://ex.test/api/mcp" }),
      deps,
    );
    assert.equal(code, 0);
    const report = JSON.parse(
      await (async () => {
        // re-run in --json to inspect sources precisely
        const j = makeDeps({ env: {} });
        await runWhoamiCommand(
          flags({
            json: true,
            token: "tm_flag_token_zzzz",
            url: "https://ex.test/api/mcp",
          }),
          j.deps,
        );
        return j.rec.out[0];
      })(),
    ) as WhoamiReport;
    assert.equal(report.tokenSource, "flag");
    assert.equal(report.urlSource, "flag");
    assert.equal(report.url, "https://ex.test/api/mcp");
    assert.match(rec.out.join("\n"), /--url \/ --token flag/);
  });

  it("reports the config-file source", async () => {
    const { deps, rec } = makeDeps({
      env: {},
      configFile: () => ({
        token: "tm_file_token_ffff",
        url: "https://f.test/api/mcp",
      }),
    });
    await runWhoamiCommand(flags({ json: true }), deps);
    const report = JSON.parse(rec.out[0]) as WhoamiReport;
    assert.equal(report.tokenSource, "file");
    assert.equal(report.urlSource, "file");
  });
});

describe("runWhoamiCommand — error paths (no token leak on any of them)", () => {
  it("no token configured → exit 7, actionable message, nothing sent", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 7);
    assert.equal(rec.connects.length, 0);
    assert.match(rec.err.join("\n"), /no token configured/);
  });

  it("a malformed config file whose error text carries the token is caught + scrubbed (exit 2)", async () => {
    // SVR C4.1-R1-2 refinement: reading/parsing the config file happens inside
    // runWhoamiCommand's try, so a ConfigError from a bad file must surface
    // through the SCRUBBED branch and return exit 2 (not escape to main.ts's
    // un-scrubbed catch). The file token is a candidate secret, so its value
    // must be masked in the message.
    const { deps, rec } = makeDeps({
      env: {},
      configFile: () => {
        throw new ConfigError(
          `config file ~/.config/stacks/config.json is not valid JSON near ` +
            `"token": "${FULL_TOKEN}"`,
          2,
        );
      },
    });
    // Give a flag token so config resolution wouldn't fail for a missing token
    // — the failure must come purely from the malformed file read.
    const code = await runWhoamiCommand(flags({ token: FULL_TOKEN }), deps);
    assert.equal(code, 2);
    assert.equal(rec.connects.length, 0);
    assert.match(rec.err.join("\n"), /not valid JSON/);
    assert.match(rec.err.join("\n"), /<redacted token>/);
    assertNoTokenLeak(rec);
  });

  it("masks a token-SHAPED value in a config parse error even with NO known secret (exit 2)", async () => {
    // SVR C4.1-R1-2 (round-3 refinement): a malformed config file's PARSE
    // error can echo a token straight from the file BEFORE it is parsed into a
    // known secret — with no --token and no STACKS_TOKEN, `secrets` is empty,
    // so exact-value scrubbing cannot catch it. The ConfigError branch also
    // masks anything token-shaped (`tm_…`/`tmo_…`), so the value is redacted.
    const LEAKY = "tm_short"; // the reviewer's exact repro value — no known secret
    const { deps, rec } = makeDeps({
      env: {},
      configFile: () => {
        throw new ConfigError(
          `config file is not valid JSON near "${LEAKY}"`,
          2,
        );
      },
    });
    // No --token and no STACKS_TOKEN: `secrets` is empty, so only the
    // token-shape mask can catch LEAKY.
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 2);
    const err = rec.err.join("\n");
    assert.ok(!err.includes(LEAKY), `token-shaped value leaked: ${err}`);
    assert.match(err, /is not valid JSON/);
    assert.match(err, /<redacted token>/);
  });

  it("a token mistakenly passed as --url is scrubbed from the ConfigError (exit 2)", async () => {
    // Load-bearing for the CONFIG-error redaction (SVR C4.1-R1-2): the
    // invalid-URL ConfigError echoes the raw --url value; if a caller sets it
    // to their token, the token must not reach stderr. `not a url`-style tests
    // don't cover this because their bad value isn't a secret.
    const { deps, rec } = makeDeps({ env: { STACKS_TOKEN: FULL_TOKEN } });
    const code = await runWhoamiCommand(flags({ url: FULL_TOKEN }), deps);
    assert.equal(code, 2);
    assert.equal(rec.connects.length, 0);
    // The error still explains the problem, but with the secret masked.
    assert.match(rec.err.join("\n"), /invalid MCP URL/);
    assert.match(rec.err.join("\n"), /<redacted token>/);
    assertNoTokenLeak(rec);
  });

  it("malformed URL from a flag → exit 2, no connect", async () => {
    const { deps, rec } = makeDeps({ env: { STACKS_TOKEN: FULL_TOKEN } });
    const code = await runWhoamiCommand(flags({ url: "not a url" }), deps);
    assert.equal(code, 2);
    assert.equal(rec.connects.length, 0);
    assertNoTokenLeak(rec);
  });

  it("dead token (401 at connect) → exit 7 with the mint-a-PAT message", async () => {
    const { deps, rec } = makeDeps({
      connectError: Object.assign(new Error("HTTP 401"), { code: 401 }),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 7);
    assert.match(rec.err.join("\n"), /HTTP 401.*mint a new PAT/s);
    assertNoTokenLeak(rec);
  });

  it("transport error that echoes the auth header is redacted (exit 7)", async () => {
    // Simulate an SDK error whose message includes the Bearer header — the
    // failure path MUST scrub it. This is the SVR 'error paths too' focus.
    const { deps, rec } = makeDeps({
      connectError: new Error(
        `connect ECONNREFUSED (Authorization: Bearer ${FULL_TOKEN})`,
      ),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 7);
    const err = rec.err.join("\n");
    assert.match(err, /cannot reach/);
    assert.match(err, /<redacted token>/);
    assertNoTokenLeak(rec);
  });

  it("list_workspaces FORBIDDEN (token lacks read) → exit 3, no token leak", async () => {
    const { deps, rec } = makeDeps({
      result: errorResult({
        error: { code: "FORBIDDEN", message: "read scope required" },
      }),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 3);
    assert.match(rec.err.join("\n"), /FORBIDDEN: read scope required/);
    assert.equal(rec.closed, 1);
    assertNoTokenLeak(rec);
  });

  it("a list_workspaces error that echoes the token is scrubbed on BOTH streams (exit 5)", async () => {
    // Load-bearing for the stdout AND stderr redaction on the call-failure
    // path: a CONFLICT envelope is the one case `callTool` puts text on BOTH
    // streams — the message on stderr, `error.current` as JSON on stdout. Both
    // carry the FULL_TOKEN here, so if `redact()` were dropped from EITHER
    // write in runWhoamiCommand, assertNoTokenLeak would fail. (A plain
    // FORBIDDEN fixture carries no token and would pass even without the
    // redaction — hence this hostile envelope.)
    const { deps, rec } = makeDeps({
      result: errorResult({
        error: {
          code: "CONFLICT",
          message: `upstream rejected (Authorization: Bearer ${FULL_TOKEN})`,
          current: { leakedInStdout: FULL_TOKEN },
        },
      }),
    });
    const code = await runWhoamiCommand(flags(), deps);
    assert.equal(code, 5);
    assert.match(rec.err.join("\n"), /CONFLICT: upstream rejected/);
    // stderr scrubbed…
    assert.match(rec.err.join("\n"), /<redacted token>/);
    // …and stdout (error.current) scrubbed too.
    assert.match(rec.out.join("\n"), /<redacted token>/);
    assertNoTokenLeak(rec);
  });
});
