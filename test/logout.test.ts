import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runLogoutCommand, type LogoutDeps } from "../src/commands/logout";

const PATH = "/home/u/.config/stacks/config.json";

// logout uses the DEFAULT node:fs via clearOAuthSession(path). To keep the test
// hermetic we drive it through a real temp file.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tempConfig(contents: string | null): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "stacks-logout-"));
  const path = join(dir, "config.json");
  if (contents !== null) writeFileSync(path, contents, "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeDeps(configPath: string): {
  deps: LogoutDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    deps: {
      configPath,
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
    },
    out,
    err,
  };
}

describe("runLogoutCommand", () => {
  it("clears token + oauth, keeps other fields, reports success", () => {
    const { path, cleanup } = tempConfig(
      JSON.stringify({
        token: "tmo_secret",
        url: "https://x/api/mcp",
        defaults: { workspace: "acme" },
        oauth: {
          refreshToken: "tmr_secret",
          expiresAt: "2030-01-01T00:00:00.000Z",
          clientId: "https://x/oauth/stacks-cli.json",
          tokenEndpoint: "https://x/oauth/token",
        },
      }),
    );
    try {
      const { deps, out } = makeDeps(path);
      const code = runLogoutCommand(deps);
      assert.equal(code, 0);
      assert.ok(out.some((l) => /Signed out/.test(l)));
      const saved = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(saved.token, undefined);
      assert.equal(saved.oauth, undefined);
      assert.equal(saved.url, "https://x/api/mcp");
      assert.deepEqual(saved.defaults, { workspace: "acme" });
      // Secrets scrubbed from disk.
      const raw = readFileSync(path, "utf8");
      assert.ok(!raw.includes("tmo_secret"));
      assert.ok(!raw.includes("tmr_secret"));
    } finally {
      cleanup();
    }
  });

  it("missing config → 'already signed out', exit 0", () => {
    const { deps, out } = makeDeps(PATH); // path does not exist
    const code = runLogoutCommand(deps);
    assert.equal(code, 0);
    assert.ok(out.some((l) => /Already signed out/.test(l)));
  });

  it("config with no token → 'already signed out', exit 0", () => {
    const { path, cleanup } = tempConfig(
      JSON.stringify({ url: "https://x/api/mcp" }),
    );
    try {
      const { deps, out } = makeDeps(path);
      const code = runLogoutCommand(deps);
      assert.equal(code, 0);
      assert.ok(out.some((l) => /Already signed out/.test(l)));
    } finally {
      cleanup();
    }
  });

  it("malformed config file → exit 2, not a stack trace", () => {
    const { path, cleanup } = tempConfig("{ not json");
    try {
      const { deps, err } = makeDeps(path);
      const code = runLogoutCommand(deps);
      assert.equal(code, 2);
      assert.ok(err.some((l) => /not valid JSON/.test(l)));
    } finally {
      cleanup();
    }
  });
});
