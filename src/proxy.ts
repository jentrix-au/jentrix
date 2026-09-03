/**
 * Proxy egress for EVERY CLI network call (JEN-306).
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * unless it is handed a dispatcher — so behind a corporate proxy, a VPN
 * egress or an inspection gateway the CLI silently took the DIRECT path and
 * every request died at the gateway. That is how `jentrix login` came to
 * blame the Jentrix server for a request that never reached it; the same hole
 * affected the MCP transport, `jentrix push`, artifact uploads and the
 * connected-session host, since they all run on that one global.
 *
 * `NODE_USE_ENV_PROXY=1` would do this natively, but it needs Node ≥ 22.21 and
 * package.json pins `node >=20` — so a real dispatcher it is.
 *
 * Two properties make this safe to call unconditionally at the process edge:
 * `EnvHttpProxyAgent` reads the env at CONSTRUCTION and degrades to a plain
 * Agent when no proxy variable is set (no branch here, no behaviour change for
 * the un-proxied majority), and `setGlobalDispatcher` writes the
 * `undici.globalDispatcher` global that Node's own bundled undici reads — so
 * the global `fetch` is redirected without a single call site changing. The
 * injected `fetchImpl` seam is untouched: it defaults to that same global, so
 * tests still stub it and production now inherits the proxy.
 *
 * Called from the two process edges ONLY — `main.ts`, and the `run` arm of
 * `session-host-main.ts`. The hook arm is zero-network by construction and
 * must never load this module.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Route the global `fetch` through the proxy named by the environment. */
export function installProxyDispatcher(): void {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

/** The proxy variables `EnvHttpProxyAgent` reads, in the order it reads them. */
export const PROXY_ENV_VARS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
] as const;

/**
 * The one diagnosis every transport failure shares. Naming whether a proxy is
 * CONFIGURED is what separates "your gateway refused this host" from "you are
 * behind a gateway the CLI is not using" — and the second case is the one that
 * used to fail silently and get misread as a server fault.
 *
 * Values are never printed: a proxy URL can carry credentials.
 */
export function proxyDiagnosis(
  env: Record<string, string | undefined>,
): string {
  const configured = PROXY_ENV_VARS.filter((name) => env[name]?.trim());
  if (configured.length > 0) {
    return (
      `The CLI is sending requests through the proxy in ${configured.join(", ")}. ` +
      "Check that it allows this host, or add the host to NO_PROXY."
    );
  }
  return (
    "No HTTP_PROXY/HTTPS_PROXY is set, so the CLI is connecting directly. " +
    "If this network requires a proxy, VPN egress or inspection gateway, set " +
    "HTTPS_PROXY (and NO_PROXY for hosts that bypass it) and try again."
  );
}
