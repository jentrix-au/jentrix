/**
 * Production MCP client factory: Streamable HTTP + Bearer token. One
 * `Client` per process invocation, nothing else lives here (design.md
 * Phase 1). OUTSIDE the dependency firewall — core modules never import
 * this; they receive the connected client as a plain `ToolCaller`.
 *
 * Token hygiene: the token goes into the Authorization header and NOWHERE
 * else — never into error messages, never into logs. 401 classification is
 * exported so the command layer can print the dead-token message (exit 7)
 * instead of a generic transport error, which agents otherwise misread.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type {
  ConfigFileReader,
  ConfigFileWriter,
  JentrixOAuthRecord,
} from "./config";
import {
  readConfigFile,
  saveOAuthSession,
  type JentrixConfigFile,
} from "./config";
import {
  OAuthTokenError,
  refreshAccessToken,
  type OAuthTokenResponse,
} from "./oauth";

export const CLI_NAME = "stacks-cli";
export const CLI_VERSION = "0.8.2";

/**
 * The actionable dead-token message (stage C1.2): a bare HTTP 401 reads as a
 * generic failure, so name the cause and the fix explicitly.
 */
export const DEAD_TOKEN_MESSAGE =
  "authentication failed (HTTP 401): the token is dead or expired — " +
  "mint a new PAT at /account/tokens on your Jentrix server and update " +
  "STACKS_TOKEN (or --token / the config file).";

/**
 * The dead-OAuth-session message (stage C4.2): when a stored OAuth token is
 * expired AND its refresh token can't be rotated (revoked, expired, or lost a
 * concurrent-refresh race), the fix is to re-run the browser login — not to
 * mint a PAT. Maps to exit 7, same as any other transport/auth failure.
 */
export const RELOGIN_MESSAGE =
  "OAuth session expired and could not be refreshed — run `jentrix login` " +
  "to sign in again.";

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The 401 diagnosis (AGE-978). A stored OAuth session names the deployment it
 * was minted against (`oauth.tokenEndpoint`); when the endpoint being called
 * lives somewhere else, the credential is not dead — the config disagrees with
 * itself, and `DEAD_TOKEN_MESSAGE` sends the operator to mint a PAT they do
 * not need. Say which two deployments are involved instead.
 *
 * A drifted config keeps 401ing on every command, and the refresh keeps
 * SUCCEEDING (it uses the still-correct token endpoint), so nothing else in
 * the system will ever surface the real cause.
 */
export function unauthorizedMessage(
  config: Pick<JentrixConfigFile, "url" | "oauth"> | null,
  resolvedUrl: string,
): string {
  const called = originOf(resolvedUrl);
  const minted = originOf(config?.oauth?.tokenEndpoint);
  if (!called || !minted || called === minted) return DEAD_TOKEN_MESSAGE;
  return (
    `authentication failed (HTTP 401): this config holds a token minted for ${minted} ` +
    `but is calling ${called} — the token is not dead, the endpoint is wrong. ` +
    `Fix the "url" in the config file to ${minted}, or run \`jentrix login --url ${resolvedUrl}\` ` +
    "to mint a credential for the deployment you are calling."
  );
}

/**
 * Refresh a stored OAuth access token when it is expired (or within the skew
 * window), rotating the refresh token and persisting the NEW pair atomically.
 * Only fires for OAuth sessions (a `tmo_` token WITH a stored `oauth` record);
 * a bare PAT or an OAuth token that is still fresh is returned unchanged.
 *
 * Single-flight + rotation-aware:
 *   - within ONE process a shared in-flight promise dedupes concurrent refresh
 *     attempts (keyed by refresh token) so a single invocation rotates once;
 *   - ACROSS processes the AS enforces single-use rotation and the config write
 *     is an atomic rename, so a lost race throws `RefreshFailedError` (→ exit 7
 *     + `RELOGIN_MESSAGE`) rather than corrupting the config or double-spending
 *     the rotated pair.
 *
 * A successful refresh writes `{ token: newAccess, oauth: { newRefresh,
 * expiresAt, … } }` before returning the fresh access token, so the very next
 * `connect()` uses it. Token material never leaves this module except as the
 * returned access token (which the caller feeds to the Authorization header).
 */
export class RefreshFailedError extends Error {
  /** The remediation message the command layer should print (exit 7). */
  readonly reloginMessage: string;
  constructor(message: string) {
    super(message);
    this.name = "RefreshFailedError";
    this.reloginMessage = message;
  }
}

/** How long before real expiry we proactively refresh (clock-skew margin). */
export const REFRESH_SKEW_MS = 60_000;

/** In-process single-flight map, keyed by the refresh token being rotated. */
const inFlightRefreshes = new Map<string, Promise<OAuthTokenResponse>>();

export interface MaybeRefreshInput {
  /** The resolved config-file path (where tokens are persisted). */
  configPath: string;
  /** The currently-resolved access token (may be a PAT). */
  accessToken: string;
  /** The stored OAuth record, or undefined for a PAT / no login. */
  oauth: JentrixOAuthRecord | undefined;
  /** Endpoint override the config url should be written with (optional). */
  url?: string;
  /**
   * Force a refresh regardless of the local `expiresAt` — used after a 401 on a
   * token the clock said was still fresh (server-side revocation / clock skew).
   */
  force?: boolean;
  /** Injectable clock + fetch + fs for tests. */
  now?: () => number;
  fetchImpl?: typeof fetch;
  io?: { reader?: ConfigFileReader; writer?: ConfigFileWriter };
}

/**
 * Returns the access token to actually use for this invocation, refreshing
 * first when a stored OAuth token is expired/near-expiry (or `force`). Throws
 * `RefreshFailedError` when a refresh was required but failed.
 */
export async function maybeRefreshOAuthToken(
  input: MaybeRefreshInput,
): Promise<string> {
  const { oauth } = input;
  // No OAuth record → nothing to refresh (bare PAT or unauthenticated).
  if (!oauth) return input.accessToken;

  const now = input.now ?? Date.now;
  const expiresAtMs = Date.parse(oauth.expiresAt);
  const stillFresh =
    Number.isFinite(expiresAtMs) && expiresAtMs - REFRESH_SKEW_MS > now();
  if (stillFresh && input.force !== true) return input.accessToken;

  // Deduplicate concurrent refreshes in THIS process on the refresh token.
  let flight = inFlightRefreshes.get(oauth.refreshToken);
  if (!flight) {
    flight = refreshAccessToken({
      tokenEndpoint: oauth.tokenEndpoint,
      clientId: oauth.clientId,
      refreshToken: oauth.refreshToken,
      fetchImpl: input.fetchImpl,
    });
    inFlightRefreshes.set(oauth.refreshToken, flight);
    // Clear the slot once settled (success or failure) so a later, distinct
    // refresh token isn't shadowed by a stale entry. The cleanup is on a
    // detached copy with its own catch so a rejected refresh doesn't surface as
    // an unhandled rejection on this side-channel (the real rejection is
    // awaited + mapped below).
    void flight.then(
      () => inFlightRefreshes.delete(oauth.refreshToken),
      () => inFlightRefreshes.delete(oauth.refreshToken),
    );
  }

  let pair: OAuthTokenResponse;
  try {
    pair = await flight;
  } catch (e) {
    // invalid_grant (revoked/expired/already-rotated → lost race) or network:
    // the caller can't recover automatically — tell them to re-login.
    const detail = e instanceof OAuthTokenError ? ` (${e.oauthCode})` : "";
    throw new RefreshFailedError(`${RELOGIN_MESSAGE}${detail}`);
  }

  // Persist the rotated pair atomically BEFORE returning it.
  //
  // AGE-978: the TOKEN rotates; the `url` does NOT. `url` resolves flag > env
  // > file, so writing it here turned a one-off `--url <other>` on any command
  // that happened to refresh into that config's PERMANENT endpoint — leaving a
  // valid, still-rotating token for one deployment aimed at another, 401ing
  // forever while the error blamed the credential. Recording an endpoint is
  // `jentrix login`'s job (it calls saveOAuthSession itself with the endpoint
  // the operator actually chose); a refresh has no business deciding one.
  const expiresAt = new Date(
    now() + pair.expiresInSeconds * 1000,
  ).toISOString();
  saveOAuthSession(
    input.configPath,
    {
      accessToken: pair.accessToken,
      oauth: {
        refreshToken: pair.refreshToken,
        expiresAt,
        clientId: oauth.clientId,
        tokenEndpoint: oauth.tokenEndpoint,
        ...(pair.scope ? { scope: pair.scope } : {}),
      },
    },
    input.io ?? {},
  );
  return pair.accessToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * HTTP 401 from the transport (dead/expired/revoked token). The SDK throws
 * `StreamableHTTPError` with `code: 401` (or `UnauthorizedError` with an
 * "Unauthorized" message), so match both the numeric code and the text.
 */
export function isUnauthorizedError(e: unknown): boolean {
  if (isRecord(e) && (e.code === 401 || e.status === 401)) return true;
  const message = e instanceof Error ? e.message : "";
  return /\b401\b|unauthorized/i.test(message);
}

export interface JentrixClientHandle {
  /** Connected client — hand it to `callTool` as a `ToolCaller`. */
  client: Client;
  close(): Promise<void>;
}

/**
 * Build + connect the one client for this invocation. The `connect()`
 * initialize round-trip authenticates immediately, so a dead token fails
 * HERE (throwing a 401 the caller maps to exit 7 + `DEAD_TOKEN_MESSAGE`)
 * rather than at the first tool call.
 */
export async function connectJentrixClient(target: {
  url: string;
  token: string;
  /**
   * STA-26 — validated session correlation. Sent as `X-Stacks-Session-Id` so
   * server-side activity payloads carry the session id (`withSource`); the
   * server validates the claim against the bearer, so a wrong id refuses the
   * call rather than stamping someone else's session.
   */
  sessionId?: string;
}): Promise<JentrixClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${target.token}`,
        ...(target.sessionId
          ? { "X-Stacks-Session-Id": target.sessionId }
          : {}),
      },
    },
  });
  const client = new Client({ name: CLI_NAME, version: CLI_VERSION });
  await client.connect(transport);
  return {
    client,
    close: () => client.close(),
  };
}

export interface ConnectWithRefreshInput {
  url: string;
  /** The resolved access token (config-file token when refresh is eligible). */
  token: string;
  /** Validated session correlation to send as `X-Stacks-Session-Id`. */
  sessionId?: string;
  /** The stored OAuth record (present ⇒ refresh-eligible), or undefined. */
  oauth: JentrixOAuthRecord | undefined;
  configPath: string;
  /** Seams for tests. */
  connect?: (target: {
    url: string;
    token: string;
    sessionId?: string;
  }) => Promise<JentrixClientHandle>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  io?: { reader?: ConfigFileReader; writer?: ConfigFileWriter };
}

/**
 * Connect with OAuth freshness handling (stage C4.2):
 *   1. proactively refresh a stored OAuth token that is expired / near-expiry
 *      (skew window), persisting the rotated pair;
 *   2. connect;
 *   3. if connect fails with a 401 AND this was an OAuth session that we have
 *      NOT already force-refreshed this call, force ONE refresh (server-side
 *      revocation / clock skew that `expiresAt` missed) and retry connect once.
 *
 * A refresh that itself fails (invalid_grant / lost race / network) throws
 * `RefreshFailedError` (→ exit 7 + `RELOGIN_MESSAGE`, the OAuth remediation, NOT
 * the mint-a-PAT one). For a bare PAT (no `oauth`) this is exactly
 * `connectJentrixClient` — no refresh, a 401 is the dead-token path unchanged.
 */
export async function connectJentrixClientWithRefresh(
  input: ConnectWithRefreshInput,
): Promise<JentrixClientHandle> {
  const connect = input.connect ?? connectJentrixClient;

  // Step 1: proactive refresh (no-op for a fresh token / a PAT).
  let token = await maybeRefreshOAuthToken({
    configPath: input.configPath,
    accessToken: input.token,
    oauth: input.oauth,
    url: input.url,
    now: input.now,
    fetchImpl: input.fetchImpl,
    io: input.io,
  });

  try {
    return await connect({ url: input.url, token, sessionId: input.sessionId });
  } catch (e) {
    // Step 3: a 401 on an OAuth session → force one refresh + retry.
    if (!input.oauth || !isUnauthorizedError(e)) throw e;
    // Re-read the freshest oauth record: step 1 may already have rotated it.
    const current =
      readOAuthRecord(input.configPath, input.io?.reader) ?? input.oauth;
    token = await maybeRefreshOAuthToken({
      configPath: input.configPath,
      accessToken: token,
      oauth: current,
      url: input.url,
      force: true,
      now: input.now,
      fetchImpl: input.fetchImpl,
      io: input.io,
    });
    return connect({ url: input.url, token, sessionId: input.sessionId });
  }
}

/** Read just the stored OAuth record; swallow a malformed file (→ undefined). */
function readOAuthRecord(
  configPath: string,
  reader?: ConfigFileReader,
): JentrixOAuthRecord | undefined {
  try {
    return (
      reader ? readConfigFile(configPath, reader) : readConfigFile(configPath)
    )?.oauth;
  } catch {
    return undefined;
  }
}
