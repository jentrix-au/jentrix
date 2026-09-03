import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  connectJentrixClientWithRefresh,
  DEAD_TOKEN_MESSAGE,
  maybeRefreshOAuthToken,
  unauthorizedMessage,
  REFRESH_SKEW_MS,
  RefreshFailedError,
  type JentrixClientHandle,
} from "../src/client";
import {
  readConfigFile,
  type ConfigFileReader,
  type ConfigFileWriter,
  type JentrixOAuthRecord,
} from "../src/config";

const PATH = "/home/u/.config/stacks/config.json";
const NOW = Date.parse("2026-07-09T12:00:00.000Z");

function memFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const reader: ConfigFileReader = {
    readFileSync(path: string) {
      const v = files.get(path);
      if (v === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return v;
    },
  };
  const writer: ConfigFileWriter = {
    mkdirSync() {},
    writeFileSync(path: string, data: string) {
      files.set(path, data);
    },
    chmodSync() {},
    renameSync(from: string, to: string) {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
  return { files, reader, writer };
}

/** A stub token endpoint that returns a fresh rotated pair and counts calls. */
function stubFetch(response: Record<string, unknown>, status = 200) {
  const state = { calls: 0, bodies: [] as string[] };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    state.calls += 1;
    state.bodies.push(String(init.body));
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

const baseOAuth = (expiresAt: string): JentrixOAuthRecord => ({
  refreshToken: "tmr_old",
  expiresAt,
  clientId: "https://tm.jentrix.ai/oauth/stacks-cli.json",
  tokenEndpoint: "https://tm.jentrix.ai/oauth/token",
  scope: "read write",
});

describe("maybeRefreshOAuthToken — freshness gating", () => {
  it("returns a PAT (no oauth record) unchanged, no fetch", async () => {
    const { fetchImpl, state } = stubFetch({});
    const token = await maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tm_pat",
      oauth: undefined,
      now: () => NOW,
      fetchImpl,
    });
    assert.equal(token, "tm_pat");
    assert.equal(state.calls, 0);
  });

  it("returns a still-fresh OAuth token unchanged, no fetch", async () => {
    const fs = memFs();
    const { fetchImpl, state } = stubFetch({});
    const future = new Date(NOW + 30 * 60 * 1000).toISOString(); // +30 min
    const token = await maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth: baseOAuth(future),
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    assert.equal(token, "tmo_current");
    assert.equal(state.calls, 0);
  });

  it("refreshes when inside the skew window (near expiry)", async () => {
    const fs = memFs();
    const { fetchImpl, state } = stubFetch({
      access_token: "tmo_fresh",
      refresh_token: "tmr_fresh",
      expires_in: 3600,
      scope: "read write",
    });
    // Expires 30s from now → within REFRESH_SKEW_MS (60s) → refresh.
    const nearExpiry = new Date(NOW + REFRESH_SKEW_MS / 2).toISOString();
    const token = await maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth: baseOAuth(nearExpiry),
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    assert.equal(token, "tmo_fresh");
    assert.equal(state.calls, 1);
  });
});

describe("maybeRefreshOAuthToken — rotation persistence", () => {
  it("persists the rotated pair atomically; old refresh token is gone", async () => {
    const fs = memFs({
      [PATH]: JSON.stringify({
        token: "tmo_current",
        url: "https://tm.jentrix.ai/api/mcp",
        defaults: { workspace: "acme" },
        oauth: baseOAuth("2020-01-01T00:00:00.000Z"), // long expired
      }),
    });
    const { fetchImpl, state } = stubFetch({
      access_token: "tmo_rotated",
      refresh_token: "tmr_rotated",
      expires_in: 3600,
      scope: "read write",
    });

    const token = await maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
      url: "https://tm.jentrix.ai/api/mcp",
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });

    assert.equal(token, "tmo_rotated");
    // Sent the OLD refresh token to rotate.
    const body = new URLSearchParams(state.bodies[0]);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "tmr_old");

    // The NEW pair is on disk; the OLD tokens are gone.
    const saved = readConfigFile(PATH, fs.reader);
    assert.equal(saved?.token, "tmo_rotated");
    assert.equal(saved?.oauth?.refreshToken, "tmr_rotated");
    // expiresAt advanced to ~now+3600s.
    assert.equal(
      saved?.oauth?.expiresAt,
      new Date(NOW + 3600 * 1000).toISOString(),
    );
    const raw = fs.files.get(PATH)!;
    assert.ok(!raw.includes("tmr_old"), "old refresh token persisted");
    assert.ok(!raw.includes("tmo_current"), "old access token persisted");
    // Unrelated field preserved.
    assert.deepEqual(saved?.defaults, { workspace: "acme" });
  });

  it("de-dupes concurrent refreshes of the same token (single-flight)", async () => {
    const fs = memFs();
    let resolve!: (r: Response) => void;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Promise<Response>((r) => {
        resolve = r;
      });
    }) as unknown as typeof fetch;

    const oauth = baseOAuth("2020-01-01T00:00:00.000Z");
    const p1 = maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth,
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    const p2 = maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth,
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    // Both awaits share ONE in-flight fetch.
    resolve(
      new Response(
        JSON.stringify({
          access_token: "tmo_shared",
          refresh_token: "tmr_shared",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const [t1, t2] = await Promise.all([p1, p2]);
    assert.equal(t1, "tmo_shared");
    assert.equal(t2, "tmo_shared");
    assert.equal(calls, 1, "only one network refresh for concurrent callers");
  });
});

describe("maybeRefreshOAuthToken — failure → relogin (exit 7 upstream)", () => {
  it("throws RefreshFailedError on invalid_grant (lost race / revoked)", async () => {
    const fs = memFs();
    const { fetchImpl } = stubFetch(
      { error: "invalid_grant", error_description: "already used" },
      400,
    );
    await assert.rejects(
      maybeRefreshOAuthToken({
        configPath: PATH,
        accessToken: "tmo_current",
        oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
        now: () => NOW,
        fetchImpl,
        io: { reader: fs.reader, writer: fs.writer },
      }),
      (e) =>
        e instanceof RefreshFailedError &&
        /run `jentrix login`/.test(e.message) &&
        /invalid_grant/.test(e.message),
    );
    // A failed refresh must NOT have written anything.
    assert.equal(fs.files.has(PATH), false);
  });

  it("throws RefreshFailedError on a network failure", async () => {
    const fs = memFs();
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await assert.rejects(
      maybeRefreshOAuthToken({
        configPath: PATH,
        accessToken: "tmo_current",
        oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
        now: () => NOW,
        fetchImpl,
        io: { reader: fs.reader, writer: fs.writer },
      }),
      RefreshFailedError,
    );
  });

  it("never leaks the refresh token into the error message", async () => {
    const fs = memFs();
    const { fetchImpl } = stubFetch({ error: "invalid_grant" }, 400);
    try {
      await maybeRefreshOAuthToken({
        configPath: PATH,
        accessToken: "tmo_current",
        oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
        now: () => NOW,
        fetchImpl,
        io: { reader: fs.reader, writer: fs.writer },
      });
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(!e.message.includes("tmr_old"), "refresh token leaked");
    }
  });
});

describe("connectJentrixClientWithRefresh — refresh + retry-once-on-401 (client.ts)", () => {
  const handle: JentrixClientHandle = {
    client: {} as never,
    close: async () => undefined,
  };

  it("PAT (no oauth): connects once, never refreshes", async () => {
    const connectCalls: string[] = [];
    const { fetchImpl, state } = stubFetch({});
    const h = await connectJentrixClientWithRefresh({
      url: "https://x/api/mcp",
      token: "tm_pat",
      oauth: undefined,
      configPath: PATH,
      connect: async (t) => {
        connectCalls.push(t.token);
        return handle;
      },
      now: () => NOW,
      fetchImpl,
    });
    assert.equal(h, handle);
    assert.deepEqual(connectCalls, ["tm_pat"]);
    assert.equal(state.calls, 0, "no refresh for a PAT");
  });

  it("expired OAuth token: refreshes THEN connects with the fresh token (retry-once path)", async () => {
    const fs = memFs();
    const connectCalls: string[] = [];
    const { fetchImpl, state } = stubFetch({
      access_token: "tmo_fresh",
      refresh_token: "tmr_fresh",
      expires_in: 3600,
    });
    const h = await connectJentrixClientWithRefresh({
      url: "https://x/api/mcp",
      token: "tmo_expired",
      oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
      configPath: PATH,
      connect: async (t) => {
        connectCalls.push(t.token);
        return handle;
      },
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    assert.equal(h, handle);
    assert.equal(state.calls, 1, "one proactive refresh");
    assert.deepEqual(
      connectCalls,
      ["tmo_fresh"],
      "connected with the fresh token",
    );
  });

  it("fresh token but connect 401s: force-refreshes ONCE and retries connect", async () => {
    const fs = memFs({
      [PATH]: JSON.stringify({
        token: "tmo_stale",
        oauth: baseOAuth(new Date(NOW + 30 * 60 * 1000).toISOString()), // "fresh"
      }),
    });
    const { fetchImpl, state } = stubFetch({
      access_token: "tmo_forced",
      refresh_token: "tmr_forced",
      expires_in: 3600,
    });
    let attempt = 0;
    const connectCalls: string[] = [];
    const h = await connectJentrixClientWithRefresh({
      url: "https://x/api/mcp",
      token: "tmo_stale",
      // clock says fresh → no proactive refresh; the 401 forces one.
      oauth: baseOAuth(new Date(NOW + 30 * 60 * 1000).toISOString()),
      configPath: PATH,
      connect: async (t) => {
        attempt += 1;
        connectCalls.push(t.token);
        if (attempt === 1)
          throw Object.assign(new Error("HTTP 401"), { code: 401 });
        return handle;
      },
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    assert.equal(h, handle);
    assert.equal(state.calls, 1, "exactly one forced refresh after the 401");
    assert.deepEqual(
      connectCalls,
      ["tmo_stale", "tmo_forced"],
      "retried with forced token",
    );
  });

  it("connect 401s a SECOND time (after refresh): the error propagates (retry is once)", async () => {
    const fs = memFs();
    const { fetchImpl } = stubFetch({
      access_token: "tmo_forced",
      refresh_token: "tmr_forced",
      expires_in: 3600,
    });
    let attempt = 0;
    await assert.rejects(
      connectJentrixClientWithRefresh({
        url: "https://x/api/mcp",
        token: "tmo_stale",
        oauth: baseOAuth(new Date(NOW + 30 * 60 * 1000).toISOString()),
        configPath: PATH,
        connect: async () => {
          attempt += 1;
          throw Object.assign(new Error("HTTP 401"), { code: 401 });
        },
        now: () => NOW,
        fetchImpl,
        io: { reader: fs.reader, writer: fs.writer },
      }),
      /401/,
    );
    assert.equal(attempt, 2, "connect attempted exactly twice (retry once)");
  });

  it("failed forced refresh → RefreshFailedError carrying the relogin message", async () => {
    const fs = memFs();
    const { fetchImpl } = stubFetch({ error: "invalid_grant" }, 400);
    await assert.rejects(
      connectJentrixClientWithRefresh({
        url: "https://x/api/mcp",
        token: "tmo_stale",
        oauth: baseOAuth(new Date(NOW + 30 * 60 * 1000).toISOString()),
        configPath: PATH,
        connect: async () =>
          Promise.reject(Object.assign(new Error("HTTP 401"), { code: 401 })),
        now: () => NOW,
        fetchImpl,
        io: { reader: fs.reader, writer: fs.writer },
      }),
      (e) =>
        e instanceof RefreshFailedError &&
        typeof e.reloginMessage === "string" &&
        /run `jentrix login`/.test(e.reloginMessage),
    );
  });

  it("non-401 connect error is NOT retried and propagates untouched", async () => {
    const fs = memFs();
    const { fetchImpl, state } = stubFetch({});
    let attempt = 0;
    await assert.rejects(
      connectJentrixClientWithRefresh({
        url: "https://x/api/mcp",
        token: "tmo_current",
        oauth: baseOAuth(new Date(NOW + 30 * 60 * 1000).toISOString()),
        configPath: PATH,
        connect: async () => {
          attempt += 1;
          throw new Error("ECONNREFUSED");
        },
        now: () => NOW,
        fetchImpl,
        io: { reader: fs.reader, writer: fs.writer },
      }),
      /ECONNREFUSED/,
    );
    assert.equal(attempt, 1, "no retry for a non-auth error");
    assert.equal(state.calls, 0, "no refresh for a non-auth error");
  });
});

// ---------------------------------------------------------------------------
// AGE-978 — a refresh rotates the TOKEN. It must not rewrite the config's
// `url`: `url` resolves flag > env > file, so persisting it turns a transient
// `--url <other>` into that config's permanent endpoint, leaving a valid token
// for one deployment aimed at another. Reproduced live 2026-08-11 on
// ~/test-1/.stacks/config.json — every later command 401'd while the token was
// fresh, and the error blamed the credential.
// ---------------------------------------------------------------------------

describe("maybeRefreshOAuthToken — the url is never rewritten (AGE-978)", () => {
  it("keeps the stored url when the caller resolved a DIFFERENT one", async () => {
    const fs = memFs({
      [PATH]: JSON.stringify({
        token: "tmo_current",
        url: "https://stacks-mvp.vercel.app/api/mcp",
        oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
      }),
    });
    const { fetchImpl } = stubFetch({
      access_token: "tmo_rotated",
      refresh_token: "tmr_rotated",
      expires_in: 3600,
      scope: "read write",
    });

    await maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
      // A one-off `--url` override on some unrelated command.
      url: "https://tm.jentrix.ai/api/mcp",
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });

    const saved = JSON.parse(fs.files.get(PATH)!) as Record<string, unknown>;
    assert.equal(
      saved.url,
      "https://stacks-mvp.vercel.app/api/mcp",
      "the transient override must not become the config's endpoint",
    );
    assert.equal(saved.token, "tmo_rotated", "the token still rotates");
  });

  it("adds no url to a config that never had one", async () => {
    const fs = memFs({
      [PATH]: JSON.stringify({
        token: "tmo_current",
        oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
      }),
    });
    const { fetchImpl } = stubFetch({
      access_token: "tmo_rotated",
      refresh_token: "tmr_rotated",
      expires_in: 3600,
      scope: "read write",
    });
    await maybeRefreshOAuthToken({
      configPath: PATH,
      accessToken: "tmo_current",
      oauth: baseOAuth("2020-01-01T00:00:00.000Z"),
      url: "https://tm.jentrix.ai/api/mcp",
      now: () => NOW,
      fetchImpl,
      io: { reader: fs.reader, writer: fs.writer },
    });
    const saved = JSON.parse(fs.files.get(PATH)!) as Record<string, unknown>;
    assert.equal(saved.url, undefined, "a refresh does not decide an endpoint");
  });
});

// ---------------------------------------------------------------------------
// AGE-978 part 2 — a config that ALREADY drifted stays broken until someone
// diagnoses it by hand, and the 401 sends them after the wrong thing. The
// token is neither dead nor expired; the file disagrees with itself.
// ---------------------------------------------------------------------------

describe("unauthorizedMessage (AGE-978)", () => {
  const oauth = {
    refreshToken: "tmr_x",
    expiresAt: "2030-01-01T00:00:00.000Z",
    clientId: "https://stacks-mvp.vercel.app/oauth/stacks-cli.json",
    tokenEndpoint: "https://stacks-mvp.vercel.app/oauth/token",
  };

  it("names the endpoint mismatch instead of blaming the credential", () => {
    const message = unauthorizedMessage(
      { url: "https://tm.jentrix.ai/api/mcp", oauth },
      "https://tm.jentrix.ai/api/mcp",
    );
    assert.match(message, /tm\.jentrix\.ai/);
    assert.match(message, /stacks-mvp\.vercel\.app/);
    assert.doesNotMatch(
      message,
      /mint a new PAT/,
      "the token is fine — sending them to mint one is the wrong repair",
    );
    assert.match(message, /jentrix login/);
  });

  it("falls back to the dead-token message when the origins agree", () => {
    assert.equal(
      unauthorizedMessage(
        { url: "https://stacks-mvp.vercel.app/api/mcp", oauth },
        "https://stacks-mvp.vercel.app/api/mcp",
      ),
      DEAD_TOKEN_MESSAGE,
    );
  });

  it("says nothing clever about a PAT, a missing config, or junk urls", () => {
    assert.equal(
      unauthorizedMessage(null, "https://x/api/mcp"),
      DEAD_TOKEN_MESSAGE,
    );
    assert.equal(
      unauthorizedMessage({}, "https://x/api/mcp"),
      DEAD_TOKEN_MESSAGE,
      "a PAT has no oauth record to disagree with",
    );
    assert.equal(
      unauthorizedMessage({ url: "not a url", oauth }, "not a url"),
      DEAD_TOKEN_MESSAGE,
    );
  });
});
