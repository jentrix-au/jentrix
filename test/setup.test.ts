import assert from "node:assert/strict";
import test from "node:test";

import {
  compareVersions,
  runSetupCommand,
  type SetupCommandDeps,
} from "../src/commands/setup";
import { CLI_VERSION } from "../src/client";

type Call = { file: string; args: string[] };

interface Harness extends SetupCommandDeps {
  out: string[];
  err: string[];
  calls: Call[];
  git_: Call[];
  appended: { path: string; text: string }[];
  written: { path: string; text: string }[];
  copied: { from: string; to: string }[];
  plugins: string[];
  logins: { url?: string; local?: boolean }[];
  prompts: string[];
}

/**
 * A machine with everything present and nothing configured: the fresh-install
 * path. Every test narrows it by override, so a test names only the fact it is
 * about.
 */
function deps(overrides: Partial<SetupCommandDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Call[] = [];
  const git_: Call[] = [];
  const appended: { path: string; text: string }[] = [];
  const written: { path: string; text: string }[] = [];
  const copied: { from: string; to: string }[] = [];
  const plugins: string[] = [];
  const logins: { url?: string; local?: boolean }[] = [];
  const prompts: string[] = [];
  let cliInstalled = false;

  const base: SetupCommandDeps = {
    globalInstall: async () => ({
      cliDir: cliInstalled ? "/usr/lib/node_modules/@jentrix/cli" : null,
      cliVersion: cliInstalled ? CLI_VERSION : null,
      binDir: "/usr/bin",
      binDirOnPath: true,
      runningFromGlobal: false,
    }),
    resolveNpm: async () => "/g/npm",
    resolveClaude: async () => "/g/claude",
    resolveCodex: async () => "/g/codex",
    resolveGit: async () => "/usr/bin/git",
    invoke: async () => ({ code: 0, stdout: "", stderr: "" }),
    installPlugin: async (provider) => {
      plugins.push(provider);
      return 0;
    },
    hasCredential: () => false,
    signedInUrl: () => "https://stacks-mvp.vercel.app/api/mcp",
    login: async (flags) => {
      logins.push(flags);
      return 0;
    },
    folderAlign: async () => 0,
    codexConfigPath: () => "/home/dev/.codex/config.toml",
    readTextFile: () => null,
    appendTextFile: (path, text) => appended.push({ path, text }),
    writeTextFile: (path, text) => written.push({ path, text }),
    copyFile: (from, to) => copied.push({ from, to }),
    now: () => new Date("2026-08-19T02:30:00.000Z"),
    cwd: () => "/home/dev/projects/My App",
    homeDir: () => "/home/dev",
    // Not a repository, and therefore no origin either.
    git: async () => ({ code: 1, stdout: "" }),
    readLine: async (prompt) => {
      prompts.push(prompt);
      return "";
    },
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    isInteractive: true,
    ...overrides,
  };
  // Recording WRAPS whatever a test supplied, rather than living inside the
  // default: an override that replaces `invoke` must not silently take the
  // call log — and the npm-install → on-PATH transition with it — down with
  // it. Two tests failed exactly that way while being written.
  const invoke = base.invoke;
  base.invoke = async (file, args, stdin, timeoutMs) => {
    calls.push({ file, args });
    if (file === "/g/npm" && args[0] === "install") {
      cliInstalled = true;
    }
    return invoke(file, args, stdin, timeoutMs);
  };
  const git = base.git;
  base.git = async (args, cwd) => {
    git_.push({ file: "git", args });
    return git(args, cwd);
  };
  return {
    ...base,
    out,
    err,
    calls,
    git_,
    appended,
    written,
    copied,
    plugins,
    logins,
    prompts,
  };
}

const npmArgs = (d: Harness) =>
  d.calls.filter((c) => c.file === "/g/npm").map((c) => c.args);

test("a fresh machine drops the superseded pair BEFORE installing (EEXIST)", async () => {
  // @jentrix/stacks-cli / @jentrix/stacks-runner (<= 0.5.2) own the `stacks`
  // and `stacks-runner` bins; npm fails the WHOLE install with EEXIST rather
  // than overwrite a bin owned by another package, so the order is the fix.
  const d = deps();
  assert.equal(await runSetupCommand({}, d), 0);
  const [rm, install] = npmArgs(d);
  assert.deepEqual(rm, [
    "rm",
    "-g",
    "@jentrix/stacks-cli",
    "@jentrix/stacks-runner",
  ]);
  assert.equal(install![0], "install");
  assert.ok(install!.some((a) => a.startsWith("@jentrix/cli@")));
  // v2 §18: the session host ships inside the CLI — no runner install.
  assert.ok(!install!.some((a) => a.startsWith("@jentrix/runner@")));
});

test("a CURRENT global install is left alone rather than reinstalled", async () => {
  // Same version — nothing to do. (Stale installs upgrade; see below.)
  const d = deps({
    globalInstall: async () => ({
      cliDir: "/usr/lib/node_modules/@jentrix/cli",
      binDir: "/usr/bin",
      binDirOnPath: true,
      cliVersion: CLI_VERSION,
      runningFromGlobal: false,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.deepEqual(npmArgs(d), []);
  assert.ok(d.out.some((l) => /already installed/.test(l)));
  assert.ok(d.out.some((l) => /npm update -g @jentrix\/cli/.test(l)));
});

test("a failed npm install stops setup and relays npm's own output", async () => {
  const d = deps({
    invoke: async (_file, args) =>
      args[0] === "install"
        ? { code: 1, stdout: "", stderr: "EACCES: permission denied" }
        : { code: 0, stdout: "", stderr: "" },
  });
  assert.equal(await runSetupCommand({}, d), 1);
  assert.ok(d.err.some((l) => /TOOLCHAIN_INSTALL_FAILED/.test(l)));
  assert.ok(d.err.some((l) => /EACCES: permission denied/.test(l)));
  assert.deepEqual(d.plugins, []);
});

test("npm reporting success while installing nothing is a failure", async () => {
  // Re-read the global root rather than trust the exit code: a misconfigured
  // prefix lets `npm install -g` exit 0 having left nothing resolvable.
  const d = deps({
    globalInstall: async () => ({
      cliDir: null,
      binDir: "/usr/bin",
      binDirOnPath: true,
      cliVersion: CLI_VERSION,
      runningFromGlobal: false,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 1);
  assert.ok(d.err.some((l) => /not under `npm root -g`/.test(l)));
});

test("the install decision reads the global root, NEVER a jentrix on PATH", async () => {
  // The bug this exists for: `npx @jentrix/cli setup` — the documented entry
  // point — runs with npm's _npx cache prepended to PATH, and that cache holds
  // a `jentrix` shim. The old check probed PATH, so it found that shim, said
  // "already installed", skipped the npm step entirely, and exited 0 on a
  // machine with nothing installed. Reported from Windows on 0.5.6.
  //
  // There is deliberately no PATH input to this decision any more: an empty
  // `cliDir` MUST install, whatever any shim on PATH suggests.
  const d = deps();
  assert.equal(await runSetupCommand({}, d), 0);
  assert.ok(
    npmArgs(d).some((a) => a[0] === "install"),
    "a machine with no global package must install, not report success",
  );
});

test("an installed-but-unreachable toolchain says so, with the directory", async () => {
  // The operator's half of the same report: `jentrix --version` came back
  // "not recognized" in a fresh PowerShell. Setup cannot see their next shell,
  // but it CAN see that npm's global bin is missing from PATH — and npx only
  // prepends, so this still answers for them.
  const d = deps({
    globalInstall: async () => ({
      cliDir: "/usr/lib/node_modules/@jentrix/cli",
      binDir: "C:\\Users\\dev\\AppData\\Roaming\\npm",
      binDirOnPath: false,
      cliVersion: CLI_VERSION,
      runningFromGlobal: false,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 0);
  const out = d.out.join("\n");
  assert.match(out, /global bin directory is NOT on your PATH/);
  assert.match(out, /AppData\\Roaming\\npm/);
  assert.match(out, /will not be found in a new/);
});

test("a reachable install says nothing about PATH", async () => {
  const d = deps();
  await runSetupCommand({}, d);
  assert.ok(!/NOT on your PATH/.test(d.out.join("\n")));
});

test("setup never installs @jentrix/runner (v2: the host ships in the CLI)", async () => {
  // Pre-v2 this path ensured a runner install; the session host now ships
  // inside @jentrix/cli, so no second package is ever pulled — even on a
  // machine with neither provider runtime.
  const d = deps({
    resolveClaude: async () => null,
    resolveCodex: async () => null,
    globalInstall: async () => ({
      cliDir: "/usr/lib/node_modules/@jentrix/cli",
      binDir: "/usr/bin",
      binDirOnPath: true,
      cliVersion: CLI_VERSION,
      runningFromGlobal: false,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.ok(
    !npmArgs(d).some((a) =>
      a.some((x) => x.startsWith("@jentrix/runner@")),
    ),
  );
});

test("it registers the plugin for each runtime present and notes each absent one", async () => {
  const d = deps({ resolveCodex: async () => null });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.deepEqual(d.plugins, ["claude"]);
  assert.ok(d.out.some((l) => /`codex` CLI is not installed/.test(l)));
  assert.ok(!d.out.some((l) => /`claude` CLI was not found/.test(l)));
});

// STA-133 — on a machine where Claude Code IS installed but the terminal's
// PATH predates it, "not installed" misleads and the silent plugin skip later
// reads as a spawn bug. The skip must name the actual repair.
test("a missing claude names the stale-PATH repair, not just 'install it'", async () => {
  const d = deps({ resolveClaude: async () => null });
  await runSetupCommand({}, d);
  assert.ok(d.out.some((l) => /`claude` CLI was not found/.test(l)));
  assert.ok(d.out.some((l) => /PATH may predate the install/.test(l)));
  assert.ok(d.out.some((l) => /jentrix plugin install claude/.test(l)));
});

test("a plugin that fails to install is NAMED and fails the run — for EITHER runtime", async () => {
  // The regression this exists for, in full: the Claude arm discarded
  // `installPlugin`'s exit code while the Codex arm checked it, so a Windows
  // machine whose Claude plugin never installed saw `setup` exit 0 with no
  // note — and Claude Code still showing only the pre-rename `stacks@stacks`
  // plugin. Both runtimes are asserted, because fixing one arm is what
  // produced the bug the first time.
  for (const broken of ["claude", "codex"] as const) {
    const d = deps({
      installPlugin: async (provider) => (provider === broken ? 1 : 0),
    });
    assert.equal(
      await runSetupCommand({}, d),
      1,
      `${broken}: a failed plugin must not exit 0`,
    );
    const out = d.out.join("\n");
    assert.match(
      out,
      new RegExp(`the ${broken} plugin did NOT install`),
      `${broken}: the failure must be named`,
    );
    assert.match(
      out,
      new RegExp(`jentrix plugin install ${broken}`),
      `${broken}: the operator needs the command that shows why`,
    );
    // The rest of setup still ran — a plugin failure is not an abort.
    assert.match(out, /Done\. Verify with: jentrix whoami/);
  }
});

test("a clean run still exits 0 and names no failure", async () => {
  const d = deps();
  assert.equal(await runSetupCommand({}, d), 0);
  assert.ok(!/did NOT install/.test(d.out.join("\n")));
});

test("it connects when no credential exists, passing the flags through", async () => {
  const d = deps();
  await runSetupCommand({ url: "https://x.dev/api/mcp", local: true }, d);
  assert.deepEqual(d.logins, [{ url: "https://x.dev/api/mcp", local: true }]);
});

test("it never prompts for sign-in on a machine that already has a token", async () => {
  const d = deps({ hasCredential: () => true });
  await runSetupCommand({}, d);
  assert.deepEqual(d.logins, []);
});

test("non-interactive says what to run instead of prompting for anything", async () => {
  const d = deps({ isInteractive: false });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.deepEqual(d.logins, []);
  assert.deepEqual(d.prompts, []);
  // The repository is probed read-only, never touched.
  assert.deepEqual(d.git_, [
    { file: "git", args: ["rev-parse", "--is-inside-work-tree"] },
  ]);
  assert.ok(d.out.some((l) => /run `jentrix login` \(interactive\)/.test(l)));
  // Not a repo and nobody to ask: the skip must say so instead of leaving
  // "Next: align" pointing at a folder align will refuse.
  assert.ok(d.out.some((l) => /Run `git init` here first/.test(l)));
  // D11: baseline setup registers NO native MCP — the Codex entry lands
  // only under --native-mcp (or `jentrix mcp enable codex`).
  assert.equal(d.appended.length, 0);
});

test("non-interactive stays quiet about the repository when there already is one", async () => {
  const d = deps({
    isInteractive: false,
    git: async () => ({ code: 0, stdout: "" }),
  });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.deepEqual(d.prompts, []);
  assert.ok(!d.out.some((l) => /git init/.test(l)));
});

test("Codex gets a sign-in entry with no token to export (--native-mcp)", async () => {
  const d = deps();
  await runSetupCommand({ nativeMcp: true }, d);
  assert.equal(d.appended.length, 1);
  const toml = d.appended[0]!.text;
  assert.match(toml, /\[mcp_servers\.jentrix\]/);
  assert.match(toml, /url = "https:\/\/stacks-mvp\.vercel\.app\/api\/mcp"/);
  assert.ok(!/bearer_token_env_var/.test(toml));
  // Appending a table at EOF is only valid TOML if it starts on its own line.
  assert.ok(toml.startsWith("\n"));
  assert.ok(toml.endsWith("\n"));
  assert.deepEqual(d.copied, []); // nothing to back up on a first install
});

test("an explicit --url governs both Codex and checkout MCP configs", async () => {
  const requested = "https://self-hosted.example/api/mcp";
  const d = deps({ git: inRepo });
  await runSetupCommand({ url: requested, nativeMcp: true }, d);

  assert.ok(d.appended[0]!.text.includes(requested));
  assert.ok(d.written[0]!.text.includes(requested));
  assert.ok(!d.appended[0]!.text.includes(SIGNED_IN));
  assert.ok(!d.written[0]!.text.includes(SIGNED_IN));
});

test("an invalid --url stops before installs or config writes", async () => {
  const d = deps();
  assert.equal(await runSetupCommand({ url: "not a url" }, d), 2);
  assert.deepEqual(d.calls, []);
  assert.deepEqual(d.appended, []);
  assert.deepEqual(d.written, []);
  assert.ok(d.err.some((line) => line.startsWith("INVALID_URL")));
});

test("a Codex too old for `mcp login` gets the PAT entry and the manual steps", async () => {
  const d = deps({
    invoke: async (file, args) => ({
      code:
        file === "/g/codex" && args[1] === "login" && args[2] === "--help"
          ? 1
          : 0,
      stdout: "",
      stderr: "",
    }),
  });
  await runSetupCommand({ nativeMcp: true }, d);
  const toml = d.appended[0]!.text;
  assert.match(toml, /bearer_token_env_var = "STACKS_CODEX_TOKEN"/);
  assert.ok(
    d.out.some((l) => /\/account\/tokens/.test(l)),
    "the operator is told where to mint the token",
  );
  assert.ok(
    d.out.some((l) => /deliberately not STACKS_TOKEN/.test(l)),
    "and warned off the variable that would override the CLI's own login",
  );
});

test("an existing Codex entry is never rewritten, under EITHER key", async () => {
  for (const key of ["jentrix", "stacks"]) {
    const d = deps({
      readTextFile: () =>
        `[mcp_servers.${key}]\nurl = "https://other.dev/api/mcp"\n`,
    });
    await runSetupCommand({ nativeMcp: true }, d);
    assert.deepEqual(d.appended, [], `${key}: config must be untouched`);
    assert.deepEqual(d.copied, []);
    assert.ok(d.out.some((l) => l.includes(`[mcp_servers.${key}]`)));
  }
});

test("an existing config is backed up before the entry is appended", async () => {
  const d = deps({ readTextFile: () => "[mcp_servers.other]\n" });
  await runSetupCommand({ nativeMcp: true }, d);
  assert.deepEqual(d.copied, [
    {
      from: "/home/dev/.codex/config.toml",
      to: "/home/dev/.codex/config.toml.bak-jentrix-20260819023000",
    },
  ]);
  assert.equal(d.appended.length, 1);
});

test("no endpoint to register means no Codex entry, and it says why", async () => {
  const d = deps({ signedInUrl: () => null });
  await runSetupCommand({ nativeMcp: true }, d);
  assert.deepEqual(d.appended, []);
  assert.ok(d.out.some((l) => /not signed in yet/.test(l)));
});

test("the git bootstrap initializes and adds an owner/name origin", async () => {
  let initialized = false;
  const d = deps({
    git: async (args) => {
      if (args[0] === "rev-parse")
        return { code: initialized ? 0 : 1, stdout: "" };
      if (args[0] === "init") {
        initialized = true;
        return { code: 0, stdout: "" };
      }
      if (args[1] === "get-url") return { code: 1, stdout: "" };
      return { code: 0, stdout: "" };
    },
    readLine: async (prompt) =>
      /Initialize/.test(prompt) ? "y" : "acme/widgets",
  });
  await runSetupCommand({}, d);
  assert.ok(
    d.out.some((l) =>
      /origin → https:\/\/github\.com\/acme\/widgets\.git/.test(l),
    ),
  );
});

test("the origin prompt names the local/ identity a blank answer produces", async () => {
  const d = deps({
    git: async (args) => ({
      code: args[0] === "rev-parse" ? 0 : 1,
      stdout: "",
    }),
  });
  await runSetupCommand({}, d);
  // cwd is "/home/dev/projects/My App" — lowercased, spaces to dashes, the
  // same normalization a remote-less checkout aligns under.
  assert.ok(d.out.some((l) => /local\/my-app/.test(l)));
  assert.ok(
    !d.out.some((l) => /origin →/.test(l)),
    "a blank answer adds nothing",
  );
});

test("a repository that already has an origin is not asked about at all", async () => {
  const d = deps({ git: async () => ({ code: 0, stdout: "" }) });
  await runSetupCommand({}, d);
  assert.deepEqual(d.prompts, []);
});

test("garbage in the origin prompt is refused by name, not silently added", async () => {
  const d = deps({
    git: async (args) => ({
      code: args[0] === "rev-parse" ? 0 : 1,
      stdout: "",
    }),
    readLine: async () => "not a repo",
  });
  await runSetupCommand({}, d);
  assert.ok(d.out.some((l) => /skipped — "not a repo"/.test(l)));
  assert.ok(!d.git_.some((c) => c.args[1] === "add"));
});

test("--no-git leaves the folder entirely alone", async () => {
  const d = deps();
  await runSetupCommand({ git: false }, d);
  assert.deepEqual(d.git_, []);
  assert.deepEqual(d.prompts, []);
});

test("$HOME is never bootstrapped into a repository", async () => {
  const d = deps({ cwd: () => "/home/dev" });
  await runSetupCommand({}, d);
  assert.deepEqual(d.git_, []);
});

test("a machine without git says so instead of failing the setup", async () => {
  const d = deps({ resolveGit: async () => null });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.ok(d.out.some((l) => /`git` is not installed/.test(l)));
});

test("it closes by naming the verify command and the connect + align steps for both runtimes", async () => {
  const d = deps();
  await runSetupCommand({}, d);
  const tail = d.out.join("\n");
  assert.match(tail, /Done\. Verify with: jentrix whoami/);
  assert.match(tail, /\/jentrix-connect/);
  assert.match(tail, /\$jentrix-connect/);
  assert.match(tail, /jentrix session connect --provider claude\|codex/);
  assert.match(tail, /jentrix session align --task <id-or-key>/);
});

// --- upgrading a stale global install --------------------------------------
// Reported from Windows on 0.5.8: `npx --yes @jentrix/cli setup` fetches the
// latest CLI, saw an older global install, printed "already installed" and
// left the machine on the version the operator had just run setup to replace.

const STALE = "/usr/lib/node_modules/@jentrix/cli";

test("a STALE global install is upgraded, not reported as already installed", async () => {
  const d = deps({
    globalInstall: async () => ({
      cliDir: STALE,
      cliVersion: "0.5.7",
      binDir: "/usr/bin",
      binDirOnPath: true,
      runningFromGlobal: false,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 0);

  // It actually installs, pinned to THIS build's version.
  const install = npmArgs(d).find((a) => a[0] === "install");
  assert.ok(install, "a stale install must trigger `npm install -g`");
  assert.ok(install!.includes(`@jentrix/cli@${CLI_VERSION}`));
  assert.ok(!install!.includes(`@jentrix/runner@${CLI_VERSION}`));

  const out = d.out.join("\n");
  assert.match(out, new RegExp(`Upgrading jentrix 0\\.5\\.7 . ${CLI_VERSION}`));
  assert.doesNotMatch(out, /already installed/);
});

test("it never replaces the package underneath its own process", async () => {
  // `jentrix setup` run FROM the global install: replacing it mid-run is how a
  // Windows setup ends half-written, so it prints the command instead.
  const d = deps({
    globalInstall: async () => ({
      cliDir: STALE,
      cliVersion: "0.5.7",
      binDir: "/usr/bin",
      binDirOnPath: true,
      runningFromGlobal: true,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 0);
  assert.deepEqual(
    npmArgs(d).filter((a) => a[0] === "install"),
    [],
    "must not self-replace",
  );
  const out = d.out.join("\n");
  assert.match(out, /jentrix 0\.5\.7 is already installed/);
  assert.match(out, new RegExp(`${CLI_VERSION} is available`));
  assert.match(out, /npm install -g @jentrix\/cli@/);
});

test("it reports the INSTALLED version, never this build's constant", async () => {
  const d = deps({
    globalInstall: async () => ({
      cliDir: STALE,
      cliVersion: "9.9.9",
      binDir: "/usr/bin",
      binDirOnPath: true,
      runningFromGlobal: false,
    }),
  });
  assert.equal(await runSetupCommand({}, d), 0);
  const out = d.out.join("\n");
  // A newer install than the runner: named honestly and left alone.
  assert.match(out, /jentrix 9\.9\.9 is already installed/);
  assert.match(out, /Newer than this .* build/);
  assert.deepEqual(
    npmArgs(d).filter((a) => a[0] === "install"),
    [],
  );
});

test("compareVersions orders numerically, not lexicographically", () => {
  assert.ok(compareVersions("0.5.9", "0.5.10") < 0, "0.5.10 comes after 0.5.9");
  assert.ok(compareVersions("0.5.7", "0.5.8") < 0);
  assert.ok(compareVersions("0.6.0", "0.5.99") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(
    compareVersions("1.2.3-beta.1", "1.2.3"),
    0,
    "prerelease ~ base",
  );
  // Junk sorts oldest, so an unreadable install is replaced rather than kept.
  assert.ok(compareVersions("garbage", "0.0.1") < 0);
});

// --- D6 (2026-08-23): setup writes the checkout's ./.mcp.json ---------------
// A new user used to need THREE sessions to reach one with tools: setup →
// align (writes .mcp.json) → the next start. The same OAuth-mode plan align
// uses, written by setup when the folder is a git work tree.

const MCP_PATH = "/home/dev/projects/My App/.mcp.json";
const SIGNED_IN = "https://stacks-mvp.vercel.app/api/mcp";
const inRepo = async () => ({ code: 0, stdout: "" });

test("writes ./.mcp.json in a fresh work tree under --native-mcp — OAuth mode, no credential, and says so", async () => {
  const d = deps({ git: inRepo });
  assert.equal(await runSetupCommand({ nativeMcp: true }, d), 0);
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0]!.path, MCP_PATH);
  const doc = JSON.parse(d.written[0]!.text) as {
    mcpServers: Record<
      string,
      { type: string; url: string; headers?: unknown }
    >;
  };
  assert.deepEqual(doc.mcpServers.jentrix, { type: "http", url: SIGNED_IN });
  assert.ok(!/Authorization|tm_|tmo_/.test(d.written[0]!.text));
  assert.ok(
    d.out.some((l) =>
      l.startsWith(`Wrote ./.mcp.json → ${SIGNED_IN} (Claude Code reads it`),
    ),
  );
});

test("merges into an existing file — other servers survive, and a repoint is named", async () => {
  const d = deps({
    git: inRepo,
    readTextFile: (path) =>
      path === MCP_PATH
        ? JSON.stringify({
            mcpServers: {
              playwright: { command: "npx", args: ["@playwright/mcp"] },
              jentrix: { type: "http", url: "https://tm.jentrix.ai/api/mcp" },
            },
            other: true,
          })
        : null,
  });
  await runSetupCommand({ nativeMcp: true }, d);
  assert.equal(d.written.length, 1);
  const doc = JSON.parse(d.written[0]!.text) as {
    mcpServers: Record<string, unknown>;
    other: boolean;
  };
  assert.deepEqual(doc.mcpServers.playwright, {
    command: "npx",
    args: ["@playwright/mcp"],
  });
  assert.deepEqual(doc.mcpServers.jentrix, { type: "http", url: SIGNED_IN });
  assert.equal(doc.other, true);
  assert.ok(
    d.out.some(
      (l) =>
        /Repointed the "jentrix" MCP server in \.\/\.mcp\.json/.test(l) &&
        l.includes("https://tm.jentrix.ai/api/mcp") &&
        l.includes(SIGNED_IN),
    ),
  );
});

test("an unchanged file is left alone — no write, one line", async () => {
  const d = deps({
    git: inRepo,
    readTextFile: (path) =>
      path === MCP_PATH
        ? JSON.stringify({
            mcpServers: { jentrix: { type: "http", url: SIGNED_IN } },
          })
        : null,
  });
  await runSetupCommand({ nativeMcp: true }, d);
  assert.deepEqual(d.written, []);
  assert.ok(d.out.some((l) => l === `./.mcp.json already names ${SIGNED_IN}.`));
});

test("a file that is not valid JSON is refused by name, never clobbered", async () => {
  const d = deps({
    git: inRepo,
    readTextFile: (path) => (path === MCP_PATH ? "{ not json" : null),
  });
  await runSetupCommand({ nativeMcp: true }, d);
  assert.deepEqual(d.written, []);
  assert.ok(d.out.some((l) => /\.mcp\.json is not valid JSON/.test(l)));
});

test("--url stands in when the machine is not signed in; neither ⇒ a note, no write", async () => {
  const flagged = deps({ git: inRepo, signedInUrl: () => null });
  await runSetupCommand({ url: "https://x.dev/api/mcp", nativeMcp: true }, flagged);
  assert.equal(flagged.written.length, 1);
  assert.match(flagged.written[0]!.text, /https:\/\/x\.dev\/api\/mcp/);

  const bare = deps({ git: inRepo, signedInUrl: () => null });
  await runSetupCommand({ nativeMcp: true }, bare);
  assert.deepEqual(bare.written, []);
  assert.ok(
    bare.out.some((l) => /skipped \.\/\.mcp\.json — no endpoint/.test(l)),
  );
});

test("skipped under --no-git, in $HOME, and when the folder is not a work tree", async () => {
  const noGit = deps({ git: inRepo });
  await runSetupCommand({ git: false }, noGit);
  assert.deepEqual(noGit.written, []);

  const home = deps({ git: inRepo, cwd: () => "/home/dev" });
  await runSetupCommand({}, home);
  assert.deepEqual(home.written, []);

  // Not a repo, and the interactive offer declined (blank answer).
  const notRepo = deps();
  await runSetupCommand({}, notRepo);
  assert.deepEqual(notRepo.written, []);
  // …nor non-interactively, where the offer is never made.
  const piped = deps({ isInteractive: false });
  await runSetupCommand({}, piped);
  assert.deepEqual(piped.written, []);
});

test("a freshly initialized repository gets the file in the same run", async () => {
  let initialized = false;
  const d = deps({
    git: async (args) => {
      if (args[0] === "rev-parse")
        return { code: initialized ? 0 : 1, stdout: "" };
      if (args[0] === "init") {
        initialized = true;
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    },
    readLine: async (prompt) => (/Initialize/.test(prompt) ? "y" : ""),
  });
  await runSetupCommand({ nativeMcp: true }, d);
  assert.equal(d.written.length, 1);
  assert.equal(d.written[0]!.path, MCP_PATH);
});
