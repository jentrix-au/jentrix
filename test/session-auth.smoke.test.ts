import { isUnauthorizedError } from "../src/errors";
/**
 * Capture-off telemetry finding (2026-08-08, session cmsk80my000ib04jvsrvlzf9q):
 * the host's static bearer was revoked by a concurrent CLI rotation and the
 * completion 401'd, losing the whole usage rollup. These pin the recovery
 * contract: the host follows the CLI's config file, rotates when it must,
 * and adopts a concurrent winner's tokens when it loses the single-use race.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createConfigBearerSource,
  staticBearerSource,
} from "../src/session-host/session-auth.js";

function configFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "stacks-session-auth-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(contents), { mode: 0o600 });
  return path;
}

const OAUTH = {
  refreshToken: "tmr_old",
  expiresAt: "2026-08-08T10:26:56.000Z",
  clientId: "https://stacks.example/oauth/stacks-cli.json",
  tokenEndpoint: "https://stacks.example/oauth/token",
  scope: "read write",
};

test("get() follows the config file; fallback only when it has no token", () => {
  const path = configFile({ token: "tmo_current", oauth: OAUTH });
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_spawn",
  });
  assert.equal(source.get(), "tmo_current");
  writeFileSync(path, JSON.stringify({}));
  assert.equal(source.get(), "tmo_spawn");
  const missing = createConfigBearerSource({
    configPath: join(tmpdir(), "does-not-exist.json"),
    fallback: "tm_pat",
  });
  assert.equal(missing.get(), "tm_pat");
});

test("refresh() rotates via the token endpoint and persists the CLI-shaped record, preserving other fields", async () => {
  const path = configFile({
    token: "tmo_revoked",
    url: "https://stacks.example/api/mcp",
    installationId: "install-1",
    oauth: OAUTH,
  });
  const posts: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    posts.push({ url: String(url), body: String(init?.body) });
    return new Response(
      JSON.stringify({
        access_token: "tmo_new",
        refresh_token: "tmr_new",
        expires_in: 3600,
        scope: "read write",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_revoked",
    fetchImpl,
  });

  assert.equal(await source.refresh("tmo_revoked"), "tmo_new");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.url, OAUTH.tokenEndpoint);
  assert.match(posts[0]!.body, /grant_type=refresh_token/);
  assert.match(posts[0]!.body, /refresh_token=tmr_old/);

  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.token, "tmo_new");
  assert.equal(persisted.oauth.refreshToken, "tmr_new");
  assert.equal(persisted.oauth.clientId, OAUTH.clientId);
  assert.equal(persisted.oauth.tokenEndpoint, OAUTH.tokenEndpoint);
  // Unrelated fields survive the read-merge-write.
  assert.equal(persisted.url, "https://stacks.example/api/mcp");
  assert.equal(persisted.installationId, "install-1");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  // …and the follow-up get() serves the rotated token.
  assert.equal(source.get(), "tmo_new");
});

test("refresh() adopts a concurrent winner's token without touching the endpoint", async () => {
  const path = configFile({ token: "tmo_winner", oauth: OAUTH });
  let fetched = 0;
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_loser",
    fetchImpl: (async () => {
      fetched += 1;
      return new Response("{}", { status: 500 });
    }) as typeof fetch,
  });
  // The failed bearer differs from the file's current token — adopt, no POST.
  assert.equal(await source.refresh("tmo_loser"), "tmo_winner");
  assert.equal(fetched, 0);
});

test("refresh() losing the single-use race re-reads and adopts; a dead end returns null", async () => {
  const path = configFile({ token: "tmo_stale", oauth: OAUTH });
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_stale",
    fetchImpl: (async () => {
      // invalid_grant — but the "winner" persisted meanwhile:
      writeFileSync(
        path,
        JSON.stringify({ token: "tmo_from_winner", oauth: OAUTH }),
      );
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      });
    }) as typeof fetch,
  });
  assert.equal(await source.refresh("tmo_stale"), "tmo_from_winner");

  // No oauth record (bare PAT) → no recovery.
  const patPath = configFile({ token: "tm_pat" });
  const pat = createConfigBearerSource({
    configPath: patPath,
    fallback: "tm_pat",
  });
  assert.equal(await pat.refresh("tm_pat"), null);

  // Static source never recovers by contract.
  assert.equal(await staticBearerSource("tm_x").refresh("tm_x"), null);
});

test("F3: a fresh bearer that still 401s halts rotation instead of starving the shared chain", async () => {
  // The starvation shape: a host whose plan bearer belongs to deployment A
  // posts to deployment B — every refresh mints a genuinely fresh token that
  // B still rejects, rotating the SHARED CLI chain out from under a healthy
  // sibling on every heartbeat.
  const path = configFile({ token: "tmo_a1", oauth: OAUTH });
  let minted = 0;
  const lines: string[] = [];
  let clock = 1_000_000;
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_a1",
    log: (line) => lines.push(line),
    now: () => clock,
    fetchImpl: (async () => {
      minted += 1;
      return new Response(
        JSON.stringify({
          access_token: `tmo_a${minted + 1}`,
          refresh_token: `tmr_a${minted + 1}`,
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });

  // First 401: a normal refresh — this could be an ordinary expiry.
  assert.equal(await source.refresh("tmo_a1"), "tmo_a2");
  assert.equal(minted, 1);
  // The FRESH token 401s on the very next request: endpoint, not token.
  clock += 30_000; // one heartbeat later — well inside the fresh window
  assert.equal(await source.refresh("tmo_a2"), null);
  assert.equal(minted, 1, "no second rotation — the chain is left alone");
  assert.match(lines.join("\n"), /bearer halt/);
  // Halted stays halted: later failures never resume rotating.
  clock += 3_600_000;
  assert.equal(await source.refresh("tmo_a2"), null);
  assert.equal(minted, 1);
});

test("F3 guard: a produced bearer expiring much later refreshes normally", async () => {
  // The counter-case: token minted by this source legitimately expires an
  // hour on. That is ordinary expiry, not an endpoint mismatch — rotation
  // must continue.
  const path = configFile({ token: "tmo_b1", oauth: OAUTH });
  let minted = 0;
  let clock = 0;
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_b1",
    now: () => clock,
    fetchImpl: (async () => {
      minted += 1;
      return new Response(
        JSON.stringify({
          access_token: `tmo_b${minted + 1}`,
          refresh_token: `tmr_b${minted + 1}`,
          expires_in: 3600,
        }),
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assert.equal(await source.refresh("tmo_b1"), "tmo_b2");
  clock += 3_600_000; // an hour later — the token's own lifetime elapsed
  assert.equal(await source.refresh("tmo_b2"), "tmo_b3");
  assert.equal(minted, 2);
});

test("isUnauthorizedError matches the live failure shapes", () => {
  // The exact host.log line from the incident:
  assert.ok(
    isUnauthorizedError(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"No authorization provided"}',
      ),
    ),
  );
  assert.ok(isUnauthorizedError({ code: 401 }));
  assert.ok(isUnauthorizedError(new Error("Unauthorized")));
  assert.ok(!isUnauthorizedError(new Error("CONFLICT: stale write")));
});

test("host refuses a new endpoint's credentials and never rotates that chain", async () => {
  const path = configFile({ token: "tmo_old", oauth: OAUTH });
  let calls = 0;
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_old",
    fetchImpl: (async () => {
      calls++;
      throw new Error("must not fetch");
    }) as typeof fetch,
  });
  const foreign = JSON.stringify({
    token: "tmo_foreign",
    oauth: { ...OAUTH, tokenEndpoint: "https://foreign.example/token" },
  });
  writeFileSync(path, foreign);
  assert.equal(source.get(), "tmo_old");
  assert.equal(await source.refresh("tmo_old"), null);
  assert.equal(calls, 0);
  assert.equal(readFileSync(path, "utf8"), foreign);
});

test("host shares pending refreshes, uses its injected clock, and hides failed endpoint details", async () => {
  const path = configFile({ token: "tmo_old", oauth: OAUTH });
  let release!: (r: Response) => void;
  let calls = 0;
  const lines: string[] = [];
  const source = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_old",
    now: () => 100000,
    log: (line) => lines.push(line),
    fetchImpl: (async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as typeof fetch,
  });
  const a = source.refresh("tmo_old");
  const b = source.refresh("tmo_old");
  release(
    new Response(
      JSON.stringify({
        access_token: "tmo_new",
        refresh_token: "tmr_new",
        expires_in: 3600,
      }),
    ),
  );
  assert.deepEqual(await Promise.all([a, b]), ["tmo_new", "tmo_new"]);
  assert.equal(calls, 1);
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).oauth.expiresAt,
    new Date(3700000).toISOString(),
  );
  const failed = createConfigBearerSource({
    configPath: path,
    fallback: "tmo_new",
    log: (line) => lines.push(line),
    fetchImpl: (async () => {
      throw new Error("tmr_private_secret");
    }) as typeof fetch,
  });
  assert.equal(await failed.refresh("tmo_new"), null);
  assert.doesNotMatch(lines.join("\n"), /private_secret|tmo_new|tmr_new/);
  writeFileSync(path, '{"token":"tmo_private_secret"');
  assert.equal(await failed.refresh("tmo_new"), null);
});
