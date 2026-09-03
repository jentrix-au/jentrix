/**
 * `jentrix login` — human OAuth 2.1 sign-in without minting a PAT (stage C4.2).
 *
 * Flow (all against the EXISTING P2.7 authorization server — zero AS changes):
 *   1. Discover the AS endpoints for the configured origin (RFC 8414, with a
 *      conventional-path fallback); the CIMD `client_id` is
 *      `<origin>/oauth/stacks-cli.json` (a static file this stage adds).
 *   2. Bind the FIRST free loopback port of 8976/8977/8978 (127.0.0.1 ONLY).
 *      All three busy → print the authorize URL + `--paste` instructions.
 *   3. Generate a fresh PKCE verifier/challenge + a `state` nonce, build the
 *      authorize URL, print it always, and best-effort open the browser.
 *   4. Race the loopback callback against a pasted redirect URL read from
 *      stdin (C1.1) — the listener binding says nothing about whether the
 *      BROWSER can reach it, and a container/remote shell used to strand the
 *      operator here for five minutes. Whichever arrives first wins; `state`
 *      is verified (constant-time) on BOTH, the code (+ verifier) is exchanged
 *      at the token endpoint, and the `tmo_` access + `tmr_` refresh pair is
 *      persisted at 0600.
 *   `jentrix login --paste` still skips the listener entirely: same paste
 *   path, no socket. It is not the recovery for an unreachable callback any
 *   more — the default path recovers itself, without being re-run (C1.5).
 *
 * Token hygiene (C4.1 discipline extended to `tmo_`/`tmr_`): NO token material
 * — verifier, code, access token, refresh token — is ever printed to
 * stdout/stderr or logged. Only a non-secret success line (token TYPE + last 4)
 * is shown, built the same way whoami's `redactToken` is.
 *
 * Every process edge (http listener, browser opener, stdin, clock, fs, output,
 * fetch) is injected via `LoginDeps`, so the flow is unit-testable end-to-end
 * with no real sockets or network. `main.ts` wires the real edges.
 */

import { Command } from "commander";

import {
  ConfigError,
  DEFAULT_MCP_URL,
  projectConfigPathFor,
  readConfigFile,
  saveOAuthSession,
  type ConfigFileReader,
  type ConfigFileWriter,
} from "../config";
import { EXIT_CODES } from "../errors";
import type { CallbackResult, LoopbackListener } from "../loopback";
import { redactToken } from "./whoami";
import { proxyDiagnosis } from "../proxy";
import {
  AuthServerUnreachableError,
  buildAuthorizeUrl,
  clientIdFor,
  discoverAuthServer,
  exchangeCodeForTokens,
  generatePkcePair,
  generateState,
  LOOPBACK_HOST,
  LOOPBACK_PORTS,
  OAuthTokenError,
  originOf,
  redirectUriFor,
  stateMatches,
  DEFAULT_LOGIN_SCOPES,
  type AuthServerEndpoints,
  type OAuthTokenResponse,
} from "../oauth";

/** Commander option bag for `login`. */
export interface LoginFlags {
  /** `--url <url>` — MCP endpoint override (origin is derived from it). */
  url?: string;
  /**
   * `--client-id <https-url>` — override the CIMD client_id. Defaults to
   * `<origin>/oauth/stacks-cli.json`. Useful when the AS runs on plain http
   * locally: point this at the DEPLOYED https metadata URL (the AS requires an
   * https client_id, but it does NOT require it to be same-origin with itself).
   */
  clientId?: string;
  /** `--scope <s...>` — override the requested scopes (default read+write). */
  scope?: string[];
  /** `--paste` — skip the loopback listener; paste the code manually. */
  paste?: boolean;
  /**
   * `--local` — bind THIS folder to a server: credentials are written to
   * `./.stacks/config.json` (created with a self-ignoring .gitignore) instead
   * of the home config, and every `jentrix` command run under this folder uses
   * that file (AGE-952 per-project servers).
   */
  local?: boolean;
}

/**
 * The servers the interactive picker offers when no URL is resolvable from
 * `--url`, `STACKS_MCP_URL`, or the target config file. Temporary until the
 * final Jentrix release consolidates on one public endpoint.
 */
export const KNOWN_SERVERS: readonly { label: string; url: string }[] = [
  { label: "Jentrix MVP", url: "https://stacks-mvp.vercel.app/api/mcp" },
  { label: "Jentrix production", url: DEFAULT_MCP_URL },
];

export interface LoginDeps {
  /** Process env (STACKS_MCP_URL for the origin default). */
  env: Record<string, string | undefined>;
  /** The RESOLVED config-file path (project-local wins) to persist tokens into. */
  configPath: string;
  /** Working directory — the `--local` target folder. */
  cwd(): string;
  /** TTY on both ends — gates the interactive server picker. */
  isInteractive: boolean;
  /** Create `<dir>/.stacks` + its self-ignoring .gitignore (config.ts impl). */
  scaffoldProjectDir(dir: string): void;
  /**
   * Try to bind a loopback listener on ONE of `ports` (in order). Resolves with
   * the listener for the first free port, or `null` when all are busy. The
   * implementation MUST bind 127.0.0.1 only.
   */
  bindLoopback(ports: readonly number[]): Promise<LoopbackListener | null>;
  /** Best-effort browser open (never throws; a failure is fine — URL is printed). */
  openBrowser(url: string): Promise<void>;
  /** Read a line from stdin (for `--paste`). */
  readLine(prompt: string): Promise<string>;
  /**
   * Read a line from stdin CONCURRENTLY with the loopback wait (C1.1).
   * Resolves with the line, `null` when `signal` aborts (the callback won the
   * race) or stdin closes. Never throws, and never leaves a prompt echoing
   * after it resolves — a dangling prompt on the success path is the
   * regression AC1.3 guards.
   */
  readPastedRedirect(
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | null>;
  /** File contents, or null when absent/unreadable (container probe, C1.4). */
  readFileIfPresent(path: string): string | null;
  /** stdout sink. */
  writeOut(text: string): void;
  /** stderr sink. */
  writeErr(text: string): void;
  /** Injectable clock + fetch for tests. */
  now(): number;
  fetchImpl: typeof fetch;
  /** Injectable fs seam for token persistence (prod uses node:fs). */
  io?: { reader?: ConfigFileReader; writer?: ConfigFileWriter };
}

/** Parse the code + state out of a pasted redirect URL, or a bare code. */
export function parsePastedInput(
  raw: string,
): { code: string; state: string | null } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "no code provided" };
  // A full redirect URL: pull code/state/error from the query string.
  if (/^https?:\/\//i.test(trimmed) || trimmed.includes("?")) {
    let url: URL;
    try {
      url = new URL(trimmed, "http://127.0.0.1");
    } catch {
      return { error: "could not parse the pasted URL" };
    }
    const err = url.searchParams.get("error");
    if (err) return { error: `authorization failed: ${err}` };
    const code = url.searchParams.get("code");
    if (!code) return { error: "the pasted URL has no ?code= parameter" };
    return { code, state: url.searchParams.get("state") };
  }
  // Otherwise treat the whole line as the bare code (no state to check).
  return { code: trimmed, state: null };
}

/**
 * The MANDATORY `state` check both arrivals share (C1.3 / SVR C4.2-R1-1).
 *
 * A fresh `state` is sent on every attempt, so a legitimate redirect URL
 * always carries it: an unparseable value, a missing state (a bare code), or a
 * mismatch is a HARD failure — on the concurrent listener path exactly as on
 * `--paste`. Returns the authorization code, or the exit code to return.
 */
function acceptPastedArrival(
  expectedState: string,
  raw: string,
  deps: Pick<LoginDeps, "writeErr">,
): string | number {
  const parsed = parsePastedInput(raw);
  if ("error" in parsed) {
    deps.writeErr(`error: ${parsed.error}`);
    return EXIT_CODES.TRANSPORT;
  }
  if (parsed.state === null) {
    deps.writeErr(
      "error: the pasted value has no state parameter — paste the FULL " +
        "redirect URL (with ?code=…&state=…), not just the code; start over " +
        "with `jentrix login` if needed",
    );
    return EXIT_CODES.TRANSPORT;
  }
  if (!stateMatches(expectedState, parsed.state)) {
    deps.writeErr(
      "error: state mismatch — the pasted URL does not match this login " +
        "attempt (possible CSRF); start over with `jentrix login`",
    );
    return EXIT_CODES.TRANSPORT;
  }
  return parsed.code;
}

/**
 * Is a local browser implausible here (C1.4)? A container, or a remote shell
 * with no display, opens the authorize URL somewhere that cannot reach this
 * machine's loopback listener — so the paste instruction LEADS there instead
 * of trailing a "Waiting for the callback…" line nobody can satisfy.
 *
 * Never a refusal and never a branch: the listener is still bound (it may work
 * — port forwarding, an X display we could not see), and either arrival still
 * completes the login. This only decides which instruction is read first.
 */
export function browserLikelyUnreachable(
  env: Record<string, string | undefined>,
  readFileIfPresent: (path: string) => string | null,
): boolean {
  if (env.SSH_CONNECTION?.trim() && !env.DISPLAY?.trim()) return true;
  if (readFileIfPresent("/.dockerenv") !== null) return true;
  return /docker|kubepods|containerd|lxc|podman/i.test(
    readFileIfPresent("/proc/1/cgroup") ?? "",
  );
}

/**
 * Interactive server picker (AGE-952): numbered choice over KNOWN_SERVERS plus
 * a custom-URL escape hatch. Returns the chosen MCP URL, or null after three
 * unusable answers (the caller exits 2). Only reached on a TTY.
 */
async function pickServer(deps: LoginDeps): Promise<string | null> {
  deps.writeOut("Which Jentrix server do you want to connect to?");
  KNOWN_SERVERS.forEach((server, i) => {
    deps.writeOut(`  ${i + 1}. ${server.label}  ${server.url}`);
  });
  deps.writeOut(`  ${KNOWN_SERVERS.length + 1}. Custom URL`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await deps.readLine("Choose [1]: ")).trim();
    const choice = answer === "" ? 1 : Number.parseInt(answer, 10);
    if (
      Number.isInteger(choice) &&
      choice >= 1 &&
      choice <= KNOWN_SERVERS.length
    ) {
      return KNOWN_SERVERS[choice - 1].url;
    }
    if (choice === KNOWN_SERVERS.length + 1) {
      const custom = (
        await deps.readLine(
          "MCP endpoint URL (e.g. https://stacks.example.com/api/mcp): ",
        )
      ).trim();
      if (custom !== "") return custom; // validated by originOf below
      deps.writeErr("error: no URL entered");
      continue;
    }
    deps.writeErr(
      `error: enter a number between 1 and ${KNOWN_SERVERS.length + 1}`,
    );
  }
  deps.writeErr("error: no server chosen — run `jentrix login --url <url>`");
  return null;
}

/**
 * Run one `jentrix login`. Returns the process exit code; all output goes
 * through the injected sinks. Never throws for expected failures — a bad
 * config/URL is exit 2, a state mismatch or token-endpoint rejection is exit 7.
 */
export async function runLoginCommand(
  flags: LoginFlags,
  deps: LoginDeps,
): Promise<number> {
  // Redaction discipline (C4.1/C4.2): a user could set --url or STACKS_MCP_URL
  // to a token by mistake, and the invalid-URL branch echoes the raw value.
  // Scrub token-SHAPED text (tm_/tmo_/tmr_) plus the known STACKS_TOKEN value
  // from anything we print on the pre-auth error paths.
  const envTokenSecret = deps.env.STACKS_TOKEN;
  const scrub = (text: string): string => {
    let out = text;
    if (envTokenSecret && out.includes(envTokenSecret)) {
      out = out.split(envTokenSecret).join("<redacted token>");
    }
    return out.replace(/\btmo?r?_[A-Za-z0-9._-]{4,}/g, "<redacted token>");
  };

  // ---- where the credentials will be WRITTEN (AGE-952) -------------------
  // `--local` binds the current folder: ./.stacks/config.json (scaffolded with
  // a self-ignoring .gitignore before anything secret lands there). Otherwise
  // the resolved config path (project-local when one exists in the cwd's
  // ancestry, else the home file).
  const localDir = flags.local ? deps.cwd() : null;
  const targetConfigPath = localDir
    ? projectConfigPathFor(localDir)
    : deps.configPath;

  // ---- resolve the origin --------------------------------------------------
  // --url → STACKS_MCP_URL → the target config file's url (re-login to the
  // server this file is already bound to) → interactive server picker (TTY
  // only) → default. login predates any token, so resolveConfig's token path
  // doesn't apply; only the URL matters here.
  let storedUrl: string | undefined;
  try {
    const stored = readConfigFile(targetConfigPath, deps.io?.reader);
    storedUrl =
      stored?.url && stored.url.trim() ? stored.url.trim() : undefined;
  } catch {
    storedUrl = undefined; // malformed file — login will overwrite it anyway
  }
  let rawUrl =
    (flags.url && flags.url.trim()) ||
    (deps.env.STACKS_MCP_URL && deps.env.STACKS_MCP_URL.trim()) ||
    storedUrl ||
    "";
  if (!rawUrl) {
    if (deps.isInteractive) {
      const picked = await pickServer(deps);
      if (picked === null) return EXIT_CODES.INVALID_INPUT;
      rawUrl = picked;
    } else {
      rawUrl = DEFAULT_MCP_URL;
    }
  }
  let origin: string;
  try {
    origin = originOf(rawUrl);
  } catch {
    deps.writeErr(
      scrub(
        `error: invalid MCP URL ${JSON.stringify(rawUrl)} — pass a valid ` +
          "--url or set STACKS_MCP_URL",
      ),
    );
    return EXIT_CODES.INVALID_INPUT;
  }

  // The CIMD client_id defaults to `<origin>/oauth/stacks-cli.json` but can be
  // overridden with --client-id. The P2.7 AS requires an HTTPS client_id (it
  // rejects non-https client_ids before fetching the metadata), but it does NOT
  // require the metadata URL to be same-origin with the AS. So against a plain
  // http local AS, point --client-id at the DEPLOYED https metadata URL and the
  // browser flow still works (authorize/token stay local; client_id is https).
  let clientId: string;
  if (flags.clientId && flags.clientId.trim()) {
    const raw = flags.clientId.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      deps.writeErr(scrub(`error: invalid --client-id ${JSON.stringify(raw)}`));
      return EXIT_CODES.INVALID_INPUT;
    }
    if (parsed.protocol !== "https:") {
      deps.writeErr(
        scrub(
          `error: --client-id must be an https URL (got ${raw}) — the ` +
            "authorization server only accepts an https client_id",
        ),
      );
      return EXIT_CODES.INVALID_INPUT;
    }
    clientId = parsed.toString();
  } else {
    clientId = clientIdFor(origin);
    // Derived from an http origin ⇒ not usable (the AS rejects http client_ids).
    // Fail fast with an actionable message rather than an opaque "Unknown
    // client" page. `origin` is scrubbed (a token fat-fingered into --url could
    // otherwise leak here — SVR C4.2-R3-1).
    if (new URL(clientId).protocol !== "https:") {
      deps.writeErr(
        scrub(
          `error: OAuth login needs an https client_id, but the server origin ` +
            `is not https (got ${origin}). Either point --url / STACKS_MCP_URL ` +
            "at your https deployment (e.g. https://tm.jentrix.ai/api/mcp), pass " +
            "--client-id <https metadata URL> to keep a local http server, or " +
            "use a PAT via STACKS_TOKEN.",
        ),
      );
      return EXIT_CODES.INVALID_INPUT;
    }
  }
  const scopes =
    flags.scope && flags.scope.length > 0
      ? flags.scope
      : [...DEFAULT_LOGIN_SCOPES];

  // ---- discover AS endpoints --------------------------------------------
  // This probe runs BEFORE the browser step, and now its failure is allowed to
  // stop the login (JEN-306). It used to fall back on ANY error, which turned
  // a reachability failure into silence: the CLI printed an authorize URL it
  // could never redeem a code against, the operator's browser — on a different
  // network path — completed the consent happily, and only the CLI's leg died.
  // The wasted browser trip is the expensive part, so it is not taken at all.
  let endpoints: AuthServerEndpoints;
  try {
    endpoints = await discoverAuthServer(origin, deps.fetchImpl);
  } catch (e) {
    if (!(e instanceof AuthServerUnreachableError)) throw e;
    deps.writeErr(
      scrub(
        `error: cannot reach ${origin} — ${e.message}. Nothing was sent to ` +
          "your browser, so no authorization was wasted.",
      ),
    );
    deps.writeErr(proxyDiagnosis(deps.env));
    return EXIT_CODES.TRANSPORT;
  }

  // ---- fresh PKCE + state (per attempt; verifier never reused/printed) ---
  const pkce = generatePkcePair();
  const state = generateState();

  // ---- bind loopback (or fall back to --paste) --------------------------
  let listener: LoopbackListener | null = null;
  if (!flags.paste) {
    listener = await deps.bindLoopback(LOOPBACK_PORTS);
    if (!listener) {
      deps.writeErr(
        `notice: all loopback ports (${LOOPBACK_PORTS.join(", ")}) on ` +
          `${LOOPBACK_HOST} are busy — falling back to manual paste`,
      );
    }
  }

  // Manual/paste path: no listener bound. We still need a redirect_uri the AS
  // has registered — use the first port's URL (the AS only string-matches it;
  // nothing binds it here).
  if (!listener) {
    const redirectUri = redirectUriFor(LOOPBACK_PORTS[0]);
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge: pkce.challenge,
    });
    deps.writeOut("Open this URL in your browser to authorize Jentrix CLI:");
    deps.writeOut("");
    deps.writeOut(`  ${authorizeUrl}`);
    deps.writeOut("");
    deps.writeOut(
      "After approving, your browser will show a page it can't load " +
        `(${LOOPBACK_HOST}:${LOOPBACK_PORTS[0]}). Copy the FULL URL from the ` +
        "address bar (it contains ?code=…&state=…) and paste it here.",
    );
    const pasted = await deps.readLine("Paste the FULL redirect URL: ");
    const accepted = acceptPastedArrival(state, pasted, deps);
    if (typeof accepted === "number") return accepted;
    return finishLogin(
      {
        code: accepted,
        codeVerifier: pkce.verifier,
        redirectUri,
        clientId,
        tokenEndpoint: endpoints.tokenEndpoint,
        origin: rawUrl,
        expectedState: state,
        scopesRequested: scopes,
        configPath: targetConfigPath,
        localDir,
      },
      deps,
    );
  }

  // ---- listener path: the callback and a CONCURRENT paste, racing (C1.1) --
  //
  // The listener binding successfully says nothing about whether the BROWSER
  // can reach it. A container, a remote shell, a VM, a locked-down browser —
  // the callback simply never arrives and the CLI used to sit here for five
  // minutes with no exit but Ctrl-C (JEN-188/JEN-138: the one known point at
  // which a non-developer abandoned setup). So both arrivals are live at once
  // and whichever lands first completes the sign-in. `redirectUri` is the
  // listener's own, on both, so the token exchange is unchanged (C1.2).
  const redirectUri = redirectUriFor(listener.port);
  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: endpoints.authorizationEndpoint,
    clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge: pkce.challenge,
  });
  const pasteFirst = browserLikelyUnreachable(deps.env, deps.readFileIfPresent);
  const pasteHelp =
    `After approving, copy the FULL URL from the browser's address bar (it ` +
    `contains ?code=…&state=…) and paste it here — whichever arrives first, ` +
    `the callback or your paste, completes the sign-in.`;
  const abort = new AbortController();
  try {
    if (pasteFirst) {
      // C1.4 — the paste instruction is read BEFORE the browser is opened.
      deps.writeOut(
        `This looks like a container or a remote shell, so a browser here ` +
          `probably cannot reach ${LOOPBACK_HOST}:${listener.port}. Open this ` +
          `URL in a browser you can use:`,
      );
      deps.writeOut("");
      deps.writeOut(`  ${authorizeUrl}`);
      deps.writeOut("");
      deps.writeOut(
        `${pasteHelp} (The local listener is bound on ` +
          `${LOOPBACK_HOST}:${listener.port} too, in case it can be reached.)`,
      );
    } else {
      deps.writeOut("Opening your browser to authorize Jentrix CLI…");
      deps.writeOut(`If it doesn't open, visit:\n  ${authorizeUrl}`);
      deps.writeOut("");
      deps.writeOut(
        `Waiting for the callback on ${LOOPBACK_HOST}:${listener.port}…`,
      );
      deps.writeOut(
        `If your browser cannot reach that address it will show a page it ` +
          `can't load. ${pasteHelp}`,
      );
    }
    await deps.openBrowser(authorizeUrl);

    // Neither arm may REJECT: the loser stays pending for the rest of the
    // process, and a late rejection there would surface as an unhandled one.
    type Arrival =
      | { kind: "callback"; callback: CallbackResult }
      | { kind: "failed"; detail: string }
      | { kind: "pasted"; raw: string };
    const fromCallback: Promise<Arrival> = listener.waitForCode().then(
      (callback) => ({ kind: "callback", callback }) as Arrival,
      (e) => ({
        kind: "failed",
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    const fromPaste: Promise<Arrival> = (async () => {
      // A stray Enter must not kill a login the browser may still complete,
      // so an empty line re-prompts. Bounded: a stdin that keeps handing back
      // empty lines drops out of the race rather than spinning, leaving the
      // callback to decide — the one thing worse than this hang is a new one.
      for (let empties = 0; empties < 5; empties += 1) {
        const line = await deps.readPastedRedirect(
          "Paste the FULL redirect URL (or wait for the callback): ",
          abort.signal,
        );
        if (line === null) break; // aborted, or stdin closed (non-TTY)
        if (line.trim() !== "") return { kind: "pasted", raw: line };
      }
      return new Promise<Arrival>(() => {}); // nothing to paste — callback decides
    })();

    const arrival = await Promise.race([fromCallback, fromPaste]);
    abort.abort(); // stop the stdin read before anything else is printed
    if (arrival.kind === "failed") {
      deps.writeErr(
        `error: login was cancelled or timed out: ${arrival.detail}`,
      );
      return EXIT_CODES.TRANSPORT;
    }
    let code: string;
    if (arrival.kind === "pasted") {
      // C1.3 — the SAME mandatory state check as `--paste`, same failures.
      const accepted = acceptPastedArrival(state, arrival.raw, deps);
      if (typeof accepted === "number") return accepted;
      code = accepted;
    } else {
      if (!stateMatches(state, arrival.callback.state)) {
        deps.writeErr(
          "error: state mismatch on the OAuth callback (possible CSRF) — " +
            "start over with `jentrix login`",
        );
        return EXIT_CODES.TRANSPORT;
      }
      code = arrival.callback.code;
    }
    return finishLogin(
      {
        code,
        codeVerifier: pkce.verifier,
        redirectUri,
        clientId,
        tokenEndpoint: endpoints.tokenEndpoint,
        origin: rawUrl,
        expectedState: state,
        scopesRequested: scopes,
        configPath: targetConfigPath,
        localDir,
      },
      deps,
    );
  } finally {
    abort.abort();
    await listener.close().catch(() => undefined);
  }
}

interface FinishInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  tokenEndpoint: string;
  origin: string;
  /** This attempt's `state`, so a RE-pasted redirect gets the same check. */
  expectedState: string;
  scopesRequested: string[];
  /** Where the credentials land (project-local under `--local`). */
  configPath: string;
  /** Non-null when `--local`: the folder whose .stacks dir must be scaffolded. */
  localDir: string | null;
}

/**
 * How many times the token exchange may be attempted for ONE browser consent.
 * Only a NETWORK failure consumes an attempt — a grant the server rejected
 * exits on the first try, because retrying it cannot help.
 */
const MAX_EXCHANGE_ATTEMPTS = 3;

/** Exchange the code and persist the pair (shared by both listener + paste). */
async function finishLogin(
  input: FinishInput,
  deps: LoginDeps,
): Promise<number> {
  let pair: OAuthTokenResponse;
  let code = input.code;
  // JEN-306 — an authorization code is single-use, but a request that never
  // REACHED the token endpoint has not used it. Exiting there threw away a
  // browser consent the operator had already completed and made them do the
  // whole dance again, so a transport failure re-prompts instead: fix the
  // proxy, press Enter, and the same still-unexpired code is redeemed. Only
  // `network_error` loops; `invalid_grant` and friends exit as before.
  for (let attempt = 1; ; attempt += 1) {
    try {
      pair = await exchangeCodeForTokens({
        tokenEndpoint: input.tokenEndpoint,
        clientId: input.clientId,
        code,
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        fetchImpl: deps.fetchImpl,
      });
      break;
    } catch (e) {
      // Redaction discipline: an OAuthTokenError message is prose about the
      // grant (never a token), but scrub token-shaped text defensively
      // regardless.
      const raw =
        e instanceof OAuthTokenError
          ? `${e.oauthCode}: ${e.message}`
          : String(e);
      const masked = raw.replace(
        /\btmo?r?_[A-Za-z0-9._-]{4,}/g,
        "<redacted token>",
      );
      const unreached =
        e instanceof OAuthTokenError && e.oauthCode === "network_error";
      if (!unreached) {
        deps.writeErr(`error: token exchange failed (${masked})`);
        return EXIT_CODES.TRANSPORT;
      }
      // Say WHOSE fault it is: the request did not reach the server, so the
      // server did not reject anything.
      deps.writeErr(
        `error: the token exchange never reached ${input.tokenEndpoint} ` +
          `(${masked}) — this is a network problem, not a Jentrix rejection`,
      );
      deps.writeErr(proxyDiagnosis(deps.env));
      if (!deps.isInteractive || attempt >= MAX_EXCHANGE_ATTEMPTS) {
        deps.writeErr(
          "Your browser authorization is unused but short-lived — fix the " +
            "network and run `jentrix login` again.",
        );
        return EXIT_CODES.TRANSPORT;
      }
      deps.writeOut(
        "Your authorization is still unused — you do not need to approve " +
          "again.",
      );
      const answer = await deps.readLine(
        "Press Enter to retry, or paste the FULL redirect URL again: ",
      );
      if (answer.trim() !== "") {
        // A re-paste gets the SAME mandatory state check as the first arrival.
        const accepted = acceptPastedArrival(input.expectedState, answer, deps);
        if (typeof accepted === "number") return accepted;
        code = accepted;
      }
    }
  }

  const expiresAt = new Date(
    deps.now() + pair.expiresInSeconds * 1000,
  ).toISOString();
  try {
    // Scaffold BEFORE the secret lands: the .gitignore must exist by the time
    // the token file does, so the project-local config is never committable.
    if (input.localDir !== null) deps.scaffoldProjectDir(input.localDir);
    saveOAuthSession(
      input.configPath,
      {
        accessToken: pair.accessToken,
        url: input.origin,
        oauth: {
          refreshToken: pair.refreshToken,
          expiresAt,
          clientId: input.clientId,
          tokenEndpoint: input.tokenEndpoint,
          ...(pair.scope ? { scope: pair.scope } : {}),
        },
      },
      deps.io ?? {},
    );
  } catch (e) {
    if (e instanceof ConfigError) {
      deps.writeErr(`error: ${e.message}`);
      return e.exitCode;
    }
    const detail = e instanceof Error ? e.message : String(e);
    deps.writeErr(`error: could not save credentials: ${detail}`);
    return EXIT_CODES.INTERNAL;
  }

  // Success line — token TYPE + last 4 only, NEVER the full value.
  const { display } = redactToken(pair.accessToken);
  const grantedScope = pair.scope || input.scopesRequested.join(" ");
  deps.writeOut("");
  deps.writeOut(
    `Signed in. Stored OAuth token ${display} (scope: ${grantedScope}) in ` +
      `${input.configPath}.`,
  );
  if (input.localDir !== null) {
    deps.writeOut(
      "This folder is now bound to that server — `jentrix` commands run " +
        "here (and in subfolders) use ./.stacks/config.json.",
    );
  }
  deps.writeOut("Run `jentrix whoami` to verify.");
  return EXIT_CODES.OK;
}

/**
 * Mount the `login` command. Flags live on the subcommand (root options don't
 * parse after a subcommand name — same rule as `tool`/`whoami`). The action
 * reports its exit code through `onExit`.
 */
export function registerLoginCommand(
  program: Command,
  deps: LoginDeps,
  onExit: (code: number) => void,
): Command {
  return program
    .command("login")
    .description(
      "Sign in with your Jentrix account via OAuth (browser). Stores a " +
        "rotating token in ~/.config/stacks/config.json — no PAT needed. " +
        "With --local, binds the CURRENT folder to a server via " +
        "./.stacks/config.json instead.",
    )
    .option(
      "--url <url>",
      "MCP endpoint whose origin hosts the auth server (default: STACKS_MCP_URL or production)",
    )
    .option(
      "--client-id <url>",
      "CIMD client_id (https metadata URL; default <origin>/oauth/stacks-cli.json) — set this to a deployed https URL to log in against a local http server",
    )
    .option(
      "--scope <scope...>",
      "requested scopes (default: read write; add admin to manage webhooks/automations)",
    )
    .option(
      "--paste",
      "don't start a local listener; paste the FULL redirect URL (with ?code=…&state=…) manually",
    )
    .option(
      "--local",
      "bind this folder to a server: write credentials to ./.stacks/config.json (gitignored) so different folders can use different Jentrix servers",
    )
    .action(async (options: LoginFlags) => {
      onExit(await runLoginCommand(options, deps));
    });
}

/** Read-only helper for `main.ts` to load the stored oauth record (or undefined). */
export function loadStoredOAuth(configPath: string) {
  try {
    return readConfigFile(configPath)?.oauth;
  } catch {
    return undefined;
  }
}
