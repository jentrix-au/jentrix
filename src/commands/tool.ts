/**
 * `jentrix tool <name>` — the raw-invocation escape hatch for any tool in
 * the bundled PRODUCT manifest (client-runtime v2 D8: the CLI is MVP-only).
 * Names outside the manifest are refused LOCALLY — even against a full
 * platform endpoint — with a message naming the operations paths; this is a
 * deliberate forward-compat regression (C9, named in the release notes).
 * `jentrix tool list` reports the intersection of the live endpoint's
 * catalog and the bundled manifest (D13). The one degraded mode: an install
 * whose manifest is unreadable cannot validate names, so it sends with the
 * old stderr notice rather than bricking the escape hatch.
 *
 * Every process edge (fs, stdin, network, clock, output) is injected via
 * `ToolCommandDeps`, so `runToolCommand` is testable end-to-end with a stub
 * client and no I/O. `main.ts` wires the real edges.
 */

import { Command } from "commander";

import { callTool, type ToolCaller } from "../call";
import { isUnauthorizedError, unauthorizedMessage } from "../client";
import { ConfigError, resolveConfig, type JentrixConfigFile } from "../config";
import { EXIT_CODES } from "../errors";

/** Default RATE_LIMITED policy (design.md Phase 1): 2 retries, 60s cap. */
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_MAX_WAIT_SECONDS = 60;

/**
 * Pull the OAuth relogin remediation off a connect error, if present. A failed
 * OAuth refresh (C4.2) attaches `reloginMessage` so the command layer can print
 * "run jentrix login" instead of the PAT dead-token message. Returns null for
 * any other error.
 */
export function reloginMessageOf(e: unknown): string | null {
  if (
    typeof e === "object" &&
    e !== null &&
    "reloginMessage" in e &&
    typeof (e as { reloginMessage: unknown }).reloginMessage === "string"
  ) {
    return (e as { reloginMessage: string }).reloginMessage;
  }
  return null;
}

/** Commander option bag for the `tool` command (see `registerToolCommand`). */
export interface ToolCommandFlags {
  /** `--args '<json>'` — tool arguments as a JSON object literal. */
  args?: string;
  /** `--args-file <f|->` — read the JSON from a file, or stdin via `-`. */
  argsFile?: string;
  /** `--json` — stable JSON on stdout instead of the human renderer. */
  json?: boolean;
  /** `--url <url>` — MCP endpoint override. */
  url?: string;
  /** `--token <token>` — token override. */
  token?: string;
  /** `--no-wait` flips this to false: never sleep on RATE_LIMITED. */
  wait: boolean;
  /** `--max-wait <s>` — cap on total RATE_LIMITED wait time (seconds). */
  maxWait: string;
}

export interface ToolCommandDeps {
  /** Process env (STACKS_TOKEN / STACKS_MCP_URL). */
  env: Record<string, string | undefined>;
  /** Lazy config-file read; may throw `ConfigError` (malformed file). */
  configFile(): JentrixConfigFile | null;
  /** Tool names from the bundled manifest; null = manifest unreadable. */
  knownTools: ReadonlySet<string> | null;
  /** Connect the production client (client.ts). Throws on transport/401. */
  connect(target: {
    url: string;
    token: string;
    /** Validated session correlation → `X-Stacks-Session-Id` (STA-26). */
    sessionId?: string;
  }): Promise<{ caller: ToolCaller; close(): Promise<void> }>;
  /**
   * STA-59 — the connected session this invocation belongs to, resolved from
   * the checkout's alignment marker exactly as `jentrix push` resolves it.
   * Absent dep (or null) = uncorrelated, which is the honest answer outside a
   * session, NEVER a guessed id. It stays a dep rather than an inline read
   * because this module owns no process edges (see the file header).
   *
   * Without it every `jentrix tool` write — the ordinary agent path, and the
   * whole generated command tree that rides this same seam — reached the
   * server with no `X-Stacks-Session-Id`, so `Task.createdInSessionId` was
   * unreachable from the CLI: 0 of 922 tasks stamped on stacks-mvp. The
   * server side was correct all along; the header simply was never sent.
   */
  sessionId?(): Promise<string | null>;
  /**
   * JEN-467 — WHERE `configFile()` looked, so `whoami` can name the file
   * (folder-local `.stacks/config.json` versus the machine-wide home file)
   * instead of the one label both used to share. Optional for the same reason
   * `sessionId` is: this module owns no process edges, and a bag without them
   * falls back to the bare "config file" wording.
   */
  configPath?(): string;
  cwd?(): string;
  homeDir?(): string;
  readStdin(): Promise<string>;
  /** Read `--args-file` content; throws when unreadable. */
  readFile(path: string): string;
  /** stdout sink — exactly one write per invocation, newline-terminated. */
  writeOut(text: string): void;
  /** stderr sink — notices and errors. */
  writeErr(text: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Parse + validate the tool arguments JSON. Returns an object or an error
 * string. Exported for build.ts (C2.2), which parses the generated commands'
 * `--args` override with identical semantics.
 */
export function parseArgsJson(
  raw: string,
  source: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.trim() === "") {
    return {
      ok: false,
      error: `${source} is empty — pass a JSON object like '{}'`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `${source} is not valid JSON: ${detail}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${source} must be a JSON object (e.g. '{"taskId":"…"}'), got ${
        Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)
      }`,
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Run one `jentrix tool` invocation. Returns the process exit code; all
 * output goes through the injected sinks. Never throws for expected
 * failures — usage problems are exit 2, auth is exit 7, envelope errors map
 * through the frozen table in `errors.ts`.
 */
/**
 * JEN-170 — `--workspace` takes an ID; `jentrix align` takes an id-OR-slug.
 * A slug sent as an id matches no membership row, so authz answers "Not a
 * member of this workspace" — a false claim about the operator's role,
 * measured against a workspace they OWN. Caught here, at the one seam every
 * tool call routes through (the generated tree and `jentrix tool` alike), and
 * named as the input problem it is.
 *
 * NOT fixed server-side on purpose: telling a caller "that workspace exists
 * but you are not in it" is an enumeration surface, and the ids are not
 * guessable — the honest half of the answer belongs on this side.
 *
 * Deliberately loose — anything that could BE a cuid is still sent and the
 * server stays the authority.
 * ponytail: shape check only; a ≥20-char hyphen-free slug still falls through
 * to the server's membership answer. Resolve slugs client-side (align's
 * `resolveWorkspaceFlag`) if that ever bites.
 */
export function workspaceIdShapeError(value: string): string | null {
  if (/^[a-z0-9]{20,}$/.test(value)) return null;
  return (
    `workspaceId "${value}" is not a workspace id (ids look like ` +
    `"cmt2cuhyo000004l38ddsim1y"). Find yours with \`jentrix workspace list\`, ` +
    "set it once as `defaults.workspace` in the config file, or use " +
    "`jentrix align --workspace <id-or-slug>` — align is the command that " +
    "accepts a slug."
  );
}

export async function runToolCommand(
  name: string,
  flags: ToolCommandFlags,
  deps: ToolCommandDeps,
): Promise<number> {
  // ---- usage validation (exit 2, nothing sent) -------------------------
  const maxWaitSeconds = Number(flags.maxWait);
  if (!Number.isFinite(maxWaitSeconds) || maxWaitSeconds < 0) {
    deps.writeErr(
      `error: --max-wait must be a non-negative number of seconds, got ${JSON.stringify(flags.maxWait)}`,
    );
    return EXIT_CODES.INVALID_INPUT;
  }

  if (flags.args !== undefined && flags.argsFile !== undefined) {
    deps.writeErr("error: use either --args or --args-file, not both");
    return EXIT_CODES.INVALID_INPUT;
  }

  // ---- `jentrix tool list` (D13) ----------------------------------------
  // The intersection of the live endpoint's catalog and the bundled product
  // manifest — the authority on what THIS build can actually call against
  // THIS server. Not a tool name; no product tool is called "list".
  if (name === "list") {
    return runToolList(flags, deps);
  }

  let raw = "{}";
  let source = "--args";
  if (flags.args !== undefined) {
    raw = flags.args;
  } else if (flags.argsFile !== undefined) {
    if (flags.argsFile === "-") {
      raw = await deps.readStdin();
      source = "--args-file - (stdin)";
    } else {
      source = `--args-file ${flags.argsFile}`;
      try {
        raw = deps.readFile(flags.argsFile);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        deps.writeErr(`error: cannot read ${source}: ${detail}`);
        return EXIT_CODES.INVALID_INPUT;
      }
    }
  }
  const parsed = parseArgsJson(raw, source);
  if (!parsed.ok) {
    deps.writeErr(`error: ${parsed.error}`);
    return EXIT_CODES.INVALID_INPUT;
  }

  // JEN-170: a non-id workspaceId is a usage problem, not a membership one.
  const workspaceId = parsed.value.workspaceId;
  if (typeof workspaceId === "string") {
    const shapeError = workspaceIdShapeError(workspaceId);
    if (shapeError) {
      deps.writeErr(`error: ${shapeError}`);
      return EXIT_CODES.INVALID_INPUT;
    }
  }

  // ---- product-manifest refusal (D8) ------------------------------------
  // Names outside the bundled product manifest are refused locally. The
  // manifest-unreadable install (knownTools null) degrades to the pre-v2
  // notice-and-send so a broken install still has its escape hatch.
  if (deps.knownTools && !deps.knownTools.has(name)) {
    deps.writeErr(
      `error: TOOL_NOT_IN_PRODUCT_MANIFEST: "${name}" is not in this CLI's bundled product manifest (${deps.knownTools.size} tools). The CLI is product-only (client-runtime v2 D8); operations tools are served by the platform deployment's own MCP mount — connect an MCP client to it directly, or use \`jentrix-runner\` for worker operations. \`jentrix tool list\` shows what this build can call.`,
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  if (!deps.knownTools) {
    deps.writeErr(
      `notice: this install's product manifest is unreadable — sending "${name}" unvalidated (the server decides)`,
    );
  }

  // ---- config (missing token → 7; malformed file / bad URL → 2) --------
  let config;
  try {
    config = resolveConfig({
      flagToken: flags.token,
      flagUrl: flags.url,
      env: deps.env,
      file: deps.configFile(),
    });
  } catch (e) {
    if (e instanceof ConfigError) {
      deps.writeErr(`error: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
  // Defense in depth: no expected error path ever includes the token, but
  // anything we print from here on is scrubbed anyway.
  const redact = (text: string) =>
    text.includes(config.token)
      ? text.split(config.token).join("<redacted token>")
      : text;

  // ---- connect (dead token fails here → exit 7) -------------------------
  // Correlation is best-effort by construction: a marker read that throws
  // (no repo, unreadable marker file) must never cost the operator their
  // call — it degrades to an uncorrelated write, the same as running
  // outside a session.
  const sessionId = await deps.sessionId?.().catch(() => null);
  let handle: { caller: ToolCaller; close(): Promise<void> };
  try {
    handle = await deps.connect({
      url: config.url,
      token: config.token,
      ...(sessionId ? { sessionId } : {}),
    });
  } catch (e) {
    // A failed OAuth refresh carries its own remediation ("run jentrix login");
    // prefer it over the generic mint-a-PAT dead-token message (C4.2).
    const relogin = reloginMessageOf(e);
    if (relogin) {
      deps.writeErr(`error: ${relogin}`);
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

  // ---- the call ----------------------------------------------------------
  try {
    const outcome = await callTool(handle.caller, name, parsed.value, {
      json: flags.json === true,
      retry: {
        maxRetries: flags.wait ? DEFAULT_MAX_RETRIES : 0,
        maxWaitSeconds,
        sleep: deps.sleep,
        now: deps.now,
      },
    });
    if (outcome.stderr !== undefined) deps.writeErr(redact(outcome.stderr));
    if (outcome.stdout !== undefined) deps.writeOut(outcome.stdout);
    return outcome.exitCode;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * `jentrix tool list` — the callable-surface report (client-runtime v2 D13):
 * every bundled product-manifest tool, marked by whether the live endpoint
 * serves it. Uses the same connect path as a call; the caller handed back by
 * `deps.connect` is the real MCP client, whose `listTools` is reached through
 * a guarded structural check so injected test stubs without it fail soft.
 */
async function runToolList(
  flags: ToolCommandFlags,
  deps: ToolCommandDeps,
): Promise<number> {
  if (!deps.knownTools) {
    deps.writeErr(
      "error: this install's product manifest is unreadable — reinstall @jentrix/cli, then retry",
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  let config;
  try {
    config = resolveConfig({
      flagToken: flags.token,
      flagUrl: flags.url,
      env: deps.env,
      file: deps.configFile(),
    });
  } catch (e) {
    if (e instanceof ConfigError) {
      deps.writeErr(`error: ${e.message}`);
      return e.exitCode;
    }
    throw e;
  }
  let handle: { caller: ToolCaller; close(): Promise<void> };
  try {
    handle = await deps.connect({ url: config.url, token: config.token });
  } catch (e) {
    const relogin = reloginMessageOf(e);
    if (relogin) {
      deps.writeErr(`error: ${relogin}`);
    } else if (isUnauthorizedError(e)) {
      deps.writeErr(
        `error: ${unauthorizedMessage(deps.configFile(), config.url)}`,
      );
    } else {
      const detail = e instanceof Error ? e.message : String(e);
      deps.writeErr(`error: cannot reach ${config.url}: ${detail}`);
    }
    return EXIT_CODES.TRANSPORT;
  }
  try {
    const lister = handle.caller as {
      listTools?: () => Promise<{ tools: Array<{ name: string }> }>;
    };
    if (typeof lister.listTools !== "function") {
      deps.writeErr("error: this connection cannot list tools");
      return EXIT_CODES.TRANSPORT;
    }
    const served = new Set(
      (await lister.listTools()).tools.map((tool) => tool.name),
    );
    const manifest = [...deps.knownTools].sort();
    const callable = manifest.filter((tool) => served.has(tool));
    if (flags.json === true) {
      deps.writeOut(
        JSON.stringify({
          callable,
          manifestOnly: manifest.filter((tool) => !served.has(tool)),
          manifestCount: manifest.length,
          serverCount: served.size,
        }),
      );
    } else {
      for (const tool of manifest) {
        deps.writeOut(served.has(tool) ? tool : `${tool}  (not on this server)`);
      }
      deps.writeOut(
        `${callable.length} of ${manifest.length} manifest tools are served by ${config.url}`,
      );
    }
    return EXIT_CODES.OK;
  } finally {
    await handle.close();
  }
}

/**
 * Mount the `tool` command on a commander program. Flags live on the
 * subcommand (not the root) so `jentrix tool list_workspaces --json` parses.
 * The action reports its exit code through `onExit` — the process edge maps
 * it to `process.exitCode`; tests capture it.
 */
export function registerToolCommand(
  program: Command,
  deps: ToolCommandDeps,
  onExit: (code: number) => void,
): Command {
  return program
    .command("tool")
    .description(
      "Call a product-manifest MCP tool by name (client-runtime v2 D8: " +
        "names outside the bundled product manifest are refused locally)",
    )
    .argument(
      "<name>",
      'tool name from the bundled product manifest (e.g. list_workspaces), or "list" to report the callable intersection with the live endpoint',
    )
    .option("--args <json>", "tool arguments as a JSON object")
    .option(
      "--args-file <file>",
      'read the arguments JSON from a file, or "-" for stdin',
    )
    .option("--json", "print stable JSON on stdout (machine mode)")
    .option(
      "--url <url>",
      "MCP endpoint (default: STACKS_MCP_URL, config file, or production)",
    )
    .option(
      "--token <token>",
      "API token (default: STACKS_TOKEN or config file)",
    )
    .option("--no-wait", "fail RATE_LIMITED calls immediately (never sleep)")
    .option(
      "--max-wait <seconds>",
      "cap total RATE_LIMITED wait time",
      String(DEFAULT_MAX_WAIT_SECONDS),
    )
    .action(async (name: string, options: ToolCommandFlags) => {
      onExit(await runToolCommand(name, options, deps));
    });
}
