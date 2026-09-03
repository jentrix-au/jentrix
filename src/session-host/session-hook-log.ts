import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The session hook log (MVP separation P5) — split out of `session-host.ts`
// for ONE reason: what the `session-hook` verb does is append a line to a file,
// and it was paying to load the whole session host to do it.
//
// That verb is invoked by a Claude Code lifecycle hook, several times per
// conversation, in front of the operator. Reaching it through `session-host.js`
// meant loading the MCP client, the streamable-HTTP transport, the bridge, the
// redactor, the spool and both transcript mappers first — ~5.8 MB of
// `@modelcontextprotocol/sdk` alone — none of which an append touches.
//
// The WRITER lives here with the reader deliberately: they share the NDJSON
// line shape and `safeParse`'s tolerance of a truncated final line, and a
// writer that drifts from its reader is how a hook log stops being readable.
// `session-host.ts` re-exports all four names, so existing importers are
// unaffected — the split is a module boundary, not an API change.
// ---------------------------------------------------------------------------

/**
 * JEN-305 — what the hook could see when it ran.
 *
 * A lifecycle hook that never fires leaves NOTHING behind: Claude Code keeps
 * no hook log on macOS, retains no stderr, and the session transcript records
 * no failure. So the ledger line carries the environment alongside the
 * payload, and the line itself becomes the reproduction: `path` says whether
 * the bare `jentrix-session-host` on the plugin's command could ever have
 * resolved, and `execPath`/`script` say WHICH copy answered — an
 * install-time absolute path goes stale the moment nvm switches node
 * versions (the JEN-297 class), and a stale one is only diagnosable if it is
 * recorded.
 *
 * Paths, never secrets. PATH is capped because a developer's is routinely
 * several kilobytes and this file is appended to several times per
 * conversation.
 */
const PATH_CAP = 4096;

export interface HookEnv {
  /** PATH as the hook was launched with it, capped. Null when unset. */
  path: string | null;
  /** The node binary that is executing this process. */
  execPath: string;
  /** How argv0 resolved — the name the process was invoked under. */
  argv0: string;
  /** The script node was pointed at, i.e. which copy of the CLI answered. */
  script: string | null;
}

export function hookEnv(
  proc: {
    env: Record<string, string | undefined>;
    execPath: string;
    argv0: string;
    argv: string[];
  } = process,
): HookEnv {
  const path = proc.env.PATH ?? proc.env.Path ?? null;
  return {
    path: path === null ? null : path.slice(0, PATH_CAP),
    execPath: proc.execPath,
    argv0: proc.argv0,
    script: proc.argv[1] ?? null,
  };
}

/** `session-hook` verb: append hook stdin JSON to the session's hook file. */
export function appendHookEvent(
  sessionDir: string,
  eventName: string,
  stdinJson: string,
  env: HookEnv = hookEnv(),
): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ event: eventName, at: new Date().toISOString(), payload: safeParse(stdinJson), env })}\n`;
  appendFileSync(join(sessionDir, "hooks.ndjson"), line, { mode: 0o600 });
}

/**
 * Never throws: a hook payload that is not JSON, or a final line the writer was
 * mid-append on, must not take down either side. The raw text is kept (capped)
 * so the failure is visible in the log rather than silently empty.
 */
export function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 10_000) };
  }
}

export interface HookLine {
  event: string;
  at: string;
  /** JEN-305 — absent on lines written before 0.6.7. */
  env?: HookEnv;
  payload: {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    [key: string]: unknown;
  };
}

export function readHookLines(
  sessionDir: string,
  fromOffset: number,
): {
  lines: HookLine[];
  offset: number;
} {
  const path = join(sessionDir, "hooks.ndjson");
  // The Claude ledger is machine-global and grows past a megabyte (JEN-295);
  // a 2-second poll must not re-read it when nothing was appended. The offset
  // counts UTF-16 code units and the size counts bytes, and UTF-8 never needs
  // fewer bytes than code units, so "size ≤ offset" is a SAFE nothing-new
  // test — it can never skip an appended line.
  let body: string;
  try {
    if (statSync(path).size <= fromOffset) {
      return { lines: [], offset: fromOffset };
    }
    body = readFileSync(path, "utf8");
  } catch {
    return { lines: [], offset: fromOffset };
  }
  const slice = body.slice(fromOffset);
  const lines = slice
    .split("\n")
    .filter(Boolean)
    .map((line) => safeParse(line) as HookLine)
    .filter((line) => typeof line?.event === "string");
  return { lines, offset: fromOffset + slice.length };
}
