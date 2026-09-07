import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLI_VERSION } from "../src/client";
import {
  classifyMarketplace,
  clientChecks,
  compareContract,
  hookCommands,
  installSource,
  pinnedHookTarget,
  type ClientProbeDeps,
} from "../src/commands/doctor-client";
import type { PluginInvocation } from "../src/commands/plugin";

// `jentrix session doctor`'s client half (open-client S5, PRD §7): source and
// versions, marketplace ownership, hook pinning + cache agreement, and the
// adopted contract against the served one — each classifier on fixtures, then
// the assembled checks on an in-memory install.

const ROOT = "/usr/lib/node_modules/@jentrix/cli";
const CLAUDE = `${ROOT}/node_modules/@jentrix/plugin-claude`;
const CODEX = `${ROOT}/node_modules/@jentrix/plugin-codex`;
const NODE = "/usr/bin/node";
const HOST = `${ROOT}/dist/session-host-main.js`;
const PINNED = `"${NODE}" "${HOST}" hook --provider claude --event SessionStart`;
const BARE = "jentrix-session-host hook --provider claude --event SessionStart";
const hooks = (command: string) =>
  JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command }] }] } });

describe("installSource", () => {
  it("names the four global layouts and a checkout", () => {
    assert.equal(installSource(ROOT), "npm global");
    assert.equal(
      installSource(
        "/opt/homebrew/Cellar/jentrix/0.7.0/libexec/lib/node_modules/@jentrix/cli",
      ),
      "Homebrew",
    );
    assert.equal(
      installSource(
        "/home/u/.local/share/pnpm/global/5/.pnpm/@jentrix+cli@0.6.7/node_modules/@jentrix/cli",
      ),
      "pnpm",
    );
    assert.equal(
      installSource("/home/u/.npm/_npx/9f/node_modules/@jentrix/cli"),
      "npx cache",
    );
    assert.equal(installSource("/home/u/dev/task-manager/cli"), "dev checkout");
    assert.equal(
      installSource(
        "C:\\Users\\S\\AppData\\Roaming\\npm\\node_modules\\@jentrix\\cli",
      ),
      "npm global",
    );
  });
});

describe("classifyMarketplace", () => {
  const probe = {
    fileExists: (p: string) => p.startsWith(CLAUDE) || p.startsWith(CODEX),
    readTextFile: (p: string) =>
      p === `${CLAUDE}/package.json`
        ? '{"name":"@jentrix/plugin-claude"}'
        : p === `${CODEX}/package.json`
          ? '{"name":"@jentrix/plugin-codex"}'
          : null,
  };
  it("distinguishes official, stale-official, user-managed, unregistered and unknown", () => {
    assert.equal(classifyMarketplace(CLAUDE, CLAUDE, probe), "official");
    assert.equal(
      classifyMarketplace(`${ROOT}/plugins/claude`, CLAUDE, probe),
      "official-stale",
    );
    assert.equal(
      classifyMarketplace("/home/u/dev/acme-jentrix", CLAUDE, probe),
      "user-managed",
    );
    assert.equal(classifyMarketplace(null, CLAUDE, probe), "unregistered");
    assert.equal(classifyMarketplace(undefined, CLAUDE, probe), "unknown");
  });
});

describe("hook pinning", () => {
  it("reads the pinned target off the first hook verb, or null when bare", () => {
    assert.equal(pinnedHookTarget(hookCommands(hooks(PINNED))!), HOST);
    assert.equal(pinnedHookTarget(hookCommands(hooks(BARE))!), null);
    assert.equal(hookCommands("not json"), null);
    assert.equal(hookCommands(null), null);
  });
});

describe("compareContract", () => {
  const adopted = {
    surface: "mvp",
    apiRelease: "1.2.0",
    digest: "a".repeat(64),
  };
  const served = (
    over: Partial<Parameters<typeof compareContract>[1] & object>,
  ) => ({
    surface: "mvp",
    apiRelease: "1.2.0",
    digest: "a".repeat(64),
    publicationState: "supported",
    supportedReleases: ["1.x"],
    ...over,
  });
  const at = "https://tm.example.test/api/mcp";

  it("equal digests are the tested contract", () => {
    const c = compareContract(adopted, served({}), at);
    assert.equal(c.status, "ok");
    assert.match(c.detail, /tested contract: mvp 1\.2\.0/);
  });
  it("a different digest inside the range is compatible drift, never a refusal", () => {
    const c = compareContract(
      adopted,
      served({ apiRelease: "1.3.0", digest: "b".repeat(64) }),
      at,
    );
    assert.equal(c.status, "warn");
    assert.match(c.detail, /compatible drift/);
    assert.match(c.detail, /newer tools are not generated locally/);
    assert.equal(c.fix, "upgrade the CLI: npm i -g @jentrix/cli");
  });
  it("a server behind the adopted release is drift that names the direction", () => {
    const c = compareContract(
      adopted,
      served({ apiRelease: "1.1.0", digest: "b".repeat(64) }),
      at,
    );
    assert.equal(c.status, "warn");
    assert.match(c.detail, /server is BEHIND/);
  });
  it("another surface, another major, or a withdrawn line are refusals", () => {
    assert.match(
      compareContract(adopted, served({ surface: "ops" }), at).detail,
      /SURFACE_MISMATCH/,
    );
    assert.equal(
      compareContract(
        adopted,
        served({ apiRelease: "2.0.0", digest: "c".repeat(64) }),
        at,
      ).status,
      "fail",
    );
    assert.match(
      compareContract(adopted, served({ supportedReleases: ["2.x"] }), at)
        .detail,
      /no longer supported/,
    );
  });
  it("a preview deployment is disclosed", () => {
    assert.match(
      compareContract(adopted, served({ publicationState: "preview" }), at)
        .detail,
      /publication state: preview/,
    );
  });
  it("no adopted contract and an unreachable endpoint are reported, not guessed", () => {
    assert.equal(compareContract(null, served({}), at).status, "fail");
    const c = compareContract(adopted, null, at);
    assert.equal(c.status, "warn");
    assert.match(c.detail, /could not read/);
  });
});

describe("clientChecks — an in-memory npm-global install", () => {
  const DIGEST = "d".repeat(64);
  const files = new Map<string, string>([
    [`${ROOT}/package.json`, '{"name":"@jentrix/cli"}'],
    [
      `${ROOT}/contract.json`,
      JSON.stringify({ surface: "mvp", apiRelease: "1.0.0", digest: DIGEST }),
    ],
    [
      `${CLAUDE}/package.json`,
      '{"name":"@jentrix/plugin-claude","version":"0.5.5"}',
    ],
    [`${CLAUDE}/.claude-plugin/plugin.json`, '{"version":"0.5.5"}'],
    [`${CLAUDE}/hooks/hooks.json`, hooks(PINNED)],
    [
      "/home/u/.claude/plugins/cache/jentrix/jentrix/0.5.5/hooks/hooks.json",
      hooks(PINNED),
    ],
    [
      `${CODEX}/package.json`,
      '{"name":"@jentrix/plugin-codex","version":"0.2.8"}',
    ],
    [
      `${CODEX}/plugins/jentrix/.codex-plugin/plugin.json`,
      '{"version":"0.2.7"}',
    ],
    [
      `${CODEX}/plugins/jentrix/hooks/hooks.json`,
      hooks(BARE.replace("claude", "codex")),
    ],
  ]);
  const ok = (stdout: string): PluginInvocation => ({
    code: 0,
    stdout,
    stderr: "",
  });
  const client: ClientProbeDeps = {
    cliPackageRoot: () => ROOT,
    resolvePluginDir: () => CLAUDE,
    resolveCodexPluginDir: () => CODEX,
    resolveClaude: async () => "/usr/local/bin/claude",
    resolveCodex: async () => null,
    invoke: async (_file, args) =>
      args.join(" ") === "plugin marketplace list --json"
        ? ok(
            JSON.stringify([
              { name: "jentrix", source: "directory", path: CLAUDE },
            ]),
          )
        : ok("ok"),
    fileExists: (p) =>
      files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    readTextFile: (p) => files.get(p) ?? null,
    homeDir: () => "/home/u",
  };

  it("reports versions with their source, ownership, pinning with cache agreement, and the contract", async () => {
    const checks = await clientChecks({
      client,
      resolveTarget: () => ({
        token: "tm_x",
        url: "https://tm.example.test/api/mcp",
      }),
      fetchImpl: (async (url: string | URL) => {
        assert.equal(String(url), "https://tm.example.test/api/mcp/contract");
        return new Response(
          JSON.stringify({
            surface: "mvp",
            apiRelease: "1.0.0",
            digest: DIGEST,
            publicationState: "supported",
            supportedReleases: ["1.x"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(by.cli!.status, "ok");
    assert.match(
      by.cli!.detail,
      new RegExp(
        `@jentrix/cli ${CLI_VERSION.replace(/\\./g, "\\\\.")} — npm global`,
      ),
    );
    assert.equal(by["plugin claude"]!.status, "ok");
    assert.match(by["plugin claude"]!.detail, /0\.5\.5 — npm global/);
    // codex: package 0.2.8 vs manifest 0.2.7 — two readers disagree.
    assert.equal(by["plugin codex"]!.status, "warn");
    assert.match(
      by["plugin codex"]!.detail,
      /package 0\.2\.8 vs manifest 0\.2\.7/,
    );
    assert.equal(by["marketplace claude"]!.status, "ok");
    assert.match(by["marketplace claude"]!.detail, /^Official: jentrix → /);
    assert.equal(by["marketplace codex"]!.status, "skip");
    assert.equal(by["hooks claude"]!.status, "ok");
    assert.match(
      by["hooks claude"]!.detail,
      /pinned to .*session-host-main\.js; the provider's cached copy matches/,
    );
    assert.equal(
      by["hooks codex"],
      undefined,
      "codex not installed → no hook check",
    );
    assert.equal(by.contract!.status, "ok");
    assert.match(by.contract!.detail, /tested contract: mvp 1\.0\.0/);
    assert.deepEqual((by.contract!.data as { adopted: unknown }).adopted, {
      surface: "mvp",
      apiRelease: "1.0.0",
      digest: DIGEST,
    });
  });

  it("a stale official row, an unpinned cache and a drifted endpoint are warnings with fixes", async () => {
    const drifted = new Map(files);
    drifted.set(
      "/home/u/.claude/plugins/cache/jentrix/jentrix/0.5.5/hooks/hooks.json",
      hooks(BARE),
    );
    const checks = await clientChecks({
      client: {
        ...client,
        readTextFile: (p) => drifted.get(p) ?? null,
        invoke: async (_file, args) =>
          args.join(" ") === "plugin marketplace list --json"
            ? ok(
                JSON.stringify([
                  {
                    name: "jentrix",
                    source: "directory",
                    path: `${ROOT}/plugins/claude`,
                  },
                ]),
              )
            : ok("ok"),
      },
      resolveTarget: () => ({
        token: "tm_x",
        url: "https://tm.example.test/api/mcp/",
      }),
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            surface: "mvp",
            apiRelease: "1.1.0",
            digest: "e".repeat(64),
            publicationState: "supported",
            supportedReleases: ["1.x"],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    const by = Object.fromEntries(checks.map((c) => [c.name, c]));
    assert.equal(by["marketplace claude"]!.status, "warn");
    assert.match(by["marketplace claude"]!.detail, /Official \(stale copy\)/);
    assert.equal(
      by["marketplace claude"]!.fix,
      "jentrix plugin install claude",
    );
    assert.equal(by["hooks claude"]!.status, "warn");
    assert.match(by["hooks claude"]!.detail, /cached copy DIFFERS/);
    assert.equal(by.contract!.status, "warn");
    assert.match(
      by.contract!.detail,
      /compatible drift: https:\/\/tm\.example\.test\/api\/mcp serves 1\.1\.0/,
    );
  });

  // JEN-466 — the codex marketplace row printed `Unknown: … exited 0: {`
  // (the first line of a pretty-printed catalog with no `jentrix` row) on
  // the Windows box, and `Unregistered` for a row Codex had left unlabeled.
  it("codex marketplace: the four listing states carry their evidence, and an unlabeled row is read by its root", async () => {
    const withListing = (listing: PluginInvocation) => ({
      ...client,
      resolveCodex: async () => "/usr/local/bin/codex",
      invoke: async (file: string, args: string[]) =>
        args.join(" ") === "plugin marketplace list --json"
          ? file === "/usr/local/bin/codex"
            ? listing
            : ok(
                JSON.stringify([
                  { name: "jentrix", source: "directory", path: CLAUDE },
                ]),
              )
          : ok("{}"),
    });
    const codexRow = async (listing: PluginInvocation) => {
      const checks = await clientChecks({
        client: withListing(listing),
        resolveTarget: () => {
          throw new Error("no token");
        },
      });
      return checks.find((c) => c.name === "marketplace codex")!;
    };

    const exited = await codexRow({
      code: 1,
      stdout: "",
      stderr: "boom\nsecond line",
    });
    assert.equal(exited.status, "warn");
    assert.equal(
      exited.detail,
      'Unknown: `codex plugin marketplace list --json` exited 1: "boom\\nsecond line"',
    );

    const notJson = await codexRow(ok('warning: x\n{"marketplaces":[]}'));
    assert.equal(notJson.status, "warn");
    assert.equal(
      notJson.detail,
      'Unknown: `codex plugin marketplace list --json` exited 0 but printed no JSON catalog — first 200 bytes: "warning: x\\n{\\"marketplaces\\":[]}"',
    );

    const noRow = await codexRow(
      ok(JSON.stringify({ marketplaces: [{ name: "acme", root: "/x" }] })),
    );
    assert.equal(noRow.status, "warn");
    assert.equal(
      noRow.detail,
      'Unregistered: `codex plugin marketplace list --json` lists no "jentrix" marketplace (present: acme)',
    );
    assert.equal(noRow.fix, "jentrix plugin install codex");

    const git = await codexRow(
      ok(
        JSON.stringify({
          marketplaces: [
            {
              name: "jentrix",
              root: "/home/u/.codex/.tmp/marketplaces/jentrix",
              marketplaceSource: { sourceType: "git", source: "https://x/y" },
            },
          ],
        }),
      ),
    );
    assert.equal(git.status, "warn");
    assert.match(
      git.detail,
      /^User-managed: `codex plugin marketplace list --json` lists "jentrix" at a non-local source — marketplaceSource: \{"sourceType":"git","source":"https:\/\/x\/y"\}, root: \/home\/u\/\.codex\/\.tmp\/marketplaces\/jentrix; not written by this CLI/,
    );

    // Codex reported no source for the row (the Windows shape): its root is
    // this package, so the row is official — and says how it was read.
    const unlabeled = await codexRow(
      ok(JSON.stringify({ marketplaces: [{ name: "jentrix", root: CODEX }] })),
    );
    assert.equal(unlabeled.status, "ok");
    assert.equal(
      unlabeled.detail,
      `Official: jentrix → ${CODEX} (its root; Codex reported no source for the row)`,
    );
  });

  it("without probes the doctor's list is untouched; without an endpoint the contract is skipped", async () => {
    assert.deepEqual(
      await clientChecks({ resolveTarget: () => ({ token: "", url: "" }) }),
      [],
    );
    const checks = await clientChecks({
      client,
      resolveTarget: () => {
        throw new Error("no token");
      },
    });
    const contract = checks.find((c) => c.name === "contract")!;
    assert.equal(contract.status, "skip");
    assert.equal(contract.fix, "jentrix login");
  });
});
