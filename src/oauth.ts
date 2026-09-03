/**
 * OAuth 2.1 client helpers for `jentrix login` (stage C4.2) — the CLI is a
 * PUBLIC client over the EXISTING P2.7 authorization server (no AS changes).
 *
 * This module is PURE crypto/URL logic plus the two `fetch` calls that talk to
 * the AS metadata + token endpoints. It imports ONLY `node:` builtins, so it
 * satisfies the dependency firewall (README §4.3) whether or not it is ever
 * added to the core set — commander/http-listener code stays in
 * `commands/login.ts`.
 *
 * Security posture (mirrors the server in src/lib/oauth/service.ts):
 *   - PKCE S256 ONLY (RFC 7636): 43–128-char base64url verifier, challenge =
 *     base64url(sha256(verifier)). One fresh verifier per login attempt — the
 *     verifier is NEVER reused and NEVER logged.
 *   - `state`: a fresh 32-byte base64url nonce, compared with a constant-time
 *     check on the callback (CSRF / mix-up defence).
 *   - The `client_id` is the CIMD metadata URL (an https URL the AS fetches);
 *     `redirect_uri` is an EXACT-match loopback URL the AS has registered.
 *
 * Token hygiene: this module returns token material to the caller but never
 * writes it anywhere. Access (`tmo_`) and refresh (`tmr_`) tokens must never
 * reach stdout/stderr/logs — the command layer redacts, exactly as C4.1's
 * whoami does.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Path (relative to the app origin) of the CLI's CIMD client-metadata doc. */
export const CIMD_CLIENT_PATH = "/oauth/stacks-cli.json";

/** The three registered loopback ports (must match public/oauth/stacks-cli.json). */
export const LOOPBACK_PORTS = [8976, 8977, 8978] as const;

/** Loopback host — 127.0.0.1 ONLY (never 0.0.0.0), so nothing off-box connects. */
export const LOOPBACK_HOST = "127.0.0.1";

/** The redirect path on the loopback listener (matches the CIMD doc). */
export const CALLBACK_PATH = "/callback";

/** The OAuth scopes the CLI requests by default (read+write; admin opt-in). */
export const DEFAULT_LOGIN_SCOPES = ["read", "write"] as const;

/** A PKCE pair: the secret verifier and its S256 challenge. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** base64url(sha256(verifier)) — RFC 7636 §4.2, method S256. */
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Generate a fresh PKCE pair. The verifier is 32 random bytes base64url-encoded
 * (43 chars — within RFC 7636's 43–128 window and matching the server's
 * `verifyPkce` length guard). Crypto source is `node:crypto.randomBytes`.
 */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallengeFor(verifier) };
}

/** A fresh anti-CSRF `state` nonce (32 random bytes, base64url). */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time `state` comparison. Returns false for any length mismatch or
 * empty value — a mismatched/absent state on the callback is a hard error.
 */
export function stateMatches(expected: string, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The AS origin for a given MCP URL — same origin, `/api/mcp` stripped. */
export function originOf(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

/** The CIMD client_id (an absolute https/loopback URL) for an app origin. */
export function clientIdFor(origin: string): string {
  return new URL(CIMD_CLIENT_PATH, origin).toString();
}

/** The loopback redirect_uri for a chosen port (exact-match registered). */
export function redirectUriFor(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
}

/** AS endpoints the CLI needs. Discovered via RFC 8414, else derived. */
export interface AuthServerEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/**
 * The metadata probe could not REACH the authorization server (JEN-306).
 *
 * Deliberately distinct from "this deployment publishes no RFC 8414 document",
 * which is a legitimate 404 and still falls back to the conventional paths.
 * This is the other shape: something between the CLI and the origin ate the
 * request. Every later leg — the token exchange above all — will die the same
 * way, so login raises this BEFORE opening the browser rather than sending the
 * operator through a consent whose code can never be redeemed.
 */
export class AuthServerUnreachableError extends Error {
  /** The metadata URL that was probed. */
  readonly url: string;
  /** The status an intermediary returned, or null when nothing responded. */
  readonly status: number | null;
  constructor(url: string, status: number | null, detail: string) {
    super(detail);
    this.name = "AuthServerUnreachableError";
    this.url = url;
    this.status = status;
  }
}

/**
 * Statuses that mean an INTERMEDIARY answered, not the deployment. The
 * metadata document is public and unauthenticated, so an origin never demands
 * credentials for it: 401/403 there is a gateway or WAF, 407 is proxy auth,
 * and 5xx is an infrastructure failure that will not be any better at the
 * token endpoint. Everything else — 404 and 410 above all — stays a fallback:
 * a bare deployment genuinely has no metadata document to serve.
 */
function statusMeansIntercepted(status: number): boolean {
  return status === 401 || status === 403 || status === 407 || status >= 500;
}

/**
 * Discover the AS authorization/token endpoints via RFC 8414 metadata at
 * `<origin>/.well-known/oauth-authorization-server`. Falls back to the P2.7
 * conventional paths (`/oauth/authorize`, `/oauth/token`) when the document is
 * missing or malformed — the CLI stays functional against a bare deployment.
 *
 * Throws `AuthServerUnreachableError` when the probe never reached the origin.
 * This used to fall back too, which made the metadata request a silent
 * reachability test the CLI then ignored (JEN-306).
 */
export async function discoverAuthServer(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthServerEndpoints> {
  const fallback: AuthServerEndpoints = {
    authorizationEndpoint: new URL("/oauth/authorize", origin).toString(),
    tokenEndpoint: new URL("/oauth/token", origin).toString(),
  };
  const url = new URL(
    "/.well-known/oauth-authorization-server",
    origin,
  ).toString();
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    throw new AuthServerUnreachableError(
      url,
      null,
      e instanceof Error ? e.message : String(e),
    );
  }
  if (statusMeansIntercepted(res.status)) {
    throw new AuthServerUnreachableError(
      url,
      res.status,
      `the metadata endpoint answered HTTP ${res.status}`,
    );
  }
  if (!res.ok) return fallback;
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return fallback; // served something that is not the document — same as bare
  }
  const authorizationEndpoint =
    typeof json.authorization_endpoint === "string"
      ? json.authorization_endpoint
      : fallback.authorizationEndpoint;
  const tokenEndpoint =
    typeof json.token_endpoint === "string"
      ? json.token_endpoint
      : fallback.tokenEndpoint;
  return { authorizationEndpoint, tokenEndpoint };
}

/** Everything needed to build the authorize URL for one login attempt. */
export interface AuthorizeUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}

/** Build the browser authorize URL (response_type=code, PKCE S256). */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** A token pair as returned by the AS token endpoint (RFC 6749 §5.1). */
export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (from `expires_in`). */
  expiresInSeconds: number;
  scope: string;
}

/** An OAuth error the token endpoint returned (RFC 6749 §5.2 shape). */
export class OAuthTokenError extends Error {
  readonly oauthCode: string;
  constructor(oauthCode: string, message: string) {
    super(message);
    this.name = "OAuthTokenError";
    this.oauthCode = oauthCode;
  }
}

const ACCESS_TOKEN_PREFIX = "tmo_";
const REFRESH_TOKEN_PREFIX = "tmr_";

/**
 * Parse + validate a token-endpoint JSON body into an `OAuthTokenResponse`.
 * PURE — no I/O. Rejects a response whose token families don't match the P2.7
 * contract (access `tmo_`, refresh `tmr_`), so a misconfigured endpoint can't
 * poison the config with a non-bearer value.
 */
export function parseTokenResponse(body: unknown): OAuthTokenResponse {
  if (typeof body !== "object" || body === null) {
    throw new OAuthTokenError(
      "invalid_response",
      "token response is not an object",
    );
  }
  const json = body as Record<string, unknown>;
  if (typeof json.error === "string") {
    const detail =
      typeof json.error_description === "string"
        ? json.error_description
        : json.error;
    throw new OAuthTokenError(json.error, detail);
  }
  const accessToken = json.access_token;
  const refreshToken = json.refresh_token;
  if (
    typeof accessToken !== "string" ||
    !accessToken.startsWith(ACCESS_TOKEN_PREFIX)
  ) {
    throw new OAuthTokenError(
      "invalid_response",
      `token response missing a ${ACCESS_TOKEN_PREFIX} access_token`,
    );
  }
  if (
    typeof refreshToken !== "string" ||
    !refreshToken.startsWith(REFRESH_TOKEN_PREFIX)
  ) {
    throw new OAuthTokenError(
      "invalid_response",
      `token response missing a ${REFRESH_TOKEN_PREFIX} refresh_token`,
    );
  }
  const expiresInSeconds =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in)
      ? json.expires_in
      : 3600;
  const scope = typeof json.scope === "string" ? json.scope : "";
  return { accessToken, refreshToken, expiresInSeconds, scope };
}

/** POST body params common to both grants (public client — no secret). */
interface TokenRequestBase {
  tokenEndpoint: string;
  clientId: string;
  fetchImpl?: typeof fetch;
}

async function postToken(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<OAuthTokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new OAuthTokenError(
      "network_error",
      `token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // JEN-306 — a non-JSON body on an ERROR status is an interception
    // artifact: a proxy/WAF/captive-portal page, not the token endpoint's
    // answer. Calling that `invalid_response` blamed the Jentrix server for a
    // request that never reached it, and exiting there burned an
    // authorization code that was still unspent. Only a non-JSON 2xx is the
    // endpoint genuinely misbehaving.
    throw new OAuthTokenError(
      res.ok ? "invalid_response" : "network_error",
      `token endpoint returned non-JSON (HTTP ${res.status})`,
    );
  }
  // parseTokenResponse surfaces an embedded {error} regardless of HTTP status.
  return parseTokenResponse(json);
}

/** Exchange an authorization code for a token pair (authorization_code grant). */
export function exchangeCodeForTokens(
  input: TokenRequestBase & {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<OAuthTokenResponse> {
  return postToken(
    input.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
    },
    input.fetchImpl ?? fetch,
  );
}

/** Rotate a refresh token for a fresh pair (refresh_token grant). */
export function refreshAccessToken(
  input: TokenRequestBase & { refreshToken: string },
): Promise<OAuthTokenResponse> {
  return postToken(
    input.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    },
    input.fetchImpl ?? fetch,
  );
}
