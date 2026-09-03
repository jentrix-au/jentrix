/**
 * Config resolution: token + MCP URL from flags, env, and the user config
 * file, in that exact precedence order (plan stage C1.2):
 *
 *   token: `--token` flag → `STACKS_TOKEN` env → config file `token`
 *   url:   `--url` flag   → `STACKS_MCP_URL` env → config file `url` → default
 *
 * Env names are shared with `agents/lib/jentrix.ts` — NEVER introduce parallel
 * names (plan README §4.6). The resolver is a pure function over plain data;
 * the config-file reader is a thin, injectable fs edge. This module is
 * OUTSIDE the dependency firewall (core modules must never import it), but it
 * still keeps to `node:` builtins only.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Default endpoint: the production deployment (CLAUDE.md § Deployment). */
export const DEFAULT_MCP_URL = "https://tm.jentrix.ai/api/mcp";

/** Env var names — shared with agents/lib/jentrix.ts. Never add new ones. */
export const TOKEN_ENV = "STACKS_TOKEN";
export const URL_ENV = "STACKS_MCP_URL";

/**
 * OAuth token record written by `jentrix login` (C4.2). The `tmo_` ACCESS token
 * lives in the top-level `token` field (so the existing resolver + whoami pick
 * it up unchanged); this record holds the rotation material + the endpoints a
 * transparent refresh needs. `expiresAt` is an ISO-8601 instant.
 *
 * Token hygiene: `refreshToken` (`tmr_`) is a secret — it is masked wherever
 * the CLI prints, exactly like the access token.
 */
export interface JentrixOAuthRecord {
  /** Rotating refresh token (`tmr_…`) — single-use, secret. */
  refreshToken: string;
  /** ISO-8601 instant the current access token expires. */
  expiresAt: string;
  /** The CIMD client_id URL the grant was issued to. */
  clientId: string;
  /** The AS token endpoint to rotate against. */
  tokenEndpoint: string;
  /** Space-separated granted scopes (informational). */
  scope?: string;
}

/** Shape of ~/.config/stacks/config.json. Unknown keys are ignored. */
export interface JentrixConfigFile {
  token?: string;
  url?: string;
  /** Reserved for C2.2 (`--workspace`/`--board` defaults). Opaque here. */
  defaults?: Record<string, unknown>;
  /** OAuth rotation material written by `jentrix login` (C4.2). */
  oauth?: JentrixOAuthRecord;
  /**
   * M20.1 §10.3 — stable NON-SECRET CLI installation UUID, minted on first
   * connected-session use. The server derives the opaque `local:` provider-
   * connection key from operator + this value; it is never a credential.
   */
  installationId?: string;
}

/**
 * A configuration problem the process edge reports as `message` + exit code —
 * never a stack trace. Exit codes come from the frozen table: missing/dead
 * token is 7 (auth), everything else (malformed file, bad URL) is 2 (usage).
 */
export class ConfigError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "ConfigError";
    this.exitCode = exitCode;
  }
}

export type TokenSource = "flag" | "env" | "file";
export type UrlSource = TokenSource | "default";

export interface ResolvedConfig {
  token: string;
  url: string;
  /** Pass-through of the config file's `defaults` (empty when absent). */
  defaults: Record<string, unknown>;
  /** Where each value came from — for `jentrix whoami` (C4.1) and tests. */
  tokenSource: TokenSource;
  urlSource: UrlSource;
}

export interface ConfigInputs {
  /** `--token` flag value, if given. */
  flagToken?: string;
  /** `--url` flag value, if given. */
  flagUrl?: string;
  /** Process env (only STACKS_TOKEN / STACKS_MCP_URL are read). */
  env: Record<string, string | undefined>;
  /** Parsed config file, or null when there is none. */
  file: JentrixConfigFile | null;
}

/** `~/.config/stacks/config.json` for a given home directory. */
export function configPathFor(homedir: string): string {
  return join(homedir, ".config", "stacks", "config.json");
}

/**
 * Project-local config (AGE-952): `<folder>/.stacks/config.json`, discovered
 * by walking up from the working directory. When one exists it IS the config
 * file — the home file is not merged in — so different folders can bind to
 * different Jentrix servers with their own tokens. Created by
 * `jentrix login --local`.
 */
export const PROJECT_CONFIG_DIR = ".stacks";

export function projectConfigPathFor(dir: string): string {
  return join(dir, PROJECT_CONFIG_DIR, "config.json");
}

/** Walk up from `startDir` to the fs root; first `.stacks/config.json` wins. */
export function findProjectConfigPath(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = projectConfigPathFor(dir);
    if (exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The config file for this invocation: project-local wins over the home file. */
export function resolveConfigPath(
  cwd: string,
  homedir: string,
  exists: (path: string) => boolean = existsSync,
): string {
  return findProjectConfigPath(cwd, exists) ?? configPathFor(homedir);
}

/**
 * Create `<dir>/.stacks` with a self-ignoring `.gitignore` (`*`) BEFORE the
 * config file is written there — the file holds bearer tokens, so a
 * project-local config must be unrepresentable in a commit, not merely
 * documented as ignorable. Idempotent; an existing `.gitignore` is left alone.
 */
export function scaffoldProjectConfigDir(dir: string): void {
  const stacksDir = join(dir, PROJECT_CONFIG_DIR);
  mkdirSync(stacksDir, { recursive: true });
  try {
    writeFileSync(join(stacksDir, ".gitignore"), "*\n", { flag: "wx" });
  } catch (e) {
    if (!(isRecord(e) && e.code === "EEXIST")) throw e;
  }
}

/** Empty/whitespace strings are treated as unset at every level. */
function present(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * PURE resolver: flags/env/file in, `{ token, url }` out. Throws
 * `ConfigError` (exit 7, actionable message) when no token is configured
 * anywhere, and `ConfigError` (exit 2) when the resolved URL is not a valid
 * URL. Never places token VALUES in any error message.
 */
export function resolveConfig(inputs: ConfigInputs): ResolvedConfig {
  const { env, file } = inputs;

  let token: string | undefined;
  let tokenSource: TokenSource = "flag";
  const flagToken = present(inputs.flagToken);
  const envToken = present(env[TOKEN_ENV]);
  const fileToken = present(file?.token);
  if (flagToken !== undefined) {
    token = flagToken;
  } else if (envToken !== undefined) {
    token = envToken;
    tokenSource = "env";
  } else if (fileToken !== undefined) {
    token = fileToken;
    tokenSource = "file";
  }
  if (token === undefined) {
    throw new ConfigError(
      `no token configured — run \`jentrix login\`, pass --token <token>, set ${TOKEN_ENV}, or add ` +
        `"token" to ~/.config/stacks/config.json. Mint a PAT at ` +
        `/account/tokens on your Jentrix server.`,
      7,
    );
  }

  let url: string;
  let urlSource: UrlSource;
  const flagUrl = present(inputs.flagUrl);
  const envUrl = present(env[URL_ENV]);
  const fileUrl = present(file?.url);
  if (flagUrl !== undefined) {
    url = flagUrl;
    urlSource = "flag";
  } else if (envUrl !== undefined) {
    url = envUrl;
    urlSource = "env";
  } else if (fileUrl !== undefined) {
    url = fileUrl;
    urlSource = "file";
  } else {
    url = DEFAULT_MCP_URL;
    urlSource = "default";
  }
  try {
    new URL(url);
  } catch {
    throw new ConfigError(
      `invalid MCP URL (from ${urlSource === "flag" ? "--url" : urlSource === "env" ? URL_ENV : "config file"}): ${JSON.stringify(url)}`,
      2,
    );
  }

  return {
    token,
    url,
    defaults: file?.defaults ?? {},
    tokenSource,
    urlSource,
  };
}

/** Injectable fs edge (tests hand in a fake; prod uses node:fs). */
export interface ConfigFileReader {
  readFileSync(path: string, encoding: "utf8"): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Thin reader for the config file. Missing file → `null` (perfectly normal).
 * Unparseable or wrong-shaped file → `ConfigError` with the path and what is
 * wrong (exit 2) — a clear one-liner, never a stack trace.
 */
export function readConfigFile(
  path: string,
  fs: ConfigFileReader = { readFileSync },
): JentrixConfigFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (e) {
    if (isRecord(e) && e.code === "ENOENT") return null;
    const detail = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`cannot read config file ${path}: ${detail}`, 2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new ConfigError(
      `config file ${path} is not valid JSON: ${detail}`,
      2,
    );
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(
      `config file ${path} must contain a JSON object like ` +
        `{ "token": "…", "url": "…" }`,
      2,
    );
  }
  const bad = (field: string, want: string) =>
    new ConfigError(
      `config file ${path}: "${field}" must be a ${want} when present`,
      2,
    );
  if (parsed.token !== undefined && typeof parsed.token !== "string") {
    throw bad("token", "string");
  }
  if (parsed.url !== undefined && typeof parsed.url !== "string") {
    throw bad("url", "string");
  }
  if (parsed.defaults !== undefined && !isRecord(parsed.defaults)) {
    throw bad("defaults", "JSON object");
  }
  if (
    parsed.installationId !== undefined &&
    typeof parsed.installationId !== "string"
  ) {
    throw bad("installationId", "string");
  }
  let oauth: JentrixOAuthRecord | undefined;
  if (parsed.oauth !== undefined) {
    if (!isRecord(parsed.oauth)) throw bad("oauth", "JSON object");
    const o = parsed.oauth;
    // A partial/garbled oauth block must not crash reads on unrelated commands;
    // it's only load-bearing when a refresh is actually needed. Validate the
    // required string fields, but tolerate a missing `scope`.
    const str = (field: string): string => {
      const v = o[field];
      if (typeof v !== "string" || v.length === 0) {
        throw bad(`oauth.${field}`, "non-empty string");
      }
      return v;
    };
    oauth = {
      refreshToken: str("refreshToken"),
      expiresAt: str("expiresAt"),
      clientId: str("clientId"),
      tokenEndpoint: str("tokenEndpoint"),
      ...(typeof o.scope === "string" ? { scope: o.scope } : {}),
    };
  }
  return {
    ...(parsed.token !== undefined ? { token: parsed.token } : {}),
    ...(parsed.url !== undefined ? { url: parsed.url } : {}),
    ...(parsed.defaults !== undefined
      ? { defaults: parsed.defaults as Record<string, unknown> }
      : {}),
    ...(oauth !== undefined ? { oauth } : {}),
    ...(parsed.installationId !== undefined
      ? { installationId: parsed.installationId }
      : {}),
  };
}

/**
 * M20.1 §10.3 — create-if-absent installation UUID under the config write
 * path (atomic temp+rename), so concurrent first-connect commands converge on
 * one identity per install. Returns the stable value.
 */
export function ensureInstallationId(
  path: string,
  io: { reader?: ConfigFileReader; writer?: ConfigFileWriter } = {},
  mint: () => string = () => crypto.randomUUID(),
): string {
  const existing = readConfigFile(path, io.reader ?? { readFileSync }) ?? {};
  if (existing.installationId) return existing.installationId;
  const installationId = mint();
  writeConfigFile(
    path,
    { ...existing, installationId },
    io.writer ?? DEFAULT_WRITER,
  );
  return installationId;
}

/**
 * Injectable fs edge for WRITING the config file. Mirrors the small subset of
 * `node:fs` the writer needs; tests hand in a fake. The writer creates a fresh
 * exclusive temp file at 0600, `chmod`s it (belt-and-braces, since
 * `writeFileSync`'s mode is ignored when a file already exists) and `rename`s
 * it over the target atomically.
 */
export interface ConfigFileWriter {
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(
    path: string,
    data: string,
    options: { mode: number; flag: "wx" },
  ): void;
  chmodSync(path: string, mode: number): void;
  renameSync(from: string, to: string): void;
}

const DEFAULT_WRITER: ConfigFileWriter = {
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  writeFileSync: (path, data, options) => {
    writeFileSync(path, data, options);
  },
  chmodSync: (path, mode) => {
    chmodSync(path, mode);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
};

/** 0600 — owner read/write only. The config file holds bearer tokens. */
export const CONFIG_FILE_MODE = 0o600;

/**
 * Write the config file atomically at 0600. The parent dir is created
 * recursively; the content is written to a UNIQUE, exclusive (`wx`) sibling
 * temp file created at 0600 (and `chmod`ed to 0600 for good measure — a mode
 * arg is ignored on truncation of a pre-existing file), then `rename`d over the
 * target. Consequences:
 *   - a crash mid-write never leaves a torn or partial config file;
 *   - the tokens are never briefly world-readable (temp file is 0600 from
 *     creation, and `wx` refuses to reuse a pre-existing looser-perm file);
 *   - the per-write random suffix avoids cross-process temp-file collisions.
 * All fs goes through the injected writer (prod uses node:fs).
 */
export function writeConfigFile(
  path: string,
  config: JentrixConfigFile,
  fs: ConfigFileWriter = DEFAULT_WRITER,
): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const json = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, json, { mode: CONFIG_FILE_MODE, flag: "wx" });
  fs.chmodSync(tmp, CONFIG_FILE_MODE);
  fs.renameSync(tmp, path);
}

/**
 * Persist a freshly-issued/rotated OAuth token pair, PRESERVING every unrelated
 * field already in the file (url, defaults). The `tmo_` access token goes in
 * `token`; the rotation material goes in `oauth`. Read-merge-write against the
 * CURRENT on-disk file so a concurrent writer's other fields survive, and the
 * atomic rename makes the token+refresh swap all-or-nothing (a lost refresh
 * race is handled one level up — the loser re-logs in, never corrupts here).
 */
export function saveOAuthSession(
  path: string,
  session: {
    accessToken: string;
    url?: string;
    oauth: JentrixOAuthRecord;
  },
  io: { reader?: ConfigFileReader; writer?: ConfigFileWriter } = {},
): void {
  const existing = readConfigFile(path, io.reader ?? { readFileSync }) ?? {};
  const next: JentrixConfigFile = {
    ...existing,
    token: session.accessToken,
    ...(session.url !== undefined ? { url: session.url } : {}),
    oauth: session.oauth,
  };
  writeConfigFile(path, next, io.writer ?? DEFAULT_WRITER);
}

/**
 * Drop stored auth: remove `token` + `oauth`, keep everything else. Used by
 * `jentrix logout`. A missing file is a no-op (already logged out).
 */
export function clearOAuthSession(
  path: string,
  io: { reader?: ConfigFileReader; writer?: ConfigFileWriter } = {},
): { hadToken: boolean } {
  const existing = readConfigFile(path, io.reader ?? { readFileSync });
  if (!existing) return { hadToken: false };
  const hadToken = existing.token !== undefined || existing.oauth !== undefined;
  const next: JentrixConfigFile = { ...existing };
  delete next.token;
  delete next.oauth;
  writeConfigFile(path, next, io.writer ?? DEFAULT_WRITER);
  return { hadToken };
}
