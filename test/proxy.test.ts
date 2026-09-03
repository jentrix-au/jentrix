import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import {
  installProxyDispatcher,
  PROXY_ENV_VARS,
  proxyDiagnosis,
} from "../src/proxy";

/**
 * The load-bearing claim in proxy.ts is that `setGlobalDispatcher` from the
 * npm `undici` package redirects NODE'S OWN built-in `fetch` — they share the
 * `undici.globalDispatcher` global. Nothing in the type system says so, and an
 * undici major could quietly end it, at which point the CLI silently goes back
 * to ignoring HTTPS_PROXY on every call. So it is proved here, against a local
 * server and a dead proxy port: no external network, no flake.
 */
const PROXY_KEYS = [...PROXY_ENV_VARS, "NO_PROXY", "no_proxy"] as const;
const DEAD_PROXY = "http://127.0.0.1:9"; // discard port — nothing listens

let server: Server;
let url: string;
const original = getGlobalDispatcher();
const savedEnv = new Map<string, string | undefined>();

before(async () => {
  for (const key of PROXY_KEYS) savedEnv.set(key, process.env[key]);
  server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}/`;
});

after(async () => {
  setGlobalDispatcher(original);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Apply an env, install the dispatcher, and report what global fetch did. */
async function withProxyEnv(
  env: Record<string, string>,
): Promise<{ ok: boolean; detail: string }> {
  for (const key of PROXY_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  installProxyDispatcher();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ok: true, detail: await res.text() };
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause;
    return { ok: false, detail: cause?.message ?? String(e) };
  }
}

describe("installProxyDispatcher (JEN-306)", () => {
  it("leaves the un-proxied majority alone when no proxy var is set", async () => {
    const result = await withProxyEnv({});
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.detail, "ok");
  });

  it("routes the BUILT-IN global fetch through HTTP_PROXY", async () => {
    // The proof: the request lands on the dead proxy port, not on the server.
    const result = await withProxyEnv({ HTTP_PROXY: DEAD_PROXY });
    assert.equal(result.ok, false, "must not connect directly");
    assert.match(result.detail, /127\.0\.0\.1:9/);
  });

  it("honours NO_PROXY", async () => {
    const result = await withProxyEnv({
      HTTP_PROXY: DEAD_PROXY,
      NO_PROXY: "127.0.0.1",
    });
    assert.equal(result.ok, true, result.detail);
  });
});

describe("proxyDiagnosis", () => {
  it("names the variables that are set, never their values", () => {
    const text = proxyDiagnosis({ HTTPS_PROXY: "http://user:pw@gw:3128" });
    assert.match(text, /HTTPS_PROXY/);
    assert.ok(!text.includes("pw"), "a proxy URL can carry credentials");
    assert.ok(!text.includes("gw:3128"));
  });

  it("says so when NO proxy is configured — the silent case", () => {
    const text = proxyDiagnosis({});
    assert.match(text, /connecting directly/);
    assert.match(text, /HTTPS_PROXY/);
  });

  it("ignores blank values", () => {
    assert.match(proxyDiagnosis({ HTTP_PROXY: "  " }), /connecting directly/);
  });
});
