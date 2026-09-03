import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLI_VERSION } from "../src/client";
import {
  absoluteHookCommand,
  danglingCodexMarketplace,
  hookFilePath,
  isOwnInstalledPluginPath,
  isOwnStalePluginPath,
  persistentPluginRoot,
  runPluginInstall,
  samePluginPath,
  type PluginCommandDeps,
  type PluginInvocation,
} from "../src/commands/plugin";

const PACKAGE_ROOT = "/usr/lib/node_modules/@jentrix/cli";
// Open-client S3: the plugins are PACKAGES in the CLI's dependency tree,
// resolved by module resolution — an npm global install nests them here.
const PLUGIN_DIR = `${PACKAGE_ROOT}/node_modules/@jentrix/plugin-claude`;
const CODEX_PLUGIN_DIR = `${PACKAGE_ROOT}/node_modules/@jentrix/plugin-codex`;
const NODE = "/Users/dev/.nvm/versions/node/v22.22.0/bin/node";
const HOST_JS = `${PACKAGE_ROOT}/dist/session-host-main.js`;
const CLI_JS = `${PACKAGE_ROOT}/dist/main.js`;

/** The hooks.json both plugins ship: bare commands, resolved through PATH. */
function shippedHooks(provider: "claude" | "codex"): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `jentrix-session-host hook --provider ${provider} --event SessionStart`,
            },
          ],
        },
      ],
      PreCompact: [
        {
          hooks: [
            {
              type: "command",
              command: `jentrix-session-host hook --provider ${provider} --event PreCompact`,
              timeout: 10,
            },
            {
              type: "command",
              command: "jentrix session snapshot --event PreCompact",
              timeout: 10,
            },
          ],
        },
      ],
    },
  });
}

/** Every `command` string in a hooks.json, in document order. */
function commandsIn(text: string): string[] {
  const parsed = JSON.parse(text) as {
    hooks: Record<
      string,
      Array<{ hooks: Array<{ command: string; timeout?: number }> }>
    >;
  };
  return Object.values(parsed.hooks).flatMap((groups) =>
    groups.flatMap((g) => g.hooks.map((h) => h.command)),
  );
}

interface Call {
  file: string;
  args: string[];
}

/** A scripted result, or a SEQUENCE consumed call by call (the last repeats). */
type Scripted = PluginInvocation | PluginInvocation[];

/**
 * Deps with a scripted `claude` subprocess: `script` maps the joined argv to
 * its invocation result; anything unscripted succeeds. Every call is recorded.
 */
function makeDeps(
  overrides: Partial<PluginCommandDeps> = {},
  script: Record<string, Scripted> = {},
): {
  deps: PluginCommandDeps;
  calls: Call[];
  out: string[];
  err: string[];
  files: Map<string, string>;
} {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  // In-memory install: the CLI package, the two plugin PACKAGES with their
  // provider manifests and shipped hooks.json, and the built dist entries the
  // pin refuses to point at when they are missing.
  const files = new Map<string, string>([
    [
      `${PACKAGE_ROOT}/package.json`,
      '{"name":"@jentrix/cli","version":"0.6.7"}',
    ],
    [
      `${PLUGIN_DIR}/package.json`,
      '{"name":"@jentrix/plugin-claude","version":"0.5.5"}',
    ],
    [
      `${PLUGIN_DIR}/.claude-plugin/marketplace.json`,
      '{"name":"jentrix","plugins":[{"name":"jentrix","source":"./"}]}',
    ],
    [
      `${PLUGIN_DIR}/.claude-plugin/plugin.json`,
      '{"name":"jentrix","version":"0.5.5"}',
    ],
    [hookFilePath("claude", PLUGIN_DIR), shippedHooks("claude")],
    [
      `${CODEX_PLUGIN_DIR}/package.json`,
      '{"name":"@jentrix/plugin-codex","version":"0.2.8"}',
    ],
    [
      `${CODEX_PLUGIN_DIR}/.agents/plugins/marketplace.json`,
      '{"name":"jentrix","plugins":[{"name":"jentrix"}]}',
    ],
    [
      `${CODEX_PLUGIN_DIR}/plugins/jentrix/.codex-plugin/plugin.json`,
      '{"name":"jentrix","version":"0.2.8"}',
    ],
    [hookFilePath("codex", CODEX_PLUGIN_DIR), shippedHooks("codex")],
    [HOST_JS, "// built"],
    [CLI_JS, "// built"],
  ]);
  // A directory "exists" when a file lives under it — the ownership walk-up
  // and the staging probe both ask about directories.
  const exists = (path: string) =>
    files.has(path) || [...files.keys()].some((k) => k.startsWith(`${path}/`));
  return {
    files,
    deps: {
      resolvePluginDir: () => PLUGIN_DIR,
      resolveCodexPluginDir: () => CODEX_PLUGIN_DIR,
      cliPackageRoot: () => PACKAGE_ROOT,
      resolveClaude: async () => "/usr/local/bin/claude",
      resolveCodex: async () => "/usr/local/bin/codex",
      resolveSessionHostBin: async () => "/usr/local/bin/jentrix-session-host",
      nodeExecPath: () => NODE,
      fileExists: exists,
      readTextFile: (path) => files.get(path) ?? null,
      writeTextFile: (path, text) => {
        files.set(path, text);
      },
      invoke: async (file, args) => {
        calls.push({ file, args });
        const scripted = script[args.join(" ")];
        if (Array.isArray(scripted)) {
          return scripted.length > 1
            ? scripted.shift()!
            : (scripted[0] ?? { code: 0, stdout: "ok", stderr: "" });
        }
        return scripted ?? { code: 0, stdout: "ok", stderr: "" };
      },
      writeOut: (t) => out.push(t),
      writeErr: (t) => err.push(t),
      hasCredential: () => true,
      login: async () => 0,
      isInteractive: true,
      ...overrides,
    },
    calls,
    out,
    err,
  };
}

describe("runPluginInstall", () => {
  it("fresh machine: marketplace add + plugin install, in order", async () => {
    const { deps, calls, out } = makeDeps();
    assert.equal(await runPluginInstall(deps), 0);
    assert.deepEqual(
      calls.map((c) => c.args.join(" ")),
      [
        // JEN-297: the registry is read first (an unscripted "ok" here is a
        // Claude Code without --json — the plain add→update path follows).
        "plugin marketplace list --json",
        `plugin marketplace add ${PLUGIN_DIR}`,
        "plugin install jentrix@jentrix",
        // AGE-977: unconditional — it is the only proof of the version in place.
        "plugin update jentrix@jentrix",
        // Retiring the pre-rename plugin is the tail of every install.
        "plugin uninstall stacks@stacks",
        "plugin marketplace remove stacks",
      ],
    );
    assert.ok(calls.every((c) => c.file === "/usr/local/bin/claude"));
    assert.ok(out.some((l) => /Jentrix plugin ready/.test(l)));
    assert.ok(out.some((l) => /\/jentrix-align/.test(l)));
    assert.ok(out.some((l) => /\/jentrix-review/.test(l)));
  });

  it("retires the pre-rename plugin, last and only when it was there", async () => {
    // The old plugin registers the SAME six commands, and after the installer
    // drops the superseded npm package its marketplace dangles. Removal runs
    // AFTER the new plugin is in place, so a failure here cannot leave a
    // machine with neither.
    const { deps, calls, out } = makeDeps();
    assert.equal(await runPluginInstall(deps), 0);
    assert.deepEqual(
      calls.slice(-2).map((c) => c.args.join(" ")),
      ["plugin uninstall stacks@stacks", "plugin marketplace remove stacks"],
    );
    assert.ok(out.some((l) => /Removed the pre-rename plugin/.test(l)));
  });

  it("says nothing about a pre-rename plugin the machine never had", async () => {
    // The MARKETPLACE removal is the probe: silence here is the whole point,
    // since most machines are fresh and would otherwise be told about a
    // removal that did not happen.
    const { deps, out } = makeDeps(
      {},
      {
        "plugin uninstall stacks@stacks": {
          code: 1,
          stdout: "",
          stderr: "not installed",
        },
        "plugin marketplace remove stacks": {
          code: 1,
          stdout: "",
          stderr: "not configured",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    assert.ok(out.some((l) => /Jentrix plugin ready/.test(l)));
    assert.ok(!out.some((l) => /pre-rename/.test(l)));
  });

  it("codex: probes the marketplace, not its always-zero plugin remove", async () => {
    // `codex plugin remove <never-installed>` exits 0, so probing on it would
    // announce a removal on every fresh Codex machine.
    const { deps, out } = makeDeps(
      {},
      {
        "plugin marketplace list --json": [
          { code: 0, stdout: '{"marketplaces":[]}', stderr: "" },
          codexCatalog(CODEX_PLUGIN_DIR),
        ],
        "plugin list --json": {
          code: 0,
          stdout:
            '{"installed":[{"pluginId":"jentrix@jentrix","installed":true}]}',
          stderr: "",
        },
        "plugin remove stacks@stacks": { code: 0, stdout: "", stderr: "" },
        "plugin marketplace remove stacks": {
          code: 1,
          stdout: "",
          stderr: "not configured",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    assert.ok(!out.some((l) => /pre-rename/.test(l)));
    assert.ok(out.some((l) => /\$jentrix-review/.test(l)));
  });

  it("already installed: refreshes marketplace and updates the plugin", async () => {
    const { deps, calls, out } = makeDeps(
      {},
      {
        [`plugin marketplace add ${PLUGIN_DIR}`]: {
          code: 1,
          stdout: "",
          stderr: 'Marketplace "jentrix" already exists',
        },
        "plugin install jentrix@jentrix": {
          code: 1,
          stdout: "",
          stderr: "Plugin jentrix is already installed",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    assert.deepEqual(
      calls.map((c) => c.args.join(" ")),
      [
        "plugin marketplace list --json",
        `plugin marketplace add ${PLUGIN_DIR}`,
        "plugin marketplace update jentrix",
        "plugin install jentrix@jentrix",
        "plugin update jentrix@jentrix",
        "plugin uninstall stacks@stacks",
        "plugin marketplace remove stacks",
      ],
    );
    assert.ok(out.some((l) => /refreshed/.test(l)));
    assert.ok(out.some((l) => /this CLI's copy/.test(l)));
  });

  // -------------------------------------------------------------------------
  // JEN-297 — the Claude registry row decides the move, exactly as it does
  // for Codex. Observed live 2026-09-02: a machine that installed before the
  // 0.6.0 layout change still registered `…/@jentrix/cli/claude-plugin`, a
  // directory that no longer exists, and every `jentrix plugin install` /
  // `jentrix setup` dead-ended on `marketplace update` with no repair.
  // -------------------------------------------------------------------------

  /** The catalog as `claude plugin marketplace list --json` returns it. */
  function claudeCatalog(path: string | null, source = "directory") {
    return {
      code: 0,
      stdout: JSON.stringify([
        { name: "ponytail", source: "github", repo: "x/y" },
        ...(path === null && source === "directory"
          ? []
          : [
              {
                name: "jentrix",
                source,
                ...(path ? { path, installLocation: path } : {}),
              },
            ]),
      ]),
      stderr: "",
    };
  }

  it("Claude: a row already at THIS directory is refreshed, never removed", async () => {
    const { deps, calls, out } = makeDeps(
      {},
      {
        "plugin marketplace list --json": claudeCatalog(PLUGIN_DIR),
        [`plugin marketplace add ${PLUGIN_DIR}`]: {
          code: 1,
          stdout: "",
          stderr: 'Marketplace "jentrix" already exists',
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(!argv.includes("plugin marketplace remove jentrix"));
    assert.ok(argv.includes("plugin marketplace update jentrix"));
    assert.ok(out.some((l) => /refreshed/.test(l)));
  });

  it("Claude: a row at the pre-0.6.0 claude-plugin/ path of THIS install is repointed, and says so", async () => {
    const stale = "/usr/lib/node_modules/@jentrix/cli/claude-plugin";
    const { deps, calls, out, err } = makeDeps(
      {},
      {
        // First listing: the stale row. After the swap: the new path — the
        // activation proof the two-phase install insists on (S3).
        "plugin marketplace list --json": [
          claudeCatalog(stale),
          claudeCatalog(PLUGIN_DIR),
        ],
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(!err.some((l) => /PLUGIN_MARKETPLACE_CONFLICT/.test(l)));
    // remove BEFORE add — the add then lands fresh, no update needed.
    assert.ok(
      argv.indexOf("plugin marketplace remove jentrix") <
        argv.indexOf(`plugin marketplace add ${PLUGIN_DIR}`),
    );
    assert.ok(!argv.includes("plugin marketplace update jentrix"));
    assert.ok(
      out.some(
        (l) => l.includes("stale copy of this CLI") && l.includes(stale),
      ),
      out.join("\n"),
    );
  });

  it("Claude: a pruned _npx copy, an older nvm global or the pre-S3 bundled dir is repaired the same way", async () => {
    for (const stale of [
      "/home/u/.npm/_npx/9f/node_modules/@jentrix/cli/plugins/claude",
      "/home/u/.nvm/versions/node/v20.0.0/lib/node_modules/@jentrix/cli/plugins/claude",
      // The bundled directory a pre-S3 CLI shipped and this one no longer does.
      `${PACKAGE_ROOT}/plugins/claude`,
    ]) {
      const { deps, calls } = makeDeps(
        {},
        {
          "plugin marketplace list --json": [
            claudeCatalog(stale),
            claudeCatalog(PLUGIN_DIR),
          ],
        },
      );
      assert.equal(await runPluginInstall(deps), 0);
      assert.ok(
        calls
          .map((c) => c.args.join(" "))
          .includes("plugin marketplace remove jentrix"),
        stale,
      );
    }
  });

  it("Claude: a FOREIGN directory row is refused, nothing removed", async () => {
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": claudeCatalog(
          "/home/u/dev/my-own/claude-plugin",
        ),
      },
    );
    assert.equal(await runPluginInstall(deps), 2);
    assert.equal(calls.length, 1, "only the listing ran");
    assert.ok(err.some((l) => l.startsWith("PLUGIN_MARKETPLACE_CONFLICT")));
    assert.ok(err.some((l) => l.includes("/home/u/dev/my-own/claude-plugin")));
  });

  it("Claude: a github-sourced jentrix row is refused too", async () => {
    const { deps, err } = makeDeps(
      {},
      { "plugin marketplace list --json": claudeCatalog(null, "github") },
    );
    assert.equal(await runPluginInstall(deps), 2);
    assert.ok(err.some((l) => /non-local source/.test(l)));
  });

  it("Claude: an older claude without --json falls back to the add→update path", async () => {
    const { deps, calls } = makeDeps(
      {},
      {
        "plugin marketplace list --json": {
          code: 1,
          stdout: "",
          stderr: "error: unknown option '--json'",
        },
        [`plugin marketplace add ${PLUGIN_DIR}`]: {
          code: 1,
          stdout: "",
          stderr: 'Marketplace "jentrix" already exists',
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(argv.includes("plugin marketplace update jentrix"));
    assert.ok(!argv.includes("plugin marketplace remove jentrix"));
  });

  it("already installed but install EXITS 0: still updates (AGE-977)", async () => {
    // The real `claude plugin install` treats an already-installed plugin as a
    // benign no-op and exits 0, so keying the update off a FAILED install left
    // the operator on the old plugin while the CLI printed the ready banner.
    // Reproduced live on 2026-08-11: cli 0.4.19 vendored plugin 0.3.0 and the
    // cache stayed at 0.2.3 — no /jentrix-plan, no PreCompact hook.
    const { deps, calls, out } = makeDeps(
      {},
      {
        "plugin install jentrix@jentrix": {
          code: 0,
          stdout: "Plugin jentrix is already installed",
          stderr: "",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    assert.ok(
      calls.some((c) => c.args.join(" ") === "plugin update jentrix@jentrix"),
      "an update must run even when install succeeded as a no-op",
    );
    assert.ok(out.some((l) => /this CLI's copy/.test(l)));
  });

  it("fresh install still runs the update probe, and says nothing was pending", async () => {
    const { deps, calls } = makeDeps();
    assert.equal(await runPluginInstall(deps), 0);
    assert.ok(
      calls.some((c) => c.args.join(" ") === "plugin update jentrix@jentrix"),
      "the update probe is unconditional — it is the only thing that proves the version in place",
    );
  });

  it("claude missing: exit 2 with install pointer, no invocations", async () => {
    const { deps, calls, err } = makeDeps({ resolveClaude: async () => null });
    assert.equal(await runPluginInstall(deps), 2);
    assert.equal(calls.length, 0);
    assert.ok(err.some((l) => /^CLAUDE_NOT_INSTALLED/.test(l)));
  });

  it("session-host bin missing: warns with the global install command, still proceeds", async () => {
    const { deps, calls, out } = makeDeps({
      resolveSessionHostBin: async () => null,
    });
    assert.equal(await runPluginInstall(deps), 0);
    // v2 §18: no auto-install — the host ships inside @jentrix/cli itself.
    assert.ok(calls.every((c) => c.args[0] !== "install"));
    assert.ok(
      out.some((l) =>
        new RegExp(
          `^WARNING: .*jentrix-session-host.*npm install -g @jentrix/cli@${CLI_VERSION}`,
        ).test(l),
      ),
    );
  });

  it("session-host bin present: no warning", async () => {
    const { deps, out } = makeDeps();
    assert.equal(await runPluginInstall(deps), 0);
    assert.ok(!out.some((l) => l.startsWith("WARNING:")));
  });

  it("bundled assets missing: exit 1 with reinstall guidance", async () => {
    const { deps, err } = makeDeps({ resolvePluginDir: () => null });
    assert.equal(await runPluginInstall(deps), 1);
    assert.ok(err.some((l) => /^PLUGIN_ASSETS_MISSING/.test(l)));
  });

  it("no credentials + interactive: chains into the in-process login (AGE-952)", async () => {
    let loginRuns = 0;
    const { deps, out } = makeDeps({
      hasCredential: () => false,
      login: async () => {
        loginRuns += 1;
        return 0;
      },
    });
    assert.equal(await runPluginInstall(deps), 0);
    assert.equal(loginRuns, 1);
    assert.ok(out.some((l) => /connect you now/.test(l)));
  });

  it("no credentials + non-interactive: prints the login hint, never prompts", async () => {
    let loginRuns = 0;
    const { deps, out } = makeDeps({
      hasCredential: () => false,
      isInteractive: false,
      login: async () => {
        loginRuns += 1;
        return 0;
      },
    });
    assert.equal(await runPluginInstall(deps), 0);
    assert.equal(loginRuns, 0);
    assert.ok(out.some((l) => /run `jentrix login`/.test(l)));
  });

  it("a declined login leaves the install successful with a retry pointer", async () => {
    const { deps, out } = makeDeps({
      hasCredential: () => false,
      login: async () => 7,
    });
    assert.equal(await runPluginInstall(deps), 0);
    assert.ok(out.some((l) => /connect later with `jentrix login`/.test(l)));
  });

  it("credentials already configured: no login chain", async () => {
    let loginRuns = 0;
    const { deps } = makeDeps({
      login: async () => {
        loginRuns += 1;
        return 0;
      },
    });
    assert.equal(await runPluginInstall(deps), 0);
    assert.equal(loginRuns, 0);
  });

  it("a genuine subprocess failure surfaces claude's stderr and exits 1", async () => {
    const { deps, err } = makeDeps(
      {},
      {
        [`plugin marketplace add ${PLUGIN_DIR}`]: {
          code: 1,
          stdout: "",
          stderr: "permission denied",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 1);
    assert.ok(
      err.some((l) =>
        /PLUGIN_INSTALL_FAILED.*marketplace add.*permission denied/.test(l),
      ),
    );
  });

  it("installs and verifies the Codex plugin package", async () => {
    const { deps, calls, out } = makeDeps(
      {},
      {
        "plugin marketplace list --json": [
          { code: 0, stdout: '{"marketplaces":[]}', stderr: "" },
          codexCatalog(CODEX_PLUGIN_DIR),
        ],
        "plugin list --json": {
          code: 0,
          stdout:
            '{"installed":[{"pluginId":"jentrix@jentrix","installed":true}]}',
          stderr: "",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    assert.deepEqual(
      calls.map((c) => c.args.join(" ")),
      [
        "plugin marketplace list --json",
        `plugin marketplace add ${CODEX_PLUGIN_DIR} --json`,
        "plugin add jentrix@jentrix --json",
        // S3 activation proof: the row must name the directory we registered.
        "plugin marketplace list --json",
        "plugin list --json",
        "plugin remove stacks@stacks",
        "plugin marketplace remove stacks",
      ],
    );
    assert.ok(calls.every((c) => c.file === "/usr/local/bin/codex"));
    assert.ok(out.some((line) => line.includes("$jentrix-align")));
    assert.ok(out.some((line) => line.includes("/hooks")));
  });

  it("reuses the exact configured local Codex marketplace", async () => {
    const { deps, calls, out } = makeDeps(
      {},
      {
        "plugin marketplace list --json": {
          code: 0,
          stdout: JSON.stringify({
            marketplaces: [
              {
                name: "jentrix",
                marketplaceSource: {
                  sourceType: "local",
                  source: CODEX_PLUGIN_DIR,
                },
              },
            ],
          }),
          stderr: "",
        },
        "plugin list --json": {
          code: 0,
          stdout:
            '{"installed":[{"pluginId":"jentrix@jentrix","installed":true}]}',
          stderr: "",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    assert.equal(
      calls.some(
        (call) =>
          call.args.includes("add") && call.args.includes(CODEX_PLUGIN_DIR),
      ),
      false,
    );
    assert.ok(out.some((line) => line.includes("already points")));
  });

  it("refuses a conflicting Codex marketplace source", async () => {
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": {
          code: 0,
          stdout: JSON.stringify({
            marketplaces: [
              {
                name: "jentrix",
                marketplaceSource: {
                  sourceType: "local",
                  source: "/another/stacks",
                },
              },
            ],
          }),
          stderr: "",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 2);
    assert.equal(calls.length, 1);
    assert.ok(
      err.some((line) => line.startsWith("PLUGIN_MARKETPLACE_CONFLICT")),
    );
  });

  it("matches Windows verbatim (\\\\?\\) and case-folded marketplace paths", () => {
    const dir =
      "C:\\Users\\shati\\AppData\\Roaming\\npm\\node_modules\\@jentrix\\cli\\codex-plugin";
    // Codex stores Rust-canonicalized paths: verbatim prefix, possibly other case.
    assert.equal(samePluginPath(`\\\\?\\${dir}`, dir, true), true);
    assert.equal(samePluginPath(dir.toLowerCase(), dir, true), true);
    assert.equal(
      samePluginPath(
        "\\\\?\\UNC\\srv\\share\\cli",
        "\\\\srv\\share\\cli",
        true,
      ),
      true,
    );
    // A genuinely different directory is still a conflict.
    assert.equal(samePluginPath("C:\\other\\codex-plugin", dir, true), false);
    // POSIX stays case-sensitive and exact.
    assert.equal(samePluginPath("/a/./b", "/a/b", false), true);
    assert.equal(samePluginPath("/a/B", "/a/b", false), false);
  });

  it("reports a missing Codex executable", async () => {
    const { deps, calls, err } = makeDeps({ resolveCodex: async () => null });
    assert.equal(await runPluginInstall(deps, "codex"), 2);
    assert.equal(calls.length, 0);
    assert.ok(err.some((line) => line.startsWith("CODEX_NOT_INSTALLED")));
  });
});

describe("persistentPluginRoot", () => {
  const NPX_CACHE = "/home/dev/.npm/_npx/a1b2c3/node_modules/@jentrix/cli";
  const GLOBAL_MODULES = "/usr/lib/node_modules";
  const GLOBAL_PACKAGE = "/usr/lib/node_modules/@jentrix/cli";

  it("prefers the global package over the copy npx is running", () => {
    // The regression this exists for: `npx @jentrix/cli setup` would register
    // a Claude/Codex marketplace pointing INTO npm's _npx cache, which npm may
    // prune — leaving both runtimes with a plugin that fails to load.
    assert.equal(
      persistentPluginRoot(
        GLOBAL_MODULES,
        NPX_CACHE,
        (dir) => dir === GLOBAL_PACKAGE,
      ),
      GLOBAL_PACKAGE,
    );
  });

  it("falls back to the running module when no global copy is there yet", () => {
    assert.equal(
      persistentPluginRoot(GLOBAL_MODULES, NPX_CACHE, () => false),
      NPX_CACHE,
    );
    assert.equal(
      persistentPluginRoot(null, NPX_CACHE, () => true),
      NPX_CACHE,
    );
  });

  it("is identity for an ordinary global run, so the wiring can skip the override", () => {
    assert.equal(
      persistentPluginRoot(GLOBAL_MODULES, GLOBAL_PACKAGE, () => true),
      GLOBAL_PACKAGE,
    );
  });
});

// ---------------------------------------------------------------------------
// W3 / JEN-195 — the double run, and the row the installer may repair.
//
// Three places of prose asked every operator to remember never to re-run
// `jentrix setup`, on the strength of one pre-0.5.19 Windows observation, and
// no test proved the defect survived the `samePluginPath` fix. A macOS
// reproduction on cli 0.5.23 (four consecutive runs, two of them through the
// setup prompt's own `npx` command) left both registries untouched and
// correct; this is that reproduction as a test, so the claim can never again
// be carried forward by prose alone (C3.5).
// ---------------------------------------------------------------------------

/** The Codex catalog as `codex plugin marketplace list --json` returns it. */
function codexCatalog(source: string | null): PluginInvocation {
  return {
    code: 0,
    stdout: JSON.stringify({
      marketplaces:
        source === null
          ? []
          : [
              {
                name: "jentrix",
                marketplaceSource: { sourceType: "local", source },
              },
            ],
    }),
    stderr: "",
  };
}

const CODEX_INSTALLED: PluginInvocation = {
  code: 0,
  stdout: JSON.stringify({
    installed: [{ pluginId: "jentrix@jentrix", installed: true }],
  }),
  stderr: "",
};

describe("isOwnStalePluginPath — an earlier copy of THIS install (C3.3)", () => {
  // The in-memory install of makeDeps(): the plugin packages exist with their
  // package.json; every stale path below dangles.
  const probe = makeDeps().deps;

  it("accepts the claude-plugin sibling of the directory being registered", () => {
    assert.equal(
      isOwnStalePluginPath(PLUGIN_DIR, CODEX_PLUGIN_DIR, probe, false),
      true,
    );
    // Siblings hold for a dev checkout too — one package root either way.
    assert.equal(
      isOwnStalePluginPath(
        "/home/u/dev/task-manager/cli/claude-plugin",
        "/home/u/dev/task-manager/cli/codex-plugin",
        probe,
        false,
      ),
      true,
    );
  });

  it("accepts another COPY OF THE NPM PACKAGE when we are installing from one", () => {
    // npm's _npx cache — what `npx @jentrix/cli setup` registers from, and
    // what npm is free to prune afterwards.
    assert.equal(
      isOwnStalePluginPath(
        "/home/u/.npm/_npx/abc123/node_modules/@jentrix/cli/codex-plugin",
        CODEX_PLUGIN_DIR,
        probe,
        false,
      ),
      true,
    );
    // An older global after an nvm switch.
    assert.equal(
      isOwnStalePluginPath(
        "/home/u/.nvm/versions/node/v20.0.0/lib/node_modules/@jentrix/cli/codex-plugin",
        CODEX_PLUGIN_DIR,
        probe,
        false,
      ),
      true,
    );
    // Windows, verbatim-prefixed and differently cased.
    assert.equal(
      isOwnStalePluginPath(
        "\\\\?\\C:\\Users\\S\\AppData\\Roaming\\npm\\node_modules\\@Jentrix\\CLI\\codex-plugin",
        "C:\\Users\\S\\AppData\\Roaming\\npm\\node_modules\\@jentrix\\cli\\codex-plugin",
        probe,
        true,
      ),
      true,
    );
  });

  it("a DEV CHECKOUT never hijacks the global registration, or the reverse", () => {
    // Observed live 2026-08-27: an earlier draft asked only whether the
    // EXISTING row looked like ours, so `node cli/dist/main.js plugin install
    // codex` silently repointed the machine's real global row at the checkout.
    assert.equal(
      isOwnStalePluginPath(
        CODEX_PLUGIN_DIR,
        "/home/u/dev/task-manager/cli/codex-plugin",
        probe,
        false,
      ),
      false,
    );
    assert.equal(
      isOwnStalePluginPath(
        "/home/u/dev/task-manager/cli/codex-plugin",
        CODEX_PLUGIN_DIR,
        probe,
        false,
      ),
      false,
    );
  });

  it("refuses anything outside an @jentrix/cli package", () => {
    assert.equal(
      isOwnStalePluginPath("/another/stacks", CODEX_PLUGIN_DIR, probe, false),
      false,
    );
    assert.equal(
      isOwnStalePluginPath(
        "/home/u/dev/my-fork/codex-plugin",
        CODEX_PLUGIN_DIR,
        probe,
        false,
      ),
      false,
    );
    // A directory merely NAMED like ours is not ours.
    assert.equal(
      isOwnStalePluginPath(
        "/opt/jentrix/cli/codex-plugin",
        CODEX_PLUGIN_DIR,
        probe,
        false,
      ),
      false,
    );
  });
});

describe("isOwnInstalledPluginPath — the four global layouts (open-client S3)", () => {
  // One fixture per layout the migration must recognise, in both shapes: the
  // resolved plugin PACKAGE (exists, package.json names ours) and the pre-S3
  // bundled directory that dangles after the upgrade.
  const LAYOUTS = {
    "npm global": "/usr/lib/node_modules/@jentrix/cli",
    "Homebrew libexec":
      "/opt/homebrew/Cellar/jentrix/0.7.0/libexec/lib/node_modules/@jentrix/cli",
    "pnpm global":
      "/home/u/.local/share/pnpm/global/5/.pnpm/@jentrix+cli@0.6.7/node_modules/@jentrix/cli",
    "npx persistent root": "/home/u/.npm/_npx/9f/node_modules/@jentrix/cli",
  };
  // pnpm hoists the plugin package into its own virtual-store entry.
  const PNPM_PLUGIN =
    "/home/u/.local/share/pnpm/global/5/.pnpm/@jentrix+plugin-claude@0.5.5/node_modules/@jentrix/plugin-claude";

  function probeWith(entries: Record<string, string>) {
    const files = new Map(Object.entries(entries));
    return {
      fileExists: (path: string) =>
        files.has(path) ||
        [...files.keys()].some((k) => k.startsWith(`${path}/`)),
      readTextFile: (path: string) => files.get(path) ?? null,
    };
  }

  for (const [layout, root] of Object.entries(LAYOUTS)) {
    it(`${layout}: the resolved package and the dangling bundled dir are both ours`, () => {
      const pkg = `${root}/node_modules/@jentrix/plugin-claude`;
      const probe = probeWith({
        [`${pkg}/package.json`]: '{"name":"@jentrix/plugin-claude"}',
        [`${root}/package.json`]: '{"name":"@jentrix/cli"}',
      });
      assert.equal(isOwnInstalledPluginPath(pkg, probe, false), true, layout);
      // Dangling: the layout is the evidence.
      assert.equal(
        isOwnInstalledPluginPath(`${root}/plugins/claude`, probe, false),
        true,
        `${layout} dangling plugins/claude`,
      );
      assert.equal(
        isOwnInstalledPluginPath(`${root}/claude-plugin`, probe, false),
        true,
        `${layout} dangling pre-0.6.0`,
      );
    });
  }

  it("pnpm's virtual-store plugin entry is ours", () => {
    const probe = probeWith({
      [`${PNPM_PLUGIN}/package.json`]: '{"name":"@jentrix/plugin-claude"}',
    });
    assert.equal(isOwnInstalledPluginPath(PNPM_PLUGIN, probe, false), true);
  });

  it("a Windows npm global, verbatim-prefixed and differently cased, is ours", () => {
    assert.equal(
      isOwnInstalledPluginPath(
        "\\\\?\\C:\\Users\\S\\AppData\\Roaming\\npm\\node_modules\\@Jentrix\\CLI\\node_modules\\@jentrix\\plugin-claude",
        probeWith({}),
        true,
      ),
      true,
    );
  });

  it("an existing directory in our layout whose package.json names someone else is NOT ours", () => {
    const pkg =
      "/usr/lib/node_modules/@jentrix/cli/node_modules/@jentrix/plugin-claude";
    const probe = probeWith({
      [`${pkg}/package.json`]: '{"name":"acme-jentrix"}',
    });
    assert.equal(isOwnInstalledPluginPath(pkg, probe, false), false);
  });

  it("a dev checkout is never an installed copy, even with our package.json", () => {
    const dir = "/home/u/dev/task-manager/cli/plugins/claude";
    const probe = probeWith({
      [`${dir}/package.json`]: '{"name":"@jentrix/plugin-claude"}',
    });
    assert.equal(isOwnInstalledPluginPath(dir, probe, false), false);
  });
});

describe("two-phase install (open-client S3): stage, swap, prove, else restore", () => {
  /** The catalog as `claude plugin marketplace list --json` returns it. */
  const claudeCatalog = (path: string): PluginInvocation => ({
    code: 0,
    stdout: JSON.stringify([
      { name: "jentrix", source: "directory", path, installLocation: path },
    ]),
    stderr: "",
  });

  it("dry run resolves and stages the package, invokes nothing, needs no provider binary", async () => {
    const { deps, calls, out } = makeDeps({ resolveClaude: async () => null });
    assert.equal(await runPluginInstall(deps, "claude", { dryRun: true }), 0);
    assert.equal(calls.length, 0);
    const line = out.find((l) => l.startsWith("dry run: would register"));
    assert.ok(line, out.join("\n"));
    assert.ok(line.includes(PLUGIN_DIR));
    assert.ok(line.includes("plugin 0.5.5"));
    assert.ok(line.includes("3 hook commands"));
    assert.ok(line.includes(HOST_JS));
    // The shipped hooks.json is untouched by a dry run.
    assert.equal(
      deps.readTextFile(hookFilePath("claude", PLUGIN_DIR)),
      shippedHooks("claude"),
    );
  });

  it("codex dry run resolves the codex package", async () => {
    const { deps, calls, out } = makeDeps({ resolveCodex: async () => null });
    assert.equal(await runPluginInstall(deps, "codex", { dryRun: true }), 0);
    assert.equal(calls.length, 0);
    assert.ok(
      out.some(
        (l) => l.includes(CODEX_PLUGIN_DIR) && l.includes("plugin 0.2.8"),
      ),
    );
  });

  it("a staged package missing its manifest refuses before touching any registration", async () => {
    const { deps, calls, err, files } = makeDeps();
    files.delete(`${PLUGIN_DIR}/.claude-plugin/plugin.json`);
    assert.equal(await runPluginInstall(deps), 1);
    assert.equal(calls.length, 0);
    assert.ok(
      err.some(
        (l) => l.startsWith("PLUGIN_STAGE_FAILED") && l.includes("plugin.json"),
      ),
    );
  });

  it("Claude: a swap whose install fails restores the previous registration", async () => {
    const stale = `${PACKAGE_ROOT}/plugins/claude`;
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": claudeCatalog(stale),
        "plugin install jentrix@jentrix": {
          code: 1,
          stdout: "",
          stderr: "boom",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 1);
    const argv = calls.map((c) => c.args.join(" "));
    // remove old → add new → install (fails) → remove new → add OLD back.
    const failed = argv.indexOf("plugin install jentrix@jentrix");
    assert.ok(failed > argv.indexOf(`plugin marketplace add ${PLUGIN_DIR}`));
    assert.equal(argv[failed + 1], "plugin marketplace remove jentrix");
    assert.equal(argv[failed + 2], `plugin marketplace add ${stale}`);
    assert.ok(
      err.some(
        (l) =>
          l.includes("boom") &&
          l.includes(`previous registration at ${stale} was restored`),
      ),
    );
  });

  it("Claude: activation not proven after the swap → the previous registration is restored", async () => {
    const stale = `${PACKAGE_ROOT}/plugins/claude`;
    const { deps, calls, err } = makeDeps(
      {},
      {
        // The listing keeps naming the stale directory after the swap.
        "plugin marketplace list --json": claudeCatalog(stale),
      },
    );
    assert.equal(await runPluginInstall(deps), 1);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(
      err.some((l) => l.includes("activation not proven") && l.includes(stale)),
    );
    assert.equal(argv.at(-1), `plugin marketplace add ${stale}`);
    // The legacy cleanup never runs on a failed swap.
    assert.ok(!argv.includes("plugin uninstall stacks@stacks"));
  });

  it("Claude: a restore that itself fails is SAID, with the command to run by hand", async () => {
    const stale = `${PACKAGE_ROOT}/plugins/claude`;
    const { deps, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": claudeCatalog(stale),
        "plugin install jentrix@jentrix": {
          code: 1,
          stdout: "",
          stderr: "boom",
        },
        [`plugin marketplace add ${stale}`]: {
          code: 1,
          stdout: "",
          stderr: "gone",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 1);
    assert.ok(
      err.some(
        (l) =>
          l.includes("could NOT be restored") &&
          l.includes(`claude plugin marketplace add ${stale}`),
      ),
    );
  });

  it("Claude: without --json support the swap cannot be proven and is not attempted, as before", async () => {
    const { deps, calls } = makeDeps(
      {},
      {
        "plugin marketplace list --json": {
          code: 1,
          stdout: "",
          stderr: "unknown option",
        },
      },
    );
    assert.equal(await runPluginInstall(deps), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.equal(
      argv.filter((a) => a === "plugin marketplace list --json").length,
      1,
    );
  });

  it("Codex: a swap whose plugin add fails restores the previous registration", async () => {
    const stale = `${PACKAGE_ROOT}/plugins/codex`;
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": codexCatalog(stale),
        "plugin add jentrix@jentrix --json": {
          code: 1,
          stdout: "",
          stderr: "boom",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 1);
    const argv = calls.map((c) => c.args.join(" "));
    assert.equal(argv.at(-1), `plugin marketplace add ${stale} --json`);
    assert.ok(
      err.some((l) => l.includes("boom") && l.includes("was restored")),
    );
  });
});

describe("running `jentrix setup` twice (C3.5)", () => {
  it("Claude: the second run refreshes its own marketplace and never repoints it", async () => {
    // `claude plugin marketplace add` reports "already exists" on the re-run;
    // the installer refreshes rather than repointing, and the directory it
    // names is its OWN claude-plugin on both runs.
    const { deps, calls, out } = makeDeps(
      {},
      {
        [`plugin marketplace add ${PLUGIN_DIR}`]: {
          code: 1,
          stdout: "",
          stderr: "marketplace jentrix already exists",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "claude"), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(argv.includes(`plugin marketplace add ${PLUGIN_DIR}`));
    assert.ok(argv.includes("plugin marketplace update jentrix"));
    // Nothing ever hands the CLAUDE registry the codex-plugin directory…
    assert.ok(!argv.some((line) => line.includes(CODEX_PLUGIN_DIR)));
    assert.ok(out.some((l) => /already present — refreshed/.test(l)));
  });

  it("Codex: the second run finds its own row and leaves it alone — no conflict, no re-add", async () => {
    const { deps, calls, out, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": codexCatalog(CODEX_PLUGIN_DIR),
        "plugin list --json": CODEX_INSTALLED,
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(!err.some((l) => /PLUGIN_MARKETPLACE_CONFLICT/.test(l)));
    assert.ok(!argv.some((line) => line.startsWith("plugin marketplace add")));
    assert.ok(
      !argv.some((line) => line.includes("marketplace remove jentrix")),
    );
    // …and nothing ever hands the CODEX registry the claude-plugin directory.
    assert.ok(!argv.some((line) => line.includes(PLUGIN_DIR)));
    assert.ok(out.some((l) => /already points at/.test(l)));
  });

  it("Codex: a stale row pointing at OUR claude-plugin sibling is repaired, not refused (C3.3)", async () => {
    const { deps, calls, out, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": [
          codexCatalog(PLUGIN_DIR),
          codexCatalog(CODEX_PLUGIN_DIR),
        ],
        "plugin list --json": CODEX_INSTALLED,
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    const argv = calls.map((c) => c.args.join(" "));
    assert.ok(
      !err.some((l) => /PLUGIN_MARKETPLACE_CONFLICT/.test(l)),
      err.join("\n"),
    );
    assert.ok(argv.includes("plugin marketplace remove jentrix"));
    assert.ok(
      argv.includes(`plugin marketplace add ${CODEX_PLUGIN_DIR} --json`),
    );
    // It SAYS what it repaired — a silent repoint is the other way to be wrong.
    assert.ok(
      out.some(
        (l) => l.includes("stale copy of this CLI") && l.includes(PLUGIN_DIR),
      ),
      out.join("\n"),
    );
  });

  it("Codex: a pruned _npx copy is repaired the same way", async () => {
    const stale = "/home/u/.npm/_npx/9f/node_modules/@jentrix/cli/codex-plugin";
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": [
          codexCatalog(stale),
          codexCatalog(CODEX_PLUGIN_DIR),
        ],
        "plugin list --json": CODEX_INSTALLED,
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    assert.ok(!err.some((l) => /PLUGIN_MARKETPLACE_CONFLICT/.test(l)));
    assert.ok(
      calls
        .map((c) => c.args.join(" "))
        .includes("plugin marketplace remove jentrix"),
    );
  });

  it("Codex: a FOREIGN row is still refused, and nothing is removed", async () => {
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": codexCatalog(
          "/home/u/dev/my-own/codex-plugin",
        ),
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 2);
    assert.equal(calls.length, 1, "only the listing ran");
    assert.ok(err.some((l) => l.startsWith("PLUGIN_MARKETPLACE_CONFLICT")));
    assert.ok(err.some((l) => l.includes("/home/u/dev/my-own/codex-plugin")));
  });

  it("Codex: a non-local (git/url) row is still refused", async () => {
    const { deps, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": {
          code: 0,
          stdout: JSON.stringify({
            marketplaces: [
              {
                name: "jentrix",
                marketplaceSource: { sourceType: "git", source: "https://x/y" },
              },
            ],
          }),
          stderr: "",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 2);
    assert.ok(err.some((l) => l.startsWith("PLUGIN_MARKETPLACE_CONFLICT")));
  });
});

// ---------------------------------------------------------------------------
// JEN-305 — the hooks must resolve without a PATH.
//
// The bundled plugins ship bare commands, which resolve only for a process
// whose PATH carries this package's bin dir. A Claude Code launched from the
// macOS Dock inherits launchd's minimal PATH and no nvm, so its SessionStart
// hook resolved nothing and wrote no ledger line — silently, because Claude
// Code retains no hook stderr. `plugin install` therefore pins both commands
// to absolute paths BEFORE the marketplace call that snapshots the plugin into
// the by-version cache.
// ---------------------------------------------------------------------------
describe("absoluteHookCommand", () => {
  it("pins the session-host verb to node + the package's host entry", () => {
    assert.equal(
      absoluteHookCommand(
        "jentrix-session-host hook --provider claude --event SessionStart",
        NODE,
        HOST_JS,
        CLI_JS,
      ),
      `"${NODE}" "${HOST_JS}" hook --provider claude --event SessionStart`,
    );
  });

  it("pins the snapshot verb to the CLI entry, not the host entry", () => {
    assert.equal(
      absoluteHookCommand(
        "jentrix session snapshot --event PreCompact",
        NODE,
        HOST_JS,
        CLI_JS,
      ),
      `"${NODE}" "${CLI_JS}" session snapshot --event PreCompact`,
    );
  });

  // The property that lets `plugin install` run on every upgrade (and after an
  // nvm switch): rewriting an ALREADY-pinned command reproduces it exactly.
  it("is idempotent, and re-pins to a NEW node after an nvm switch", () => {
    const once = absoluteHookCommand(
      "jentrix-session-host hook --provider codex --event Stop",
      NODE,
      HOST_JS,
      CLI_JS,
    );
    assert.equal(absoluteHookCommand(once, NODE, HOST_JS, CLI_JS), once);
    const moved = "/Users/dev/.nvm/versions/node/v24.0.0/bin/node";
    assert.equal(
      absoluteHookCommand(once, moved, HOST_JS, CLI_JS),
      `"${moved}" "${HOST_JS}" hook --provider codex --event Stop`,
    );
  });

  // STA-131: the written form must stay valid on Windows, which has no POSIX
  // shell — so quoting, never `sh -c`, and never a `$HOME` that cannot expand.
  it("quotes a Windows path with spaces and emits no shell", () => {
    const win = "C:\\Program Files\\nodejs\\node.exe";
    const host = "C:\\Users\\dev\\AppData\\npm\\dist\\session-host-main.js";
    const pinned = absoluteHookCommand(
      "jentrix-session-host hook --provider claude --event SessionEnd",
      win,
      host,
      CLI_JS,
    );
    assert.equal(
      pinned,
      `"${win}" "${host}" hook --provider claude --event SessionEnd`,
    );
    assert.ok(!pinned.includes("sh -c"));
    assert.ok(!pinned.includes("$HOME"));
  });

  it("leaves a command it cannot parse, or cannot quote, exactly as it was", () => {
    assert.equal(
      absoluteHookCommand("some-other-tool --flag", NODE, HOST_JS, CLI_JS),
      "some-other-tool --flag",
    );
    // A path containing a double quote has no portable quoting; the bare
    // command still works wherever PATH carries the bin, so it is left alone.
    assert.equal(
      absoluteHookCommand(
        "jentrix-session-host hook --provider claude --event SessionStart",
        '/opt/we"ird/node',
        HOST_JS,
        CLI_JS,
      ),
      "jentrix-session-host hook --provider claude --event SessionStart",
    );
  });
});

describe("runPluginInstall · hook pinning (JEN-305)", () => {
  it("writes absolute quoted commands BEFORE the marketplace add", async () => {
    const { deps, calls, files, out } = makeDeps();
    assert.equal(await runPluginInstall(deps), 0);
    const commands = commandsIn(files.get(hookFilePath("claude", PLUGIN_DIR))!);
    assert.deepEqual(commands, [
      `"${NODE}" "${HOST_JS}" hook --provider claude --event SessionStart`,
      `"${NODE}" "${HOST_JS}" hook --provider claude --event PreCompact`,
      `"${NODE}" "${CLI_JS}" session snapshot --event PreCompact`,
    ]);
    for (const command of commands) {
      assert.ok(!command.includes("sh -c"), command);
      assert.ok(!command.includes("$HOME"), command);
      assert.ok(command.startsWith('"/'), command);
    }
    // The ordering that matters: Claude Code snapshots the plugin into its
    // by-version cache at add/update time, so a rewrite afterwards would land
    // only in the npm directory nobody executes.
    assert.ok(
      out.some((line) => line.includes("Hook commands pinned")),
      out.join("\n"),
    );
    assert.ok(
      calls.findIndex((c) =>
        c.args.join(" ").startsWith("plugin marketplace add"),
      ) >= 0,
    );
  });

  it("pins the Codex plugin's own hooks.json too", async () => {
    // The Codex branch reads two JSON registries before it installs; the
    // shared default ("ok") is not JSON, so both are scripted as the other
    // Codex tests in this file do (the second listing is the S3 activation
    // proof, so it names the registered directory).
    const { deps, files } = makeDeps(
      {},
      {
        "plugin marketplace list --json": [
          { code: 0, stdout: '{"marketplaces":[]}', stderr: "" },
          codexCatalog(CODEX_PLUGIN_DIR),
        ],
        "plugin list --json": {
          code: 0,
          stdout:
            '{"installed":[{"pluginId":"jentrix@jentrix","installed":true}]}',
          stderr: "",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0);
    const commands = commandsIn(
      files.get(hookFilePath("codex", CODEX_PLUGIN_DIR))!,
    );
    assert.deepEqual(commands, [
      `"${NODE}" "${HOST_JS}" hook --provider codex --event SessionStart`,
      `"${NODE}" "${HOST_JS}" hook --provider codex --event PreCompact`,
      `"${NODE}" "${CLI_JS}" session snapshot --event PreCompact`,
    ]);
  });

  it("a repeated install rewrites the file and keeps the timeouts", async () => {
    const { deps, files } = makeDeps();
    await runPluginInstall(deps);
    const first = files.get(hookFilePath("claude", PLUGIN_DIR))!;
    // Same in-memory package, installed again — an upgrade, or `jentrix setup`.
    const second = makeDeps();
    second.files.set(hookFilePath("claude", PLUGIN_DIR), first);
    await runPluginInstall(second.deps);
    assert.equal(second.files.get(hookFilePath("claude", PLUGIN_DIR)), first);
    // The rest of the hook entry survives the rewrite untouched.
    const parsed = JSON.parse(first) as {
      hooks: { PreCompact: Array<{ hooks: Array<{ timeout?: number }> }> };
    };
    assert.deepEqual(
      parsed.hooks.PreCompact[0]!.hooks.map((h) => h.timeout),
      [10, 10],
    );
  });

  it("refuses to pin at a dist/ that is not there, and says so", async () => {
    const { deps, files, out } = makeDeps();
    files.delete(HOST_JS); // a dev checkout with no build
    assert.equal(await runPluginInstall(deps), 0);
    // Unchanged: pinning to a missing file would break hooks that work today.
    assert.deepEqual(
      commandsIn(files.get(hookFilePath("claude", PLUGIN_DIR))!),
      [
        "jentrix-session-host hook --provider claude --event SessionStart",
        "jentrix-session-host hook --provider claude --event PreCompact",
        "jentrix session snapshot --event PreCompact",
      ],
    );
    assert.ok(
      out.some((l) => l.includes("carries no built dist/")),
      out.join("\n"),
    );
  });

  it("an unwritable install directory warns but still installs", async () => {
    const { deps, out } = makeDeps({
      writeTextFile: () => {
        throw new Error("EACCES");
      },
    });
    assert.equal(await runPluginInstall(deps), 0);
    assert.ok(
      out.some((l) => l.includes("is not writable")),
      out.join("\n"),
    );
  });
});

describe("Codex: a dangling row of ours that breaks the listing itself (open-client S3)", () => {
  // Observed on the round's own Mac: a pre-0.6.0 `codex-plugin` row made
  // `codex plugin marketplace list --json` exit 1 for EVERY marketplace, so
  // the installer could neither read nor repair the row it had written.
  const REFUSAL: PluginInvocation = {
    code: 1,
    stdout: "",
    stderr:
      "Error: failed to load marketplace(s):\n- `jentrix` at /usr/lib/node_modules/@jentrix/cli/codex-plugin: marketplace root does not contain a supported manifest",
  };

  it("removes the dangling row, re-lists, registers the package and proves it", async () => {
    const { deps, calls, out, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": [
          REFUSAL,
          codexCatalog(null),
          codexCatalog(CODEX_PLUGIN_DIR),
        ],
        "plugin list --json": CODEX_INSTALLED,
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 0, err.join("\n"));
    const argv = calls.map((c) => c.args.join(" "));
    assert.deepEqual(argv.slice(0, 4), [
      "plugin marketplace list --json",
      "plugin marketplace remove jentrix",
      "plugin marketplace list --json",
      `plugin marketplace add ${CODEX_PLUGIN_DIR} --json`,
    ]);
    assert.ok(
      out.some(
        (l) =>
          l.includes("could no longer load") &&
          l.includes("/usr/lib/node_modules/@jentrix/cli/codex-plugin"),
      ),
      out.join("\n"),
    );
  });

  it("a listing that fails for a FOREIGN dangling row is relayed, nothing removed", async () => {
    const { deps, calls, err } = makeDeps(
      {},
      {
        "plugin marketplace list --json": {
          code: 1,
          stdout: "",
          stderr:
            "Error: failed to load marketplace(s):\n- `jentrix` at /home/u/dev/my-own/codex-plugin: marketplace root does not contain a supported manifest",
        },
      },
    );
    assert.equal(await runPluginInstall(deps, "codex"), 1);
    assert.equal(calls.length, 1);
    assert.ok(err.some((l) => l.startsWith("PLUGIN_INSTALL_FAILED")));
  });

  it("parses the blamed directory out of Codex's refusal", () => {
    assert.equal(
      danglingCodexMarketplace(REFUSAL),
      "/usr/lib/node_modules/@jentrix/cli/codex-plugin",
    );
    assert.equal(
      danglingCodexMarketplace({ code: 1, stdout: "", stderr: "boom" }),
      null,
    );
  });
});
