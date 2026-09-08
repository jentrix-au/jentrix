/**
 * `jentrix whoami` — orientation: the first command an agent runs. It prints
 * ONLY what the token can actually PROVE (design.md Phase 4 — "prove, don't
 * claim"):
 *
 *   - the resolved local config: server URL + its source, and the token's
 *     TYPE + last 4 chars + its source — NEVER the full token;
 *   - the `list_workspaces` result (id / name / slug / role each) — the one
 *     piece of server-verified identity the tool surface has always exposed;
 *   - the `get_token_context` result (M19.1 R8): the token's effective scopes
 *     (and whether they are grandfathered), its workspace pinning, its
 *     displayName/emoji identity, and its rate-limit window — so an agent fails
 *     fast on scope instead of probing with FORBIDDEN calls. It carries NO
 *     bearer material. The call is best-effort: an older server (or a token that
 *     somehow cannot read it) falls back to the honest limitation note.
 *
 * Every process edge is injected via `ToolCommandDeps` (the same bag the
 * `tool` command uses), so this is testable end-to-end with a stub client and
 * no I/O. `main.ts` wires the real edges.
 *
 * Token hygiene: the full token value NEVER reaches stdout or stderr, in
 * either output mode or on any error path. `resolveConfig` already keeps the
 * token out of its errors; `redact()` here is defense in depth for the call
 * path (a failed `list_workspaces` must not surface the Authorization header).
 */

import { posix, win32 } from "node:path";

import { Command } from "commander";

import { callTool, type ToolCaller } from "../call";
import { unauthorizedMessage } from "../client";
import { isUnauthorizedError } from "../errors";
import {
  ConfigError,
  resolveConfig,
  TOKEN_ENV,
  type ResolvedConfig,
} from "../config";
import { EXIT_CODES } from "../errors";
import { stableStringify } from "../render";
import { reloginMessageOf, type ToolCommandDeps } from "./tool";

/** Commander option bag for `whoami` — the auth/endpoint/output overrides. */
export interface WhoamiFlags {
  /** `--json` — emit the structured object instead of the human report. */
  json?: boolean;
  /** `--url <url>` — MCP endpoint override. */
  url?: string;
  /** `--token <token>` — token override. */
  token?: string;
}

/** One workspace row as returned by `list_workspaces` (P2.2 output schema). */
interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/** The `get_token_context` result (M19.1 R8 output schema). No bearer material. */
export interface TokenContextReport {
  scopes: string[];
  grandfathered: boolean;
  workspacePinned: boolean;
  workspaceId: string | null;
  /** The caller's own user id (D5, STA-168) — null from a server predating it. */
  userId: string | null;
  displayName: string | null;
  emoji: string | null;
  rateLimit: {
    limitPerMinute: number;
    used: number;
    remaining: number;
    resetInSeconds: number;
  };
}

/** The `--json` payload — a stable, structured mirror of the human report. */
export interface WhoamiReport {
  url: string;
  urlSource: ResolvedConfig["urlSource"];
  /** Token TYPE by prefix: "pat" (tm_) | "oauth" (tmo_) | "unknown". */
  tokenType: "pat" | "oauth" | "unknown";
  /** Redacted display, e.g. "tm_…a1b2" — NEVER the full token. */
  tokenDisplay: string;
  tokenSource: ResolvedConfig["tokenSource"];
  /**
   * WHICH config file this invocation resolved (JEN-467): the folder-local
   * `.stacks/config.json` found walking up from cwd, or the machine-wide home
   * file. Null only when the caller did not say where it looked.
   */
  configPath: string | null;
  configScope: "folder" | "machine" | null;
  workspaces: WorkspaceRow[];
  /** The token's introspected context (M19.1 R8), or null if unavailable. */
  tokenContext: TokenContextReport | null;
  /** The honest scope caveat — shown only when tokenContext is null. */
  note: string;
}

/** The verbatim honest-limitation line (stage file acceptance criterion). */
export const WHOAMI_SCOPE_NOTE =
  "scope/workspace restrictions are enforced server-side and not " +
  "introspectable; a FORBIDDEN (exit 3) on a write means the token lacks " +
  "write/admin scope.";

/**
 * Redact a token to a display string that proves the type + a few identifying
 * characters WITHOUT revealing anything usable. `tm_secretlong` → `tm_…tlong`.
 *
 * The last-4 hint is only shown when the token is long enough that four
 * trailing characters cannot BE the whole secret: a real `tm_`/`tmo_` PAT is
 * always long, but a degenerate short/garbage value must never be echoed in
 * full (otherwise `redactToken("abc")` would "redact" to `…abc`), so anything
 * ≤ 8 chars collapses to a bare `…` with no suffix at all.
 */
export function redactToken(token: string): {
  type: WhoamiReport["tokenType"];
  display: string;
} {
  // Reveal the last 4 only when doing so leaves a comfortable margin of
  // hidden characters; below that, show nothing identifying.
  const hint = token.length > 8 ? `…${token.slice(-4)}` : "…";
  if (token.startsWith("tmo_"))
    return { type: "oauth", display: `tmo_${hint}` };
  if (token.startsWith("tm_")) return { type: "pat", display: `tm_${hint}` };
  return { type: "unknown", display: hint };
}

function isWorkspaceRow(value: unknown): value is WorkspaceRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.slug === "string" &&
    typeof row.role === "string"
  );
}

/**
 * Pull the workspaces array out of a `list_workspaces` success result. The
 * P2.2 contract guarantees `structuredContent: { workspaces: [...] }`; we
 * validate defensively and drop anything malformed rather than crash.
 */
function workspacesFromResult(result: unknown): WorkspaceRow[] {
  if (typeof result !== "object" || result === null) return [];
  const structured = (result as Record<string, unknown>).structuredContent;
  if (typeof structured !== "object" || structured === null) return [];
  const list = (structured as Record<string, unknown>).workspaces;
  if (!Array.isArray(list)) return [];
  return list.filter(isWorkspaceRow);
}

/**
 * WHICH config file, for the report (JEN-467): the same label read as "config
 * file" for the folder-local `.stacks/config.json` and for the home file,
 * and the operator could only tell them apart by running the command from
 * another directory. Folder-local is shown relative to cwd when it lives
 * under it (a walk-up hit above cwd shows its full path); the machine file
 * is `~/…` on POSIX and the real path on win32, where `~` is not a shell
 * notion. Never the file's contents. Exported for tests; `win` is only
 * overridden there.
 */
export function describeConfigFile(
  configPath: string,
  cwd: string,
  homedir: string,
  win = process.platform === "win32",
): { configScope: "folder" | "machine"; label: string } {
  const P = win ? win32 : posix;
  if (configPath === P.join(homedir, ".config", "stacks", "config.json")) {
    const shown = win
      ? configPath
      : `~${P.sep}${P.relative(homedir, configPath)}`;
    return { configScope: "machine", label: `machine config ${shown}` };
  }
  const rel = P.relative(cwd, configPath);
  const under = rel !== "" && !rel.startsWith("..") && !P.isAbsolute(rel);
  return {
    configScope: "folder",
    label: `folder config ${under ? `.${P.sep}${rel}` : configPath}`,
  };
}

/** Human-readable source label for the config report. */
function sourceLabel(
  source: ResolvedConfig["urlSource"],
  fileLabel: string,
): string {
  switch (source) {
    case "flag":
      return "--url / --token flag";
    case "env":
      return "environment";
    case "file":
      return fileLabel;
    case "default":
      return "default";
  }
}

function renderHuman(report: WhoamiReport, fileLabel: string): string {
  const lines: string[] = [];
  lines.push("Config:");
  lines.push(
    `  server:  ${report.url}  (${sourceLabel(report.urlSource, fileLabel)})`,
  );
  lines.push(
    `  token:   ${report.tokenDisplay}  (${sourceLabel(report.tokenSource, fileLabel)})`,
  );
  lines.push("");
  if (report.workspaces.length === 0) {
    lines.push("Workspaces: (none visible to this token)");
  } else {
    lines.push("Workspaces:");
    const nameWidth = Math.max(
      ...report.workspaces.map((w) => w.name.length),
      "NAME".length,
    );
    const slugWidth = Math.max(
      ...report.workspaces.map((w) => w.slug.length),
      "SLUG".length,
    );
    for (const w of report.workspaces) {
      lines.push(
        `  ${w.name.padEnd(nameWidth)}  ${w.slug.padEnd(slugWidth)}  ${w.role}`,
      );
    }
  }
  lines.push("");
  const tc = report.tokenContext;
  if (tc) {
    lines.push("Token:");
    const scopes = tc.scopes.length > 0 ? tc.scopes.join(", ") : "(none)";
    lines.push(
      `  scopes:    ${scopes}${tc.grandfathered ? "  (grandfathered — rotate to pin explicit scopes)" : ""}`,
    );
    lines.push(
      `  workspace: ${tc.workspacePinned ? `pinned to ${tc.workspaceId ?? "?"}` : "not pinned (all your workspaces)"}`,
    );
    if (tc.userId) lines.push(`  user:      ${tc.userId}`);
    if (tc.displayName) {
      lines.push(
        `  identity:  ${tc.emoji ? `${tc.emoji} ` : ""}${tc.displayName}`,
      );
    }
    lines.push(
      `  rate:      ${tc.rateLimit.remaining}/${tc.rateLimit.limitPerMinute} left this minute (resets in ${tc.rateLimit.resetInSeconds}s)`,
    );
  } else {
    lines.push(`Note: ${report.note}`);
  }
  return lines.join("\n");
}

/**
 * Run one `jentrix whoami` invocation. Returns the process exit code; all
 * output goes through the injected sinks. Never throws for expected failures:
 * a missing token is exit 7, a malformed config file / bad URL is exit 2, a
 * dead token surfaces as exit 7 with `DEAD_TOKEN_MESSAGE`, and a
 * `list_workspaces` error maps through the frozen exit table in `errors.ts`.
 */
export async function runWhoamiCommand(
  flags: WhoamiFlags,
  deps: ToolCommandDeps,
): Promise<number> {
  // Scrub every text sink of ANY candidate token value — a redactor that
  // works even BEFORE config resolves (the invalid-URL ConfigError echoes the
  // raw --url, which a caller could set to their token). We don't know which
  // candidate "won" and multiple may be set at once, so ALWAYS mask ALL of
  // them: --token, STACKS_TOKEN, and (once read) the config file's token.
  // `secrets` grows as sources become known; `scrub` masks whatever it holds.
  const secrets = new Set<string>();
  const addSecret = (s: string | undefined) => {
    if (typeof s === "string" && s.length > 0) secrets.add(s);
  };
  addSecret(flags.token);
  addSecret(deps.env[TOKEN_ENV]);
  const scrub = (text: string) => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret))
        out = out.split(secret).join("<redacted token>");
    }
    return out;
  };
  // `redact` is `scrub` — a single scrubber for every path. (Named separately
  // only because the call/connect/success sites read as "redact this output".)
  const redact = scrub;

  // ---- config (missing token → 7; malformed file / bad URL → 2) --------
  // Read the file INSIDE the try: a malformed config file throws ConfigError,
  // which must still surface through the scrubbed branch (not escape to
  // main.ts's un-scrubbed catch) — its message can contain the file's token.
  let config: ResolvedConfig;
  try {
    const file = deps.configFile();
    addSecret(file?.token);
    config = resolveConfig({
      flagToken: flags.token,
      flagUrl: flags.url,
      env: deps.env,
      file,
    });
  } catch (e) {
    if (e instanceof ConfigError) {
      // A config-FILE parse error can echo a token-shaped value straight from
      // the file before it was ever parsed into a known secret, so `scrub`
      // (which only knows collected `secrets`) is not enough here. Additionally
      // mask anything token-SHAPED (`tm_…`/`tmo_…`). This is safe for a real
      // ConfigError message (prose about a file/URL) — it never contains the
      // deliberate `tm_…last4` display, which is only built AFTER config
      // resolves and lives on the success path.
      const masked = scrub(`error: ${e.message}`).replace(
        /\btmo?_[A-Za-z0-9._-]{4,}/g,
        "<redacted token>",
      );
      deps.writeErr(masked);
      return e.exitCode;
    }
    throw e;
  }
  // The winning token is now known; make sure it is masked too (it always is,
  // since it came from one of the sources above, but be explicit).
  addSecret(config.token);

  const { type: tokenType, display: tokenDisplay } = redactToken(config.token);

  // ---- connect (dead token fails here → exit 7) -------------------------
  let handle: { caller: ToolCaller; close(): Promise<void> };
  try {
    handle = await deps.connect({ url: config.url, token: config.token });
  } catch (e) {
    // A failed OAuth refresh carries its own remediation ("run jentrix login");
    // prefer it over the generic mint-a-PAT dead-token message (C4.2).
    const relogin = reloginMessageOf(e);
    if (relogin) {
      deps.writeErr(redact(`error: ${relogin}`));
    } else if (isUnauthorizedError(e)) {
      // AGE-978: a token minted for another deployment is not a dead token.
      deps.writeErr(
        `error: ${unauthorizedMessage(deps.configFile(), config.url)}`,
      );
    } else {
      const detail = e instanceof Error ? e.message : String(e);
      deps.writeErr(redact(`error: cannot reach ${config.url}: ${detail}`));
    }
    return EXIT_CODES.TRANSPORT;
  }

  // ---- list_workspaces (the one server-verified identity we can prove) --
  // No retry sleeps here: whoami is an interactive orientation command, so a
  // RATE_LIMITED simply surfaces (exit 6) rather than stalling.
  try {
    const outcome = await callTool(
      handle.caller,
      "list_workspaces",
      {},
      {
        json: true,
        retry: {
          maxRetries: 0,
          maxWaitSeconds: 0,
          sleep: deps.sleep,
          now: deps.now,
        },
      },
    );
    if (outcome.exitCode !== EXIT_CODES.OK) {
      // list_workspaces failed (FORBIDDEN if the token lacks `read`, a dead
      // token that slipped past connect, etc.). Surface its stderr verbatim —
      // already redaction-safe, and scrubbed again for belt and braces.
      if (outcome.stderr !== undefined) deps.writeErr(redact(outcome.stderr));
      // A CONFLICT-style envelope would put `error.current` on stdout; scrub
      // it too, so NO error path can surface the token (SVR focus: error
      // paths too).
      if (outcome.stdout !== undefined) deps.writeOut(redact(outcome.stdout));
      return outcome.exitCode;
    }

    // callTool hands back only the rendered string (stable JSON of
    // structuredContent, since we asked for json mode). Parse it back into
    // typed rows rather than issuing a second identical call.
    const workspaces = outcome.stdout ? parseWorkspaces(outcome.stdout) : [];

    // get_token_context (M19.1 R8) — BEST-EFFORT: an older server won't have the
    // tool and a degraded token might refuse it, but whoami must still print the
    // config + workspaces it already proved. A failure falls back to the note.
    let tokenContext: TokenContextReport | null = null;
    const ctx = await callTool(
      handle.caller,
      "get_token_context",
      {},
      {
        json: true,
        retry: {
          maxRetries: 0,
          maxWaitSeconds: 0,
          sleep: deps.sleep,
          now: deps.now,
        },
      },
    );
    if (ctx.exitCode === EXIT_CODES.OK && ctx.stdout) {
      tokenContext = parseTokenContext(ctx.stdout);
    }

    // Which file the "file" source means — only when the wiring says where
    // it looked (main.ts does; a bare test bag may not).
    const configPath = deps.configPath?.() ?? null;
    const where =
      configPath !== null && deps.cwd && deps.homeDir
        ? describeConfigFile(configPath, deps.cwd(), deps.homeDir())
        : null;
    const report: WhoamiReport = {
      url: config.url,
      urlSource: config.urlSource,
      tokenType,
      tokenDisplay,
      tokenSource: config.tokenSource,
      configPath: where ? configPath : null,
      configScope: where?.configScope ?? null,
      workspaces,
      tokenContext,
      note: WHOAMI_SCOPE_NOTE,
    };
    // Scrub the success output too: `list_workspaces` is server data we don't
    // control, so on the vanishingly rare chance a workspace field equals the
    // token, the "token never on stdout" guarantee must still hold (SVR
    // C4.1-R1-1) — in BOTH --json and human modes.
    deps.writeOut(
      redact(
        flags.json === true
          ? stableStringify(report)
          : renderHuman(report, where?.label ?? "config file"),
      ),
    );
    return EXIT_CODES.OK;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Parse the rendered `list_workspaces` JSON back into typed rows. */
function parseWorkspaces(rendered: string): WorkspaceRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return [];
  }
  return workspacesFromResult({ structuredContent: parsed });
}

/**
 * Structural guard for a `get_token_context` payload. Validated defensively so
 * a non-context result (e.g. an older server that echoes something else, or the
 * `list_workspaces` shape a degraded call returns) drops to the honest note
 * rather than rendering garbage — same discipline as `isWorkspaceRow`.
 */
function isTokenContextPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const rl = v.rateLimit;
  if (typeof rl !== "object" || rl === null) return false;
  const r = rl as Record<string, unknown>;
  return (
    Array.isArray(v.scopes) &&
    v.scopes.every((s) => typeof s === "string") &&
    typeof v.grandfathered === "boolean" &&
    typeof v.workspacePinned === "boolean" &&
    (v.workspaceId === null || typeof v.workspaceId === "string") &&
    (v.displayName === null || typeof v.displayName === "string") &&
    (v.emoji === null || typeof v.emoji === "string") &&
    typeof r.limitPerMinute === "number" &&
    typeof r.used === "number" &&
    typeof r.remaining === "number" &&
    typeof r.resetInSeconds === "number"
  );
}

/**
 * Parse the rendered `get_token_context` JSON (the tool's structuredContent, as
 * `callTool` renders it in json mode) back into the typed report. Returns null
 * for anything that is not a well-formed context payload so the caller falls
 * back to the honest scope note — introspection is best-effort.
 */
function parseTokenContext(rendered: string): TokenContextReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return null;
  }
  if (!isTokenContextPayload(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  const r = v.rateLimit as Record<string, number>;
  return {
    scopes: v.scopes as string[],
    grandfathered: v.grandfathered as boolean,
    workspacePinned: v.workspacePinned as boolean,
    workspaceId: (v.workspaceId as string | null) ?? null,
    userId: typeof v.userId === "string" ? v.userId : null,
    displayName: (v.displayName as string | null) ?? null,
    emoji: (v.emoji as string | null) ?? null,
    rateLimit: {
      limitPerMinute: r.limitPerMinute,
      used: r.used,
      remaining: r.remaining,
      resetInSeconds: r.resetInSeconds,
    },
  };
}

/**
 * Mount the `whoami` command on a commander program. Flags live on the
 * subcommand (root options don't parse after a subcommand name — same rule
 * as `tool`, C1.2). The action reports its exit code through `onExit`.
 */
export function registerWhoamiCommand(
  program: Command,
  deps: ToolCommandDeps,
  onExit: (code: number) => void,
): Command {
  return program
    .command("whoami")
    .description(
      "Show the resolved config (server + redacted token) and the workspaces " +
        "this token can see. Proves auth without claiming scopes.",
    )
    .option("--json", "print the report as a stable JSON object")
    .option(
      "--url <url>",
      "MCP endpoint (default: STACKS_MCP_URL, config file, or production)",
    )
    .option(
      "--token <token>",
      "API token (default: STACKS_TOKEN or config file)",
    )
    .action(async (options: WhoamiFlags) => {
      onExit(await runWhoamiCommand(options, deps));
    });
}
