/**
 * Session-host bearer resolution (capture-off telemetry loss, 2026-08-08).
 *
 * The host used to hold the ONE bearer its plan was built with. An OAuth
 * access token (`tmo_`) lives ≤1h and is revoked the instant any concurrent
 * CLI invocation rotates the refresh token — live evidence (session
 * cmsk80my000ib04jvsrvlzf9q): host spawned 10:24:26 with the freshest token,
 * a `jentrix push` rotated at 10:26:49, the host's completion 401'd at
 * 10:26:55 and the whole usage rollup died with it.
 *
 * Fix: the host resolves its bearer through the SAME config file the CLI
 * persists rotations to. Dependency firewall: this MIRRORS the CLI's
 * `saveOAuthSession` read-merge-atomic-rename and `refreshAccessToken`
 * (cli/src/config.ts, cli/src/oauth.ts) — it never imports them. Server-side
 * rotation is single-use and a replayed refresh token is a benign
 * `invalid_grant` (no family revocation), so the loser of a concurrent
 * refresh race re-reads the file and adopts the winner's tokens; both sides
 * write atomically, so neither corrupts the other.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface SessionBearerSource {
  /** The bearer to use for the NEXT request (freshest known). */
  get(): string;
  /**
   * Called after an unauthorized response with the bearer that failed.
   * Returns a DIFFERENT bearer to retry with, or null when no recovery
   * exists (bare PAT, no oauth record, refresh refused and nobody else
   * rotated).
   */
  refresh(failedBearer: string): Promise<string | null>;
}

/** A bare PAT (or a plan with no configPath): no rotation, no recovery. */
export function staticBearerSource(bearer: string): SessionBearerSource {
  return { get: () => bearer, refresh: async () => null };
}

interface OAuthRecord {
  refreshToken: string;
  expiresAt: string;
  clientId: string;
  tokenEndpoint: string;
  scope?: string;
}

interface ConfigShape {
  token?: string;
  oauth?: OAuthRecord;
  [key: string]: unknown;
}

function readConfig(configPath: string): ConfigShape | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    return parsed as ConfigShape;
  } catch {
    return null;
  }
}

/** Mirror of the CLI's 0600 tmp + `wx` + rename atomic config write. */
function writeConfig(configPath: string, config: ConfigShape): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(tmp, 0o600);
  renameSync(tmp, configPath);
}

function oauthRecordOf(config: ConfigShape | null): OAuthRecord | null {
  const oauth = config?.oauth;
  if (
    oauth &&
    typeof oauth.refreshToken === "string" &&
    oauth.refreshToken.length > 0 &&
    typeof oauth.tokenEndpoint === "string" &&
    typeof oauth.clientId === "string"
  ) {
    return oauth;
  }
  return null;
}

/**
 * F3: a refresh-produced bearer failing again THIS soon after its mint means
 * the endpoint rejects the whole chain (wrong deployment), not that the token
 * expired — access tokens live ~1h, heartbeats come every 30s. Well inside
 * expiry, well past a couple of beats.
 */
const FRESH_BEARER_WINDOW_MS = 120_000;

export function createConfigBearerSource(opts: {
  configPath: string;
  /** The plan's spawn-time bearer — used only until the config file yields one. */
  fallback: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Injectable clock (tests). */
  now?: () => number;
}): SessionBearerSource {
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? Date.now;
  // One refresh in flight per process — concurrent heartbeat/flush/completion
  // failures share the same recovery instead of racing the single-use grant.
  let pending: Promise<string | null> | null = null;
  // F3 (OAuth chain starvation): the bearer this source last produced, and
  // when. When THAT token comes back as the failed bearer within the fresh
  // window, the endpoint — not the token — is wrong (a host posting to
  // deployment B with deployment A's chain), and refreshing again only
  // rotates the SHARED CLI chain out from under a healthy sibling host every
  // heartbeat. Halt refreshes permanently instead.
  let lastProduced: { bearer: string; at: number } | null = null;
  let halted = false;

  const get = (): string => {
    const token = readConfig(opts.configPath)?.token;
    return typeof token === "string" && token.length > 0
      ? token
      : opts.fallback;
  };

  const refreshOnce = async (failedBearer: string): Promise<string | null> => {
    // Someone else (the CLI, or a sibling failure path here) already rotated.
    const current = get();
    if (current !== failedBearer) return current;

    const config = readConfig(opts.configPath);
    const oauth = oauthRecordOf(config);
    if (!oauth) return null;

    try {
      const res = await doFetch(oauth.tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          client_id: oauth.clientId,
        }).toString(),
      });
      if (!res.ok) throw new Error(`token endpoint ${res.status}`);
      const pair = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
      };
      if (!pair.access_token || !pair.refresh_token) {
        throw new Error("token endpoint returned no pair");
      }
      const expiresAt = new Date(
        Date.now() + (pair.expires_in ?? 3600) * 1000,
      ).toISOString();
      // Read-merge-write so a concurrent writer's other fields survive.
      writeConfig(opts.configPath, {
        ...(readConfig(opts.configPath) ?? {}),
        token: pair.access_token,
        oauth: {
          refreshToken: pair.refresh_token,
          expiresAt,
          clientId: oauth.clientId,
          tokenEndpoint: oauth.tokenEndpoint,
          ...(pair.scope ? { scope: pair.scope } : {}),
        },
      });
      log("bearer refreshed (session host rotated the OAuth token)");
      return pair.access_token;
    } catch (error) {
      // Lost the single-use race (invalid_grant) or the endpoint failed —
      // adopt whatever a concurrent winner persisted, else give up honestly.
      const after = get();
      if (after !== failedBearer) {
        log("bearer refreshed by a concurrent process — adopted");
        return after;
      }
      log(
        `bearer refresh failed (${error instanceof Error ? error.message : String(error)})`,
      );
      return null;
    }
  };

  return {
    get,
    refresh: (failedBearer) => {
      if (halted) return Promise.resolve(null);
      if (
        lastProduced !== null &&
        failedBearer === lastProduced.bearer &&
        now() - lastProduced.at < FRESH_BEARER_WINDOW_MS
      ) {
        halted = true;
        log(
          "bearer halt: a freshly refreshed token was still unauthorized — the endpoint rejects this credential's whole chain (wrong deployment for this bearer?). Halting token rotation so sibling hosts keep theirs; end this host and re-align against the right deployment.",
        );
        return Promise.resolve(null);
      }
      if (!pending) {
        pending = refreshOnce(failedBearer)
          .then((produced) => {
            if (produced !== null) {
              lastProduced = { bearer: produced, at: now() };
            }
            return produced;
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    },
  };
}

/**
 * Matches the transport/tool errors an expired or revoked bearer produces:
 * the SDK's StreamableHTTPError (code 401), "Unauthorized", and the server's
 * withMcpAuth JSON (`invalid_token` / "No authorization provided").
 */
export function isUnauthorizedishError(e: unknown): boolean {
  if (typeof e === "object" && e !== null) {
    const rec = e as { code?: unknown; status?: unknown };
    if (rec.code === 401 || rec.status === 401) return true;
  }
  const message = e instanceof Error ? e.message : String(e);
  return /\b401\b|unauthorized|invalid_token|no authorization/i.test(message);
}
