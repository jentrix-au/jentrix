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
import { readConfigFile, type JentrixConfigFile } from "./config";
import {
  maybeRefreshOAuthToken,
  sameOAuthAuthority,
  RefreshFailedError,
} from "./oauth-session";
import { isUnauthorizedError } from "./errors";

export const CLI_NAME = "stacks-cli";
export const CLI_VERSION = "0.10.0";

/**
 * The actionable dead-token message (stage C1.2): a bare HTTP 401 reads as a
 * generic failure, so name the cause and the fix explicitly.
 */
export const DEAD_TOKEN_MESSAGE =
  "authentication failed (HTTP 401): the token is dead or expired — " +
  "mint a new PAT at /account/tokens on your Jentrix server and update " +
  "STACKS_TOKEN (or --token / the config file).";

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
      token === input.token
        ? input.oauth
        : (readOAuthRecord(input.configPath, input.io?.reader) ?? input.oauth);
    if (!sameOAuthAuthority(current, input.oauth))
      throw new RefreshFailedError();
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
