/** Shared OAuth rotation and credential adoption. No CLI or host lifecycle policy. */
import {
  readConfigFile,
  saveOAuthSession,
  type ConfigFileReader,
  type ConfigFileWriter,
  type JentrixConfigFile,
  type JentrixOAuthRecord,
} from "./config";
import { OAuthTokenError, refreshAccessToken } from "./oauth";

export const RELOGIN_MESSAGE =
  "OAuth session expired and could not be refreshed — run `jentrix login` " +
  "to sign in again.";

export class RefreshFailedError extends Error {
  readonly reloginMessage: string;
  constructor(message: string = RELOGIN_MESSAGE) {
    super(message);
    this.name = "RefreshFailedError";
    this.reloginMessage = message;
  }
}

export const REFRESH_SKEW_MS = 60_000;

export interface MaybeRefreshInput {
  configPath: string;
  accessToken: string;
  oauth: JentrixOAuthRecord | undefined;
  /** Transient MCP target. Refresh never persists it or derives its token endpoint. */
  url?: string;
  force?: boolean;
  now?: () => number;
  fetchImpl?: typeof fetch;
  io?: { reader?: ConfigFileReader; writer?: ConfigFileWriter };
}

/** A sibling's token is usable only for the same stored issuer and client. */
export function sameOAuthAuthority(
  left: JentrixOAuthRecord | undefined,
  right: JentrixOAuthRecord | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.tokenEndpoint === right.tokenEndpoint &&
    left.clientId === right.clientId
  );
}

// Share the entire exchange + persistence, scoped to the config and authority.
// Cross-process single use remains the server's responsibility; a loser reads
// and adopts an already persisted winner. There is no background retry loop.
const inFlightRefreshes = new Map<string, Promise<string>>();

function failure(error: unknown): RefreshFailedError {
  // Endpoint descriptions, unknown error codes and thrown fetch errors can
  // contain submitted credentials. Only known protocol codes reach output.
  const codes = new Set([
    "invalid_grant",
    "invalid_client",
    "invalid_request",
    "invalid_scope",
    "unauthorized_client",
    "unsupported_grant_type",
    "network_error",
    "invalid_response",
    "server_error",
    "temporarily_unavailable",
  ]);
  const detail =
    error instanceof OAuthTokenError && codes.has(error.oauthCode)
      ? ` (${error.oauthCode})`
      : "";
  return new RefreshFailedError(`${RELOGIN_MESSAGE}${detail}`);
}

/** Proactive CLI freshness and forced host/CLI recovery use one rotation path. */
export async function maybeRefreshOAuthToken(
  input: MaybeRefreshInput,
): Promise<string> {
  const oauth = input.oauth;
  if (!oauth) return input.accessToken;
  const now = input.now ?? Date.now;
  const read = () => readConfigFile(input.configPath, input.io?.reader);
  let initial: JentrixConfigFile | null;
  try {
    initial = read();
  } catch (error) {
    throw failure(error);
  }
  const winner = (config: JentrixConfigFile | null): string | null => {
    if (config && !sameOAuthAuthority(config.oauth, oauth)) {
      // Another login/logout owns this file now. Neither overwrite it nor
      // send that deployment's credentials to the old session's endpoint.
      throw new RefreshFailedError();
    }
    if (!config && initial) throw new RefreshFailedError();
    return config?.token && config.token !== input.accessToken
      ? config.token
      : null;
  };
  const current = winner(initial);
  if (current) return current;
  const expiry = Date.parse(oauth.expiresAt);
  if (
    !input.force &&
    Number.isFinite(expiry) &&
    expiry - REFRESH_SKEW_MS > now()
  ) {
    return input.accessToken;
  }
  const key = JSON.stringify([
    input.configPath,
    oauth.tokenEndpoint,
    oauth.clientId,
    oauth.refreshToken,
  ]);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;
  const rotate = async (): Promise<string> => {
    try {
      const pair = await refreshAccessToken({
        tokenEndpoint: oauth.tokenEndpoint,
        clientId: oauth.clientId,
        refreshToken: oauth.refreshToken,
        fetchImpl: input.fetchImpl,
      });
      const after = read();
      const adopted = winner(after);
      if (adopted) return adopted;
      if (after?.oauth && after.oauth.refreshToken !== oauth.refreshToken) {
        throw new RefreshFailedError();
      }
      saveOAuthSession(
        input.configPath,
        {
          accessToken: pair.accessToken,
          oauth: {
            refreshToken: pair.refreshToken,
            expiresAt: new Date(
              now() + pair.expiresInSeconds * 1000,
            ).toISOString(),
            clientId: oauth.clientId,
            tokenEndpoint: oauth.tokenEndpoint,
            ...(pair.scope ? { scope: pair.scope } : {}),
          },
        },
        input.io,
      );
      return pair.accessToken;
    } catch (error) {
      try {
        const adopted = winner(read());
        if (adopted) return adopted;
      } catch {
        // Malformed/moved config is not a winner; never repair it by overwrite.
      }
      throw failure(error);
    }
  };
  const flight = rotate();
  inFlightRefreshes.set(key, flight);
  try {
    return await flight;
  } finally {
    inFlightRefreshes.delete(key);
  }
}
