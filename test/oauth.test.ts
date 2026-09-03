import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AuthServerUnreachableError,
  buildAuthorizeUrl,
  clientIdFor,
  discoverAuthServer,
  exchangeCodeForTokens,
  generatePkcePair,
  generateState,
  OAuthTokenError,
  originOf,
  parseTokenResponse,
  pkceChallengeFor,
  redirectUriFor,
  refreshAccessToken,
  stateMatches,
  CIMD_CLIENT_PATH,
  LOOPBACK_HOST,
  LOOPBACK_PORTS,
} from "../src/oauth";

describe("PKCE (RFC 7636)", () => {
  it("matches the RFC 7636 Appendix B S256 test vector", () => {
    // The canonical vector from RFC 7636 §B.1/§B.2.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert.equal(pkceChallengeFor(verifier), expectedChallenge);
  });

  it("generates a base64url verifier within the 43–128 length window", () => {
    for (let i = 0; i < 25; i++) {
      const { verifier, challenge } = generatePkcePair();
      assert.ok(
        verifier.length >= 43 && verifier.length <= 128,
        `verifier length ${verifier.length} out of RFC window`,
      );
      // base64url alphabet only (no +, /, =).
      assert.match(verifier, /^[A-Za-z0-9_-]+$/);
      assert.match(challenge, /^[A-Za-z0-9_-]+$/);
      // challenge is the S256 of the verifier.
      assert.equal(challenge, pkceChallengeFor(verifier));
    }
  });

  it("produces a unique verifier per attempt (no reuse)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generatePkcePair().verifier);
    assert.equal(seen.size, 100);
  });
});

describe("state (CSRF nonce)", () => {
  it("matches only the exact value (constant-time), rejects mismatch/empty/null", () => {
    const state = generateState();
    assert.match(state, /^[A-Za-z0-9_-]+$/);
    assert.ok(stateMatches(state, state));
    assert.ok(!stateMatches(state, `${state}x`));
    assert.ok(!stateMatches(state, state.slice(0, -1)));
    assert.ok(!stateMatches(state, null));
    assert.ok(!stateMatches(state, ""));
    assert.ok(!stateMatches("", state));
  });

  it("generates a unique state per attempt", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateState());
    assert.equal(seen.size, 100);
  });
});

describe("URL helpers", () => {
  it("derives the app origin from the MCP URL", () => {
    assert.equal(
      originOf("https://tm.jentrix.ai/api/mcp"),
      "https://tm.jentrix.ai",
    );
    assert.equal(
      originOf("http://localhost:3000/api/mcp"),
      "http://localhost:3000",
    );
    assert.equal(
      originOf("http://127.0.0.1:3100/api/mcp"),
      "http://127.0.0.1:3100",
    );
  });

  it("builds the CIMD client_id at the fixed static path", () => {
    assert.equal(
      clientIdFor("https://tm.jentrix.ai"),
      `https://tm.jentrix.ai${CIMD_CLIENT_PATH}`,
    );
    assert.equal(
      clientIdFor("http://localhost:3000"),
      `http://localhost:3000${CIMD_CLIENT_PATH}`,
    );
  });

  it("builds a loopback redirect_uri that is 127.0.0.1 only", () => {
    for (const port of LOOPBACK_PORTS) {
      const uri = redirectUriFor(port);
      assert.equal(uri, `http://${LOOPBACK_HOST}:${port}/callback`);
      assert.equal(new URL(uri).hostname, "127.0.0.1");
      assert.notEqual(new URL(uri).hostname, "0.0.0.0");
    }
  });

  it("builds an authorize URL with response_type=code + PKCE S256", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://tm.jentrix.ai/oauth/authorize",
        clientId: "https://tm.jentrix.ai/oauth/stacks-cli.json",
        redirectUri: "http://127.0.0.1:8976/callback",
        scopes: ["read", "write"],
        state: "STATE123",
        codeChallenge: "CHALLENGE456",
      }),
    );
    assert.equal(
      url.origin + url.pathname,
      "https://tm.jentrix.ai/oauth/authorize",
    );
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(
      url.searchParams.get("client_id"),
      "https://tm.jentrix.ai/oauth/stacks-cli.json",
    );
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "http://127.0.0.1:8976/callback",
    );
    assert.equal(url.searchParams.get("scope"), "read write");
    assert.equal(url.searchParams.get("state"), "STATE123");
    assert.equal(url.searchParams.get("code_challenge"), "CHALLENGE456");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  });
});

describe("parseTokenResponse", () => {
  const good = {
    access_token: "tmo_abc123",
    refresh_token: "tmr_def456",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "read write",
  };

  it("parses a well-formed token response", () => {
    const parsed = parseTokenResponse(good);
    assert.equal(parsed.accessToken, "tmo_abc123");
    assert.equal(parsed.refreshToken, "tmr_def456");
    assert.equal(parsed.expiresInSeconds, 3600);
    assert.equal(parsed.scope, "read write");
  });

  it("surfaces an embedded OAuth error as OAuthTokenError", () => {
    try {
      parseTokenResponse({
        error: "invalid_grant",
        error_description: "Code expired",
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof OAuthTokenError);
      assert.equal(e.oauthCode, "invalid_grant");
      assert.match(e.message, /Code expired/);
    }
  });

  it("rejects a response whose access_token is not a tmo_ token", () => {
    assert.throws(
      () => parseTokenResponse({ ...good, access_token: "tm_apat" }),
      /tmo_ access_token/,
    );
  });

  it("rejects a response whose refresh_token is not a tmr_ token", () => {
    assert.throws(
      () => parseTokenResponse({ ...good, refresh_token: "nope" }),
      /tmr_ refresh_token/,
    );
  });

  it("defaults expires_in to 3600 when missing/invalid", () => {
    const { access_token, refresh_token } = good;
    assert.equal(
      parseTokenResponse({ access_token, refresh_token }).expiresInSeconds,
      3600,
    );
  });
});

describe("discoverAuthServer", () => {
  it("uses RFC 8414 metadata endpoints when present", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: "https://as.example/authz",
          token_endpoint: "https://as.example/tok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    const endpoints = await discoverAuthServer("https://as.example", fetchImpl);
    assert.equal(endpoints.authorizationEndpoint, "https://as.example/authz");
    assert.equal(endpoints.tokenEndpoint, "https://as.example/tok");
  });

  it("falls back to conventional paths when metadata is missing", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const endpoints = await discoverAuthServer("https://x.example", fetchImpl);
    assert.equal(
      endpoints.authorizationEndpoint,
      "https://x.example/oauth/authorize",
    );
    assert.equal(endpoints.tokenEndpoint, "https://x.example/oauth/token");
  });

  it("falls back when the metadata document is malformed", async () => {
    const fetchImpl = (async () =>
      new Response("{not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const endpoints = await discoverAuthServer("https://z.example", fetchImpl);
    assert.equal(endpoints.tokenEndpoint, "https://z.example/oauth/token");
  });

  // JEN-306 — this used to fall back too, which made the probe a silent
  // reachability test the CLI then ignored: it printed an authorize URL it
  // could never redeem a code against.
  it("throws AuthServerUnreachableError when the metadata fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => discoverAuthServer("https://y.example", fetchImpl),
      (e: unknown) => {
        assert.ok(e instanceof AuthServerUnreachableError);
        assert.equal(e.status, null);
        assert.match(e.message, /ECONNREFUSED/);
        return true;
      },
    );
  });

  it("throws on statuses only an intermediary produces (401/403/407/5xx)", async () => {
    for (const status of [401, 403, 407, 500, 502]) {
      const fetchImpl = (async () =>
        new Response("<html>Forbidden</html>", {
          status,
          headers: { "Content-Type": "text/html" },
        })) as unknown as typeof fetch;
      await assert.rejects(
        () => discoverAuthServer("https://gw.example", fetchImpl),
        (e: unknown) => {
          assert.ok(
            e instanceof AuthServerUnreachableError,
            `status ${status} should be treated as unreachable`,
          );
          assert.equal(e.status, status);
          return true;
        },
      );
    }
  });

  it("still falls back on 404/410 — a bare deployment has no metadata", async () => {
    for (const status of [404, 410]) {
      const fetchImpl = (async () =>
        new Response("nope", { status })) as unknown as typeof fetch;
      const endpoints = await discoverAuthServer(
        "https://bare.example",
        fetchImpl,
      );
      assert.equal(
        endpoints.tokenEndpoint,
        "https://bare.example/oauth/token",
        `status ${status} must stay a fallback`,
      );
    }
  });
});

describe("postToken — who is at fault for a non-JSON body (JEN-306)", () => {
  const call = (status: number, body: string) =>
    exchangeCodeForTokens({
      tokenEndpoint: "https://as.example/oauth/token",
      clientId: "https://as.example/oauth/stacks-cli.json",
      code: "CODE",
      codeVerifier: "V".repeat(43),
      redirectUri: "http://127.0.0.1:8976/callback",
      fetchImpl: (async () =>
        new Response(body, {
          status,
          headers: { "Content-Type": "text/html" },
        })) as unknown as typeof fetch,
    });

  it("an HTML body on an error status is network_error, not the server's fault", async () => {
    // The exact shape a proxy/WAF returns: fetch RESOLVES, with a page.
    await assert.rejects(
      () => call(403, "<html>403 Forbidden</html>"),
      (e: unknown) => {
        assert.ok(e instanceof OAuthTokenError);
        assert.equal(e.oauthCode, "network_error");
        return true;
      },
    );
  });

  it("a non-JSON 200 is still the endpoint misbehaving (invalid_response)", async () => {
    await assert.rejects(
      () => call(200, "not json"),
      (e: unknown) => {
        assert.ok(e instanceof OAuthTokenError);
        assert.equal(e.oauthCode, "invalid_response");
        return true;
      },
    );
  });
});

describe("token endpoint calls (stubbed fetch)", () => {
  it("exchangeCodeForTokens posts the authorization_code grant", async () => {
    const captured: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured.push({ url, body: String(init.body) });
      return new Response(
        JSON.stringify({
          access_token: "tmo_new",
          refresh_token: "tmr_new",
          expires_in: 3600,
          scope: "read write",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const pair = await exchangeCodeForTokens({
      tokenEndpoint: "https://as.example/oauth/token",
      clientId: "https://as.example/oauth/stacks-cli.json",
      code: "AUTHCODE",
      codeVerifier: "VERIFIER",
      redirectUri: "http://127.0.0.1:8976/callback",
      fetchImpl,
    });
    assert.equal(pair.accessToken, "tmo_new");
    assert.equal(captured.length, 1);
    const body = new URLSearchParams(captured[0].body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "AUTHCODE");
    assert.equal(body.get("code_verifier"), "VERIFIER");
    assert.equal(body.get("redirect_uri"), "http://127.0.0.1:8976/callback");
    assert.equal(
      body.get("client_id"),
      "https://as.example/oauth/stacks-cli.json",
    );
  });

  it("refreshAccessToken posts the refresh_token grant", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(
        JSON.stringify({
          access_token: "tmo_r",
          refresh_token: "tmr_r",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await refreshAccessToken({
      tokenEndpoint: "https://as.example/oauth/token",
      clientId: "https://as.example/oauth/stacks-cli.json",
      refreshToken: "tmr_old",
      fetchImpl,
    });
    assert.equal(bodies.length, 1);
    const body = new URLSearchParams(bodies[0]);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "tmr_old");
  });

  it("maps an invalid_grant response to OAuthTokenError (exit-7 upstream)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "expired",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      await refreshAccessToken({
        tokenEndpoint: "https://as.example/oauth/token",
        clientId: "https://as.example/c.json",
        refreshToken: "tmr_dead",
        fetchImpl,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof OAuthTokenError);
      assert.equal(e.oauthCode, "invalid_grant");
    }
  });

  it("wraps a network failure as OAuthTokenError(network_error)", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    try {
      await refreshAccessToken({
        tokenEndpoint: "https://as.example/oauth/token",
        clientId: "https://as.example/c.json",
        refreshToken: "tmr_x",
        fetchImpl,
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof OAuthTokenError);
      assert.equal(e.oauthCode, "network_error");
    }
  });
});
