import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  browserLikelyUnreachable,
  parsePastedInput,
  runLoginCommand,
  type LoginDeps,
} from "../src/commands/login";
import {
  readConfigFile,
  type ConfigFileReader,
  type ConfigFileWriter,
} from "../src/config";
import type { CallbackResult, LoopbackListener } from "../src/loopback";

const CONFIG_PATH = "/home/u/.config/stacks/config.json";
const NOW = Date.parse("2026-07-09T12:00:00.000Z");
// OAuth login requires an HTTPS origin (the AS rejects non-https client_ids);
// tests stub the network, so any https origin exercises the flow. A plain-http
// origin is separately tested to be REJECTED (see the "http origin" case).
const ORIGIN_URL = "https://tm.jentrix.ai/api/mcp";

interface Recorded {
  out: string[];
  err: string[];
  files: Map<string, string>;
  opened: string[];
  bindPorts: number[][];
  closed: number;
  scaffolded: string[];
  /** `out.length` at the moment the browser was opened (AC1.4 ordering). */
  outAtBrowserOpen: number | null;
  /** Prompts the CONCURRENT listener-path stdin read was given. */
  pastePrompts: string[];
  /** How many times that read was aborted (AC1.3: no dangling prompt). */
  pasteAborted: number;
  /** Token-endpoint calls made (JEN-306: a retry must not re-authorize). */
  tokenCalls: number;
  /** Prompts `readLine` was given (JEN-306 retry prompt). */
  linePrompts: string[];
}

/** Build LoginDeps with a scripted token endpoint + loopback behaviour. */
function makeDeps(opts: {
  /** What the callback delivers (code + state). If a function, called lazily. */
  callback?: CallbackResult | (() => Promise<CallbackResult>);
  /** Ports free to bind; null → all busy (paste fallback). */
  bindResultPort?: number | null;
  /** Pasted line for the --paste path. */
  pasted?: string;
  /** Token-endpoint JSON response. */
  tokenResponse?: Record<string, unknown>;
  tokenStatus?: number;
  /** AS metadata response (defaults to conventional-path fallback via 404). */
  metadata?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
  /** TTY simulation (default false — legacy non-interactive behaviour). */
  interactive?: boolean;
  /** Scripted readLine answers, consumed in order (before `pasted`). */
  answers?: string[];
  /** Working directory for --local (default /work/project). */
  cwd?: string;
  /** Pre-existing config file contents keyed by path. */
  seedFiles?: Record<string, string>;
  /**
   * What the CONCURRENT (listener-path) stdin read delivers. Undefined — the
   * default — is a read that NEVER settles, which is what a real terminal
   * with nobody typing does, and what every pre-existing test assumes.
   */
  concurrentPaste?: string | (() => Promise<string | null>);
  /** What `readFileIfPresent` can see (the container probe). */
  probeFiles?: Record<string, string>;
  /**
   * JEN-306 — make the AS metadata probe FAIL: a status an intermediary
   * returns, or "throw" for a request that never completes.
   */
  metadataFailure?: number | "throw";
  /**
   * JEN-306 — scripted token-endpoint answers, consumed one per call. An
   * exhausted list falls through to the default success response, which is how
   * "intercepted, then works after the operator fixes the proxy" is expressed.
   */
  tokenSequence?: ({ status: number; body: string } | "throw")[];
}): { deps: LoginDeps; rec: Recorded } {
  const rec: Recorded = {
    out: [],
    err: [],
    files: new Map(Object.entries(opts.seedFiles ?? {})),
    opened: [],
    bindPorts: [],
    closed: 0,
    scaffolded: [],
    outAtBrowserOpen: null,
    pastePrompts: [],
    pasteAborted: 0,
    tokenCalls: 0,
    linePrompts: [],
  };
  const answers = [...(opts.answers ?? [])];
  const reader: ConfigFileReader = {
    readFileSync(path: string) {
      const v = rec.files.get(path);
      if (v === undefined)
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
  };
  const writer: ConfigFileWriter = {
    mkdirSync() {},
    writeFileSync(path: string, data: string) {
      rec.files.set(path, data);
    },
    chmodSync() {},
    renameSync(from: string, to: string) {
      rec.files.set(to, rec.files.get(from)!);
      rec.files.delete(from);
    },
  };

  const tokenSequence = [...(opts.tokenSequence ?? [])];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes("/.well-known/oauth-authorization-server")) {
      if (opts.metadataFailure === "throw") {
        throw new TypeError("fetch failed");
      }
      if (typeof opts.metadataFailure === "number") {
        return new Response("<html>Forbidden</html>", {
          status: opts.metadataFailure,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (opts.metadata === undefined || opts.metadata === null) {
        return new Response("nope", { status: 404 });
      }
      return new Response(JSON.stringify(opts.metadata), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // token endpoint
    rec.tokenCalls += 1;
    const scripted = tokenSequence.shift();
    if (scripted === "throw") throw new TypeError("fetch failed");
    if (scripted) {
      return new Response(scripted.body, {
        status: scripted.status,
        headers: { "Content-Type": "text/html" },
      });
    }
    return new Response(
      JSON.stringify(
        opts.tokenResponse ?? {
          access_token: "tmo_access",
          refresh_token: "tmr_refresh",
          expires_in: 3600,
          scope: "read write",
        },
      ),
      {
        status: opts.tokenStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;

  const deps: LoginDeps = {
    env: opts.env ?? { STACKS_MCP_URL: ORIGIN_URL },
    configPath: CONFIG_PATH,
    cwd: () => opts.cwd ?? "/work/project",
    isInteractive: opts.interactive ?? false,
    scaffoldProjectDir: (dir) => {
      rec.scaffolded.push(dir);
    },
    bindLoopback: async (ports) => {
      rec.bindPorts.push([...ports]);
      if (opts.bindResultPort === null) return null;
      const port = opts.bindResultPort ?? ports[0];
      const listener: LoopbackListener = {
        port,
        waitForCode: async () => {
          if (typeof opts.callback === "function") return opts.callback();
          return opts.callback ?? { code: "AUTHCODE", state: "__STATE__" };
        },
        close: async () => {
          rec.closed += 1;
        },
      };
      return listener;
    },
    openBrowser: async (u) => {
      rec.opened.push(u);
      rec.outAtBrowserOpen = rec.out.length;
    },
    readLine: async (prompt: string) => {
      rec.linePrompts.push(prompt);
      return answers.length > 0 ? answers.shift()! : (opts.pasted ?? "");
    },
    readPastedRedirect: async (prompt, signal) => {
      rec.pastePrompts.push(prompt);
      signal.addEventListener(
        "abort",
        () => {
          rec.pasteAborted += 1;
        },
        { once: true },
      );
      const scripted = opts.concurrentPaste;
      // Nobody is typing: the read stays pending, exactly as a real terminal
      // does, so the callback decides the race on its own.
      if (scripted === undefined) return new Promise<string | null>(() => {});
      return typeof scripted === "function" ? scripted() : scripted;
    },
    readFileIfPresent: (path) => opts.probeFiles?.[path] ?? null,
    writeOut: (t) => rec.out.push(t),
    writeErr: (t) => rec.err.push(t),
    now: () => NOW,
    fetchImpl,
    io: { reader, writer },
  };
  return { deps, rec };
}

/** The state the listener echoes back is captured from the authorize URL. */
function stateFromAuthorizeUrl(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/https?:\/\/\S+/);
    if (m) {
      const u = new URL(m[0]);
      const s = u.searchParams.get("state");
      if (s) return s;
    }
  }
  return null;
}

describe("parsePastedInput", () => {
  it("extracts code + state from a full redirect URL", () => {
    const r = parsePastedInput(
      "http://127.0.0.1:8976/callback?code=ABC&state=XYZ",
    );
    assert.deepEqual(r, { code: "ABC", state: "XYZ" });
  });

  it("accepts a bare code (no state)", () => {
    assert.deepEqual(parsePastedInput("  RAWCODE  "), {
      code: "RAWCODE",
      state: null,
    });
  });

  it("surfaces an ?error= redirect", () => {
    const r = parsePastedInput(
      "http://127.0.0.1:8976/callback?error=access_denied",
    );
    assert.ok("error" in r && /access_denied/.test(r.error));
  });

  it("errors on empty input and on a URL without a code", () => {
    assert.ok("error" in parsePastedInput(""));
    assert.ok(
      "error" in parsePastedInput("http://127.0.0.1:8976/callback?state=only"),
    );
  });
});

describe("runLoginCommand — happy path (listener)", () => {
  it("opens the browser, awaits the callback, persists the tmo_/tmr_ pair", async () => {
    // We must echo back the SAME state the command generated. Capture the
    // authorize URL's state as it's printed, then feed it into the callback.
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      tokenResponse: {
        access_token: "tmo_access_x",
        refresh_token: "tmr_refresh_x",
        expires_in: 3600,
        scope: "read write",
      },
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };

    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    assert.equal(rec.opened.length, 1, "browser opened once");
    // Browser was opened with an authorize URL carrying PKCE S256.
    const u = new URL(rec.opened[0]);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.ok(u.searchParams.get("code_challenge"));
    assert.equal(
      u.searchParams.get("client_id"),
      "https://tm.jentrix.ai/oauth/stacks-cli.json",
    );
    assert.equal(
      u.searchParams.get("redirect_uri"),
      "http://127.0.0.1:8976/callback",
    );
    // Persisted the pair to the in-memory config file.
    const saved = readConfigFile(CONFIG_PATH, {
      readFileSync: (p: string) => rec.files.get(p)!,
    });
    assert.equal(saved?.token, "tmo_access_x");
    assert.equal(saved?.oauth?.refreshToken, "tmr_refresh_x");
    assert.equal(
      saved?.oauth?.expiresAt,
      new Date(NOW + 3600 * 1000).toISOString(),
    );
    assert.equal(saved?.url, ORIGIN_URL);
    // Success line shows only a redacted hint.
    const okLine = rec.out.find((l) => /Signed in/.test(l));
    assert.ok(okLine, "success line printed");
    assert.match(okLine!, /tmo_…/);
    // Token secrecy: the FULL tokens never appear in printed output.
    const printed = [...rec.out, ...rec.err].join("\n");
    assert.ok(
      !printed.includes("tmo_access_x"),
      "access token leaked to output",
    );
    assert.ok(
      !printed.includes("tmr_refresh_x"),
      "refresh token leaked to output",
    );
  });
});

describe("runLoginCommand — state mismatch is a hard error", () => {
  it("listener callback with wrong state → exit 7, nothing persisted", async () => {
    const { deps, rec } = makeDeps({
      callback: { code: "AUTHCODE", state: "WRONG_STATE_NEVER_MATCHES" },
    });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 7);
    assert.ok(rec.err.some((l) => /state mismatch/i.test(l)));
    // No token exchange happened → no success line.
    assert.ok(!rec.out.some((l) => /Signed in/.test(l)));
  });

  it("paste path with wrong state → exit 7", async () => {
    const { deps, rec } = makeDeps({
      bindResultPort: null, // force paste fallback
      pasted: "http://127.0.0.1:8976/callback?code=ABC&state=WRONG",
    });
    const code = await runLoginCommand({ url: ORIGIN_URL, paste: true }, deps);
    assert.equal(code, 7);
    assert.ok(rec.err.some((l) => /state mismatch/i.test(l)));
  });

  it("paste path with a bare code (no state) → exit 7 (state is mandatory) [C4.2-R1-1]", async () => {
    const { deps, rec } = makeDeps({
      bindResultPort: null,
      pasted: "RAWCODEWITHOUTSTATE",
    });
    const code = await runLoginCommand({ url: ORIGIN_URL, paste: true }, deps);
    assert.equal(code, 7);
    assert.ok(
      rec.err.some((l) => /no state parameter|state mismatch/i.test(l)),
      rec.err.join("\n"),
    );
    // Never reached token exchange.
    assert.equal(rec.files.has(CONFIG_PATH), false);
  });

  it("paste path with a URL missing ?state= → exit 7 [C4.2-R1-1]", async () => {
    const { deps, rec } = makeDeps({
      bindResultPort: null,
      pasted: "http://127.0.0.1:8976/callback?code=ABC",
    });
    const code = await runLoginCommand({ url: ORIGIN_URL, paste: true }, deps);
    assert.equal(code, 7);
    assert.ok(rec.err.some((l) => /no state parameter/i.test(l)));
  });
});

describe("runLoginCommand — port fallback", () => {
  it("all ports busy → prints the URL + paste instructions, then consumes the pasted code", async () => {
    // bindResultPort null → bindLoopback returns null → paste fallback. The
    // pasted URL must carry the generated state; capture it as it's printed.
    const { deps, rec } = makeDeps({ bindResultPort: null });
    deps.readLine = async () => {
      const state = stateFromAuthorizeUrl(rec.out);
      return `http://127.0.0.1:8976/callback?code=PASTEDCODE&state=${state}`;
    };
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    // bindLoopback was tried with all three ports before falling back.
    assert.deepEqual(rec.bindPorts[0], [8976, 8977, 8978]);
    // The busy-ports notice + paste instructions were emitted.
    assert.ok(
      rec.err.some((l) => /busy/.test(l)) ||
        rec.out.some((l) => /paste/i.test(l)),
    );
    // Redirect URI used the FIRST registered port.
    const authLine = rec.out.find((l) => /oauth\/authorize/.test(l));
    const u = new URL(authLine!.match(/https?:\/\/\S+/)![0]);
    assert.equal(
      u.searchParams.get("redirect_uri"),
      "http://127.0.0.1:8976/callback",
    );
    // Persisted (proves the pasted-code exchange completed).
    const saved = readConfigFile(CONFIG_PATH, {
      readFileSync: (p: string) => rec.files.get(p)!,
    });
    assert.equal(saved?.token, "tmo_access");
  });
});

describe("runLoginCommand — bad URL", () => {
  it("invalid --url → exit 2 (usage), no tokens touched", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runLoginCommand({ url: "not a url" }, deps);
    assert.equal(code, 2);
    assert.ok(rec.err.some((l) => /invalid MCP URL/.test(l)));
  });

  it("a token-shaped --url is REDACTED in the error (never echoed) [C4.2-R1-6]", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    // A user fat-fingers their token into --url. It's not a valid URL → the
    // error branch must NOT echo the token.
    const code = await runLoginCommand(
      { url: "tmo_super_secret_value_xyz" },
      deps,
    );
    assert.equal(code, 2);
    const all = [...rec.out, ...rec.err].join("\n");
    assert.ok(
      !all.includes("tmo_super_secret_value_xyz"),
      "token leaked in URL error",
    );
    assert.ok(all.includes("<redacted token>"));
  });

  it("a STACKS_TOKEN value that leaks into a bad-URL error is redacted [C4.2-R1-6]", async () => {
    // STACKS_MCP_URL set to the token by mistake, STACKS_TOKEN also set.
    const secret = "tm_env_secret_abcd";
    const { deps, rec } = makeDeps({
      env: { STACKS_TOKEN: secret, STACKS_MCP_URL: "://broken" },
    });
    const code = await runLoginCommand({}, deps);
    assert.equal(code, 2);
    const all = [...rec.out, ...rec.err].join("\n");
    assert.ok(!all.includes(secret), "STACKS_TOKEN leaked in URL error");
  });

  it("an http origin (no --client-id) → exit 2 with an actionable message (no browser opened) [C4.2-R1-2]", async () => {
    // The AS requires an https client_id; login must fail up front on http,
    // pointing the user at an https origin / --client-id / a PAT — not open a
    // browser.
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runLoginCommand(
      { url: "http://127.0.0.1:3100/api/mcp" },
      deps,
    );
    assert.equal(code, 2);
    assert.ok(
      rec.err.some((l) => /https client_id/i.test(l)),
      rec.err.join("\n"),
    );
    assert.ok(
      rec.err.some((l) => /--client-id|STACKS_TOKEN/.test(l)),
      "suggests a remedy",
    );
    assert.equal(
      rec.opened.length,
      0,
      "must not open a browser on a rejected origin",
    );
  });

  it("a token-shaped http origin is REDACTED in the https-required error [C4.2-R3-1]", async () => {
    // A syntactically valid http URL embedding a token must NOT leak.
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runLoginCommand(
      { url: "http://tmo_super_secret_value_xyz/api/mcp" },
      deps,
    );
    assert.equal(code, 2);
    const all = [...rec.out, ...rec.err].join("\n");
    assert.ok(
      !all.includes("tmo_super_secret_value_xyz"),
      "token leaked in origin",
    );
    assert.ok(all.includes("<redacted token>"));
  });
});

describe("runLoginCommand — --client-id override", () => {
  it("an https --client-id lets a local http server complete the flow [C4.2-R1-2]", async () => {
    // Local http AS + deployed https CIMD metadata URL: authorize/token stay
    // local, but the client_id the AS validates is https.
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      env: { STACKS_MCP_URL: "http://127.0.0.1:3100/api/mcp" },
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      tokenResponse: {
        access_token: "tmo_local",
        refresh_token: "tmr_local",
        expires_in: 3600,
        scope: "read write",
      },
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    const code = await runLoginCommand(
      { clientId: "https://tm.jentrix.ai/oauth/stacks-cli.json" },
      deps,
    );
    assert.equal(code, 0, rec.err.join("\n"));
    // client_id in the authorize URL is the https override; the token endpoint
    // stayed local (127.0.0.1:3100) — we persisted a token, proving exchange ran.
    const u = new URL(rec.opened[0]);
    assert.equal(
      u.searchParams.get("client_id"),
      "https://tm.jentrix.ai/oauth/stacks-cli.json",
    );
    const saved = readConfigFile(CONFIG_PATH, {
      readFileSync: (p: string) => rec.files.get(p)!,
    });
    assert.equal(saved?.token, "tmo_local");
  });

  it("a non-https --client-id → exit 2", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runLoginCommand(
      {
        url: "https://tm.jentrix.ai/api/mcp",
        clientId: "http://evil/meta.json",
      },
      deps,
    );
    assert.equal(code, 2);
    assert.ok(rec.err.some((l) => /--client-id must be an https URL/.test(l)));
  });

  it("a token-shaped --client-id is REDACTED in the error [C4.2-R3-1]", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runLoginCommand(
      {
        url: "https://tm.jentrix.ai/api/mcp",
        clientId: "tmo_secret_clientid_value",
      },
      deps,
    );
    assert.equal(code, 2);
    const all = [...rec.out, ...rec.err].join("\n");
    assert.ok(
      !all.includes("tmo_secret_clientid_value"),
      "token leaked in client-id error",
    );
  });
});

describe("runLoginCommand — token exchange rejected", () => {
  it("token endpoint invalid_grant → exit 7, redaction-safe", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      tokenResponse: {
        error: "invalid_grant",
        error_description: "code expired",
      },
      tokenStatus: 400,
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 7);
    assert.ok(rec.err.some((l) => /token exchange failed/.test(l)));
    assert.ok(rec.err.some((l) => /invalid_grant/.test(l)));
    // Nothing persisted on a failed exchange.
    assert.equal(rec.files.has(CONFIG_PATH), false);
  });
});

describe("runLoginCommand — per-project servers (AGE-952)", () => {
  /** Full listener-path login with the state echo wired up. */
  async function runHappy(
    opts: Parameters<typeof makeDeps>[0],
    flags: Parameters<typeof runLoginCommand>[0],
  ) {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      ...opts,
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    const code = await runLoginCommand(flags, deps);
    return { code, rec };
  }

  it("--local scaffolds ./.stacks and persists there, not the home config", async () => {
    const { code, rec } = await runHappy({}, { local: true });
    assert.equal(code, 0);
    assert.deepEqual(rec.scaffolded, ["/work/project"]);
    const localPath = "/work/project/.stacks/config.json";
    assert.ok(rec.files.has(localPath), "local config not written");
    assert.equal(rec.files.has(CONFIG_PATH), false, "home config written");
    const saved = JSON.parse(rec.files.get(localPath)!);
    assert.equal(saved.token, "tmo_access");
    assert.equal(saved.url, ORIGIN_URL);
    assert.ok(rec.out.some((l) => /bound to that server/.test(l)));
  });

  it("uses the target config file's url when --url and env are absent", async () => {
    const { code, rec } = await runHappy(
      {
        env: {},
        seedFiles: {
          [CONFIG_PATH]: JSON.stringify({
            url: "https://stored.example/api/mcp",
          }),
        },
      },
      {},
    );
    assert.equal(code, 0);
    assert.ok(
      rec.opened[0]?.startsWith("https://stored.example/"),
      `authorized against ${rec.opened[0]}`,
    );
    const saved = JSON.parse(rec.files.get(CONFIG_PATH)!);
    assert.equal(saved.url, "https://stored.example/api/mcp");
  });

  it("interactive + nothing configured → server picker; empty answer = option 1", async () => {
    const { code, rec } = await runHappy(
      { env: {}, interactive: true, answers: [""] },
      {},
    );
    assert.equal(code, 0);
    assert.ok(rec.out.some((l) => /Which Jentrix server/.test(l)));
    assert.ok(
      rec.opened[0]?.startsWith("https://stacks-mvp.vercel.app/"),
      `authorized against ${rec.opened[0]}`,
    );
  });

  it("picker custom-URL option is honoured", async () => {
    const { code, rec } = await runHappy(
      {
        env: {},
        interactive: true,
        answers: ["3", "https://custom.example/api/mcp"],
      },
      {},
    );
    assert.equal(code, 0);
    assert.ok(
      rec.opened[0]?.startsWith("https://custom.example/"),
      `authorized against ${rec.opened[0]}`,
    );
    const saved = JSON.parse(rec.files.get(CONFIG_PATH)!);
    assert.equal(saved.url, "https://custom.example/api/mcp");
  });

  it("three unusable picker answers → exit 2, nothing persisted", async () => {
    const { deps, rec } = makeDeps({
      env: {},
      interactive: true,
      answers: ["9", "x", "0"],
    });
    const code = await runLoginCommand({}, deps);
    assert.equal(code, 2);
    assert.ok(rec.err.some((l) => /no server chosen/.test(l)));
    assert.equal(rec.files.size, 0);
  });

  it("non-interactive + nothing configured keeps the production default", async () => {
    const { code, rec } = await runHappy({ env: {} }, {});
    assert.equal(code, 0);
    assert.ok(
      rec.opened[0]?.startsWith("https://tm.jentrix.ai/"),
      `authorized against ${rec.opened[0]}`,
    );
  });
});

// ---------------------------------------------------------------------------
// W1 / JEN-188 — the concurrent paste (PRD C1.1-C1.5, AC1.1-AC1.4).
//
// The listener binding says nothing about whether the BROWSER can reach it.
// A container, a remote shell, a VM or a locked-down browser leaves the CLI
// sitting in waitForCode() for five minutes with no exit but Ctrl-C — the one
// known point at which a non-developer abandoned setup (JEN-138). Both
// arrivals are now live at once; the CSRF guarantee is identical on both.
// ---------------------------------------------------------------------------

describe("browserLikelyUnreachable (C1.4)", () => {
  const noFiles = () => null;

  it("is false on an ordinary desktop", () => {
    assert.equal(browserLikelyUnreachable({ HOME: "/home/u" }, noFiles), false);
  });

  it("is true inside a container (/.dockerenv, or a container cgroup)", () => {
    assert.equal(
      browserLikelyUnreachable({}, (p) => (p === "/.dockerenv" ? "" : null)),
      true,
    );
    assert.equal(
      browserLikelyUnreachable({}, (p) =>
        p === "/proc/1/cgroup" ? "0::/kubepods/besteffort/podabc" : null,
      ),
      true,
    );
  });

  it("is true over SSH with no DISPLAY, false when one is forwarded", () => {
    assert.equal(
      browserLikelyUnreachable({ SSH_CONNECTION: "1.2.3.4 22" }, noFiles),
      true,
    );
    assert.equal(
      browserLikelyUnreachable(
        { SSH_CONNECTION: "1.2.3.4 22", DISPLAY: ":0" },
        noFiles,
      ),
      false,
    );
  });
});

describe("runLoginCommand — concurrent paste on the listener path", () => {
  /** A listener whose callback NEVER arrives — the failure this exists for. */
  const neverCallsBack = () => new Promise<CallbackResult>(() => {});

  it("AC1.1: a callback that never arrives completes from a paste, same command", async () => {
    const { deps, rec } = makeDeps({
      callback: neverCallsBack,
      // Read the state off the authorize URL the command just printed — the
      // paste has to carry THIS attempt's state to be accepted at all.
      concurrentPaste: async () =>
        `http://127.0.0.1:8976/callback?code=PASTEDCODE&state=${stateFromAuthorizeUrl(rec.out)}`,
      tokenResponse: {
        access_token: "tmo_from_paste",
        refresh_token: "tmr_from_paste",
        expires_in: 3600,
        scope: "read write",
      },
    });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    // The listener WAS bound (C1.1: concurrent, not instead-of) and the
    // redirect_uri stayed the listener's own port (C1.2).
    assert.deepEqual(rec.bindPorts[0], [8976, 8977, 8978]);
    assert.equal(
      new URL(rec.opened[0]!).searchParams.get("redirect_uri"),
      "http://127.0.0.1:8976/callback",
    );
    const saved = readConfigFile(CONFIG_PATH, {
      readFileSync: (p: string) => rec.files.get(p)!,
    });
    assert.equal(saved?.token, "tmo_from_paste");
    // The instruction was printed BEFORE the wait, not after a timeout.
    assert.ok(
      rec.out.some((l) => /paste it here/i.test(l)),
      rec.out.join("\n"),
    );
    assert.equal(rec.closed, 1, "listener closed");
  });

  it("AC1.2: a pasted URL with a MISMATCHED state is rejected, exactly as on --paste", async () => {
    const { deps, rec } = makeDeps({
      callback: neverCallsBack,
      concurrentPaste:
        "http://127.0.0.1:8976/callback?code=ABC&state=WRONG_STATE",
    });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 7);
    assert.ok(rec.err.some((l) => /state mismatch/i.test(l)));
    assert.equal(rec.files.has(CONFIG_PATH), false, "nothing persisted");
  });

  it("AC1.2: a pasted bare code (no state) is rejected on the concurrent path too", async () => {
    const { deps, rec } = makeDeps({
      callback: neverCallsBack,
      concurrentPaste: "RAWCODEWITHOUTSTATE",
    });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 7);
    assert.ok(rec.err.some((l) => /no state parameter/i.test(l)));
    assert.equal(rec.files.has(CONFIG_PATH), false);
  });

  it("AC1.3: when the callback wins, the output is unchanged and NO prompt dangles", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      // concurrentPaste omitted → the stdin read never settles, as in a real
      // terminal with nobody typing.
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    // The listener path's own lines are intact…
    assert.ok(rec.out.some((l) => /Opening your browser/.test(l)));
    assert.ok(rec.out.some((l) => /Waiting for the callback/.test(l)));
    // …and the last thing the operator sees is still the success block.
    assert.equal(rec.out.at(-1), "Run `jentrix whoami` to verify.");
    assert.match(rec.out.at(-2)!, /^Signed in\./);
    // The concurrent read was armed and then TORN DOWN — a prompt still
    // waiting on stdin after a successful login is the regression here.
    assert.equal(rec.pastePrompts.length, 1);
    assert.ok(rec.pasteAborted >= 1, "the stdin read was aborted");
    // The prompt itself is the reader's business; it never reached stdout.
    assert.ok(!rec.out.some((l) => /Paste the FULL redirect URL/.test(l)));
  });

  it("AC1.4: in a container the paste instruction comes BEFORE the browser opens", async () => {
    const { deps, rec } = makeDeps({
      callback: neverCallsBack,
      probeFiles: { "/.dockerenv": "" },
      concurrentPaste: async () =>
        `http://127.0.0.1:8976/callback?code=C&state=${stateFromAuthorizeUrl(rec.out)}`,
    });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    const instruction = rec.out.findIndex((l) => /paste it here/i.test(l));
    assert.ok(instruction >= 0, rec.out.join("\n"));
    assert.ok(
      rec.outAtBrowserOpen !== null && instruction < rec.outAtBrowserOpen,
      "the paste instruction must be printed before openBrowser is called",
    );
    assert.ok(rec.out.some((l) => /container or a remote shell/.test(l)));
    // Still binds the listener — it may work (C1.4).
    assert.deepEqual(rec.bindPorts[0], [8976, 8977, 8978]);
  });

  it("a stray empty line does not kill the login — the callback still wins", async () => {
    let capturedState: string | null = null;
    let reads = 0;
    const { deps, rec } = makeDeps({
      callback: async () => {
        // Let the empty line be consumed first, then deliver the callback.
        await new Promise((r) => setTimeout(r, 5));
        return { code: "AUTHCODE", state: capturedState ?? "" };
      },
      concurrentPaste: async () => (reads++ === 0 ? "" : null),
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    assert.ok(reads >= 2, "the empty line re-prompted rather than failing");
  });

  it("--paste still skips the listener entirely (C1.5: no new flag, no changed meaning)", async () => {
    const { deps, rec } = makeDeps({ pasted: "unused" });
    await runLoginCommand({ url: ORIGIN_URL, paste: true }, deps);
    assert.equal(rec.bindPorts.length, 0, "no loopback bind under --paste");
    assert.equal(
      rec.pastePrompts.length,
      0,
      "no concurrent read under --paste",
    );
  });
});

describe("runLoginCommand — proxy / interception handling (JEN-306)", () => {
  // Defect 2: discovery could not tell "host unreachable" from "bare
  // deployment", so the CLI printed an authorize URL, the operator completed a
  // consent in a browser on a DIFFERENT network path, and only the CLI's leg
  // died. The wasted browser trip is the expensive part.
  it("aborts BEFORE the browser step when a gateway answers the metadata probe", async () => {
    const { deps, rec } = makeDeps({ metadataFailure: 403 });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 7);
    assert.equal(rec.opened.length, 0, "browser must NOT be opened");
    assert.equal(rec.bindPorts.length, 0, "no listener bound either");
    assert.equal(rec.tokenCalls, 0);
    assert.ok(
      !rec.out.some((line) => line.includes("/oauth/authorize")),
      "no authorize URL may be printed",
    );
    const err = rec.err.join("\n");
    assert.match(err, /cannot reach https:\/\/tm\.jentrix\.ai/);
    assert.match(err, /no authorization was wasted/);
    // And it names the proxy as the thing to look at, not the server.
    assert.match(err, /HTTPS_PROXY/);
  });

  it("aborts before the browser when the metadata request never completes", async () => {
    const { deps, rec } = makeDeps({ metadataFailure: "throw" });
    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 7);
    assert.equal(rec.opened.length, 0);
    assert.match(rec.err.join("\n"), /cannot reach/);
  });

  it("names the CONFIGURED proxy when one is set", async () => {
    const { deps, rec } = makeDeps({
      metadataFailure: 502,
      env: { STACKS_MCP_URL: ORIGIN_URL, HTTPS_PROXY: "http://gw:3128" },
    });
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 7);
    const err = rec.err.join("\n");
    assert.match(err, /proxy in HTTPS_PROXY/);
    // A proxy URL can carry credentials — never echo the value.
    assert.ok(!err.includes("gw:3128"), "proxy value must not be printed");
  });

  it("a 404 metadata probe still falls through to the conventional paths", async () => {
    // The reachability check must not break a bare deployment.
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 0);
    assert.equal(rec.opened.length, 1);
  });

  // Defect 3: an intercepted POST RESOLVES with an HTML error page, which fell
  // through to `invalid_response` ("token exchange failed") and then exited,
  // discarding a single-use code that was still unspent.
  it("re-prompts and redeems the SAME code after an intercepted exchange", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      interactive: true,
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      // First exchange is eaten by the gateway; then the operator fixes it.
      tokenSequence: [{ status: 403, body: "<html>403 Forbidden</html>" }],
      answers: [""], // just press Enter
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };

    const code = await runLoginCommand({ url: ORIGIN_URL }, deps);
    assert.equal(code, 0, rec.err.join("\n"));
    assert.equal(rec.tokenCalls, 2, "the same code is retried once");
    assert.equal(rec.opened.length, 1, "the browser is NOT opened again");
    const err = rec.err.join("\n");
    assert.match(err, /never reached/);
    assert.match(err, /not a Jentrix rejection/);
    assert.ok(
      !/token exchange failed/.test(err),
      "must not blame the server for a request that never arrived",
    );
    assert.match(rec.out.join("\n"), /still unused/);
    assert.ok(
      rec.linePrompts.some((p) => /Press Enter to retry/.test(p)),
      "the operator is offered a retry",
    );
    // The credentials really landed.
    const saved = readConfigFile(CONFIG_PATH, deps.io!.reader);
    assert.ok(saved?.oauth?.refreshToken);
  });

  it("accepts a RE-pasted redirect URL on retry, with the same state check", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      interactive: true,
      bindResultPort: null, // paste path
      tokenSequence: ["throw"],
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    // First `readLine` is the initial paste; the second is the retry prompt.
    let asked = 0;
    deps.readLine = async (prompt: string) => {
      rec.linePrompts.push(prompt);
      asked += 1;
      return `http://127.0.0.1:8976/callback?code=C${asked}&state=${capturedState}`;
    };
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 0);
    assert.equal(rec.tokenCalls, 2);
  });

  it("a re-pasted URL with the WRONG state is still rejected", async () => {
    const { deps, rec } = makeDeps({
      interactive: true,
      bindResultPort: null,
      tokenSequence: ["throw"],
    });
    let asked = 0;
    deps.readLine = async (prompt: string) => {
      rec.linePrompts.push(prompt);
      asked += 1;
      return asked === 1
        ? `http://127.0.0.1:8976/callback?code=C&state=${stateFromAuthorizeUrl(rec.out)}`
        : "http://127.0.0.1:8976/callback?code=C2&state=ATTACKER";
    };
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 7);
    assert.match(rec.err.join("\n"), /state mismatch/);
  });

  it("does not loop on a non-TTY — it reports and exits", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      interactive: false,
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      tokenSequence: [{ status: 403, body: "<html>nope</html>" }],
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 7);
    assert.equal(rec.tokenCalls, 1, "no retry without a terminal to prompt");
    assert.ok(!rec.linePrompts.some((p) => /Press Enter/.test(p)));
  });

  it("a real invalid_grant still exits immediately — retrying cannot help", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      interactive: true,
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      tokenResponse: {
        error: "invalid_grant",
        error_description: "code already used",
      },
      tokenStatus: 400,
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 7);
    assert.equal(rec.tokenCalls, 1, "a rejected grant is not retried");
    assert.match(rec.err.join("\n"), /token exchange failed.*invalid_grant/s);
    assert.ok(!rec.linePrompts.some((p) => /Press Enter/.test(p)));
  });

  it("gives up after a bounded number of network attempts", async () => {
    let capturedState: string | null = null;
    const { deps, rec } = makeDeps({
      interactive: true,
      callback: async () => ({ code: "AUTHCODE", state: capturedState ?? "" }),
      tokenSequence: ["throw", "throw", "throw", "throw", "throw"],
      answers: ["", "", "", "", ""],
    });
    const origWriteOut = deps.writeOut;
    deps.writeOut = (t) => {
      origWriteOut(t);
      if (capturedState === null) capturedState = stateFromAuthorizeUrl([t]);
    };
    assert.equal(await runLoginCommand({ url: ORIGIN_URL }, deps), 7);
    assert.equal(rec.tokenCalls, 3, "MAX_EXCHANGE_ATTEMPTS");
    assert.match(rec.err.join("\n"), /run `jentrix login` again/);
  });
});
