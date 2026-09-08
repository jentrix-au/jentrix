/** Long-lived host coordination over the package's shared OAuth/config primitives. */
import { readConfigFile, type JentrixConfigFile } from "../config";
import { maybeRefreshOAuthToken, sameOAuthAuthority } from "../oauth-session";

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

  const read = (): JentrixConfigFile | null => {
    try {
      return readConfigFile(opts.configPath);
    } catch {
      return null;
    }
  };
  // Follow rotations, never a new login for a different token endpoint/client.
  let authority = read()?.oauth;
  const currentConfig = (): JentrixConfigFile | null => {
    const config = read();
    if (authority && !sameOAuthAuthority(authority, config?.oauth)) return null;
    authority ??= config?.oauth;
    return config;
  };
  const get = (): string => currentConfig()?.token || opts.fallback;

  const refreshOnce = async (failedBearer: string): Promise<string | null> => {
    const config = currentConfig();
    if (!config?.token) return null;
    if (!config.oauth)
      return config.token !== failedBearer ? config.token : null;
    try {
      const token = await maybeRefreshOAuthToken({
        configPath: opts.configPath,
        accessToken: failedBearer,
        oauth: config.oauth,
        force: true,
        fetchImpl: opts.fetchImpl,
        now,
      });
      if (token === failedBearer) return null;
      log(
        "bearer refreshed (rotated or adopted a concurrent OAuth credential)",
      );
      return token;
    } catch {
      // Never print endpoint/fetch diagnostics: they can echo token bytes.
      log("bearer refresh failed — no usable concurrent credential");
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
