/**
 * `jentrix setup` — the whole local toolchain in one command, on every OS.
 *
 * This exists because the shell installers could not be one thing. PowerShell
 * aliases `curl` to Invoke-WebRequest and resolves `bash` to WSL, so the
 * documented `bash -c "$(curl …)"` line dies twice over on a fresh Windows
 * machine before a single Jentrix step runs; and no syntax parses in both
 * PowerShell and sh, so "one command for everyone" cannot be a shell command
 * at all. It CAN be a program: Node is already a hard prerequisite (the whole
 * toolchain is npm packages), and `npx` is spelled identically in PowerShell,
 * cmd.exe, bash, zsh and fish. So the installer moved here, and the two
 * scripts under public/ shrank to bootstraps that hand off to it.
 *
 * The sequence is public/install.sh's, step for step, because that sequence
 * was right — preflight, toolchain, runtimes, connect, Codex MCP, git — and
 * the platform differences it hard-codes (which shell, which path separator,
 * how to find an executable) are the ones Node already abstracts.
 *
 * Safe to re-run: an existing global install is left alone rather than
 * reinstalled over itself, the plugin step switches to its update path, an
 * existing Codex entry is never rewritten, and every git prompt is skipped
 * once configured.
 */

import { join } from "node:path";

import { Command } from "commander";

import { CLI_VERSION } from "../client";
import { EXIT_CODES } from "../errors";
import { planMcpServerEntry, renderMcpConfig } from "../mcp-config";
import type { GitRunner } from "../repo";

/** Result of one subprocess, shaped like the runner/plugin invocations. */
export interface SetupInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupFlags {
  /** `--url <url>` — the MCP endpoint to sign in against (skips the picker). */
  url?: string;
  /** `--local` — bind THIS folder to that server (login --local). */
  local?: boolean;
  /** `--no-git` — never touch the current folder's repository. */
  git?: boolean;
  /** `--workspace <id-or-slug>` — the folder binding's workspace (v2 §15.1). */
  workspace?: string;
  /**
   * `--native-mcp` — write provider-native MCP configuration (`./.mcp.json`
   * + Codex registration). D11: baseline setup writes NEITHER; native MCP is
   * optional and explicit.
   */
  nativeMcp?: boolean;
}

/**
 * What npm's GLOBAL install actually holds — never what PATH suggests.
 *
 * The distinction is the whole reason this type exists. `npx @jentrix/cli
 * setup` — the documented entry point — runs with npm's `_npx` cache
 * prepended to PATH, and that cache contains a `jentrix` shim. So probing PATH
 * for `jentrix` ALWAYS succeeds under npx, whether or not anything is
 * installed, and it says nothing about the shell the operator will use next.
 */
export interface GlobalInstall {
  /** The globally installed `@jentrix/cli` directory, or null. */
  cliDir: string | null;
  /** That install's version, read from its own package.json, or null. */
  cliVersion: string | null;
  /** npm's global bin directory — where the `jentrix` shim lands, or null. */
  binDir: string | null;
  /** Is `binDir` on PATH? `npx` only PREPENDS, so this still answers for the
   *  operator's own shell. */
  binDirOnPath: boolean;
  /**
   * Is THIS process the global install? Replacing a package underneath the
   * process executing it is how a Windows run ends half-written, so an upgrade
   * defers to a manual command in that case. Under `npx` — the documented
   * entry point — the running copy is npm's `_npx` cache, so this is false and
   * the upgrade is safe.
   */
  runningFromGlobal: boolean;
}

export interface SetupCommandDeps {
  /** What npm's global prefix actually holds (never a PATH probe). */
  globalInstall(): Promise<GlobalInstall>;
  resolveNpm(): Promise<string | null>;
  resolveClaude(): Promise<string | null>;
  resolveCodex(): Promise<string | null>;
  resolveGit(): Promise<string | null>;
  invoke(
    file: string,
    args: string[],
    stdin?: string,
    timeoutMs?: number,
  ): Promise<SetupInvocation>;
  /**
   * `jentrix plugin install <provider>`, IN PROCESS. Never a subprocess: the
   * plugin command carries its own login chain and runner self-heal, and
   * shelling out to a second `jentrix` would run a different build than the
   * one the operator just installed.
   */
  installPlugin(provider: "claude" | "codex"): Promise<number>;
  /** Is a token resolvable (env / config file)? */
  hasCredential(): boolean;
  /** The endpoint this machine is signed in to, or null when it is not. */
  signedInUrl(): string | null;
  /** In-process `jentrix login` (interactive server picker included). */
  login(flags: { url?: string; local?: boolean }): Promise<number>;
  /** `$CODEX_HOME/config.toml`, resolved by the caller. */
  codexConfigPath(): string;
  readTextFile(path: string): string | null;
  /** Append, creating the file and its parent directory when absent. */
  appendTextFile(path: string, text: string): void;
  /** Write (create or replace) — the checkout's `./.mcp.json` (D6). */
  writeTextFile(path: string, text: string): void;
  copyFile(from: string, to: string): void;
  /** Injectable clock — the Codex config backup carries a timestamp. */
  now(): Date;
  cwd(): string;
  homeDir(): string;
  git: GitRunner;
  /**
   * Folder alignment, IN PROCESS (client-runtime v2 §14 R1: setup performs
   * folder alignment only — no Project, no session). Wired to
   * `runFolderAlign` with the session deps in main.ts.
   */
  folderAlign(flags: {
    workspace?: string;
    yes?: boolean;
  }): Promise<number>;
  readLine(prompt: string): Promise<string>;
  writeOut(text: string): void;
  writeErr(text: string): void;
  isInteractive: boolean;
}

/** npm -g of the CLI can far outlast a default subprocess cap. */
const NPM_INSTALL_TIMEOUT_MS = 300_000;

/**
 * The pre-rename packages (<= 0.5.2) own the `stacks` and `stacks-runner`
 * bins, and the renamed packages ship those same aliases — npm refuses to
 * overwrite a bin belonging to another package and fails the WHOLE install
 * with EEXIST. They are superseded, not a sibling install, so they are dropped
 * before the install rather than after.
 */
const SUPERSEDED = ["@jentrix/stacks-cli", "@jentrix/stacks-runner"];

const CLI_SPEC = `@jentrix/cli@${CLI_VERSION}`;

/**
 * Order two `x.y.z` versions: negative when `a` precedes `b`, 0 when equal.
 *
 * Deliberately numeric per segment rather than lexicographic — "0.5.10" is
 * AFTER "0.5.9" and a string compare gets that backwards. Anything
 * unparseable sorts as 0.0.0, which makes an install carrying junk look stale
 * and get replaced; that is the safe direction.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

function say(deps: SetupCommandDeps, text = ""): void {
  deps.writeOut(text);
}

/**
 * Install the toolchain globally when it is not there yet.
 *
 * "Is it there" is answered by npm's global root, NOT by finding a `jentrix`
 * on PATH. The PATH answer was wrong in the one case that matters most: under
 * `npx @jentrix/cli setup`, npm prepends its `_npx` cache to PATH, that cache
 * holds a `jentrix` shim, and so the probe reported "already installed" on a
 * machine with nothing installed — skipped the npm step, ran the rest against
 * a throwaway copy, exited 0, and left the operator with no `jentrix` once npx
 * cleaned up. Reported from Windows on 0.5.6.
 *
 * A STALE global install is upgraded rather than left alone. `npx
 * @jentrix/cli setup` fetches the latest CLI, so the running build is the
 * version the operator asked for; reporting "already installed" and keeping an
 * older one means the documented entry point can never deliver a fix. Reported
 * from Windows on 0.5.8, where re-running setup left the machine on 0.5.7 —
 * without the fix it had just been run to obtain.
 *
 * The one install left alone is the process's OWN: replacing a package
 * underneath the process executing it is how a Windows setup ends half-written.
 * That case prints the upgrade command instead.
 */
async function installToolchain(deps: SetupCommandDeps): Promise<number> {
  const npm = await deps.resolveNpm();
  let global = await deps.globalInstall();

  // Report the version that is actually THERE, never this build's constant —
  // conflating the two is how the old line claimed a version the directory did
  // not contain.
  const installedVersion = global.cliVersion;
  const behind =
    global.cliDir !== null &&
    (installedVersion === null ||
      compareVersions(installedVersion, CLI_VERSION) < 0);
  const upgradable = behind && !global.runningFromGlobal;

  if (global.cliDir && !upgradable) {
    say(
      deps,
      `jentrix ${installedVersion ?? "(unreadable version)"} is already installed (${global.cliDir}).`,
    );
    if (behind) {
      // Running FROM the global install, so it cannot replace itself.
      say(deps, `  ${CLI_VERSION} is available — upgrade with:`);
      say(deps, `    npm install -g ${CLI_SPEC}`);
    } else if (
      installedVersion &&
      compareVersions(installedVersion, CLI_VERSION) > 0
    ) {
      say(deps, `  Newer than this ${CLI_VERSION} build — left alone.`);
    } else {
      say(deps, "  Upgrade it any time with: npm update -g @jentrix/cli");
    }
  } else {
    if (!npm) {
      deps.writeErr(
        "NPM_NOT_FOUND: the toolchain installs from npm and `npm` is not on PATH — install Node.js >= 20 (https://nodejs.org), then retry.",
      );
      return EXIT_CODES.INVALID_INPUT;
    }
    // The pre-rename packages own the `stacks`/`stacks-runner` bins and npm
    // fails the WHOLE install with EEXIST rather than overwrite them.
    await deps.invoke(npm, ["rm", "-g", ...SUPERSEDED], undefined, 60_000);
    say(
      deps,
      upgradable
        ? `Upgrading jentrix ${installedVersion ?? "?"} → ${CLI_VERSION} (npm -g)…`
        : `Installing ${CLI_SPEC} (npm -g)…`,
    );
    const installed = await deps.invoke(
      npm,
      ["install", "-g", CLI_SPEC],
      undefined,
      NPM_INSTALL_TIMEOUT_MS,
    );
    if (installed.code !== 0) {
      const detail = (installed.stderr || installed.stdout).trim();
      deps.writeErr(
        `TOOLCHAIN_INSTALL_FAILED: \`npm install -g\` exited ${installed.code}${detail ? `: ${detail}` : ""}`,
      );
      deps.writeErr(
        "  On EACCES, fix npm's global prefix (https://docs.npmjs.com/resolving-eacces-permissions-errors); on EEXIST, delete the bin npm names and retry.",
      );
      return EXIT_CODES.INTERNAL;
    }
    // Re-read rather than trust the exit code: npm can report success and
    // leave nothing resolvable under a misconfigured prefix.
    global = await deps.globalInstall();
    if (!global.cliDir) {
      deps.writeErr(
        "TOOLCHAIN_INSTALL_FAILED: npm reported success but @jentrix/cli is not under `npm root -g` — check npm's global prefix, then retry.",
      );
      return EXIT_CODES.INTERNAL;
    }
    say(
      deps,
      upgradable
        ? `Upgraded to ${global.cliVersion ?? CLI_VERSION}.`
        : "Installed the CLI (the session host ships inside it).",
    );
  }

  // Client-runtime v2 (§18): the session host ships INSIDE @jentrix/cli —
  // setup installs NO @jentrix/runner. The runner remains an ops-plane worker
  // package installed by operators who run workers, never a product
  // prerequisite.

  // Installed is not the same as REACHABLE. Said here, at the moment it is
  // knowable, because the alternative is the operator discovering it as
  // "'jentrix' is not recognized" in a fresh terminal with nothing to connect
  // it to.
  if (global.binDir && !global.binDirOnPath) {
    say(deps, "");
    say(deps, "note: npm's global bin directory is NOT on your PATH —");
    say(deps, `        ${global.binDir}`);
    say(
      deps,
      "      The toolchain is installed, but `jentrix` will not be found in a new",
    );
    say(
      deps,
      "      terminal until you add that directory to PATH and reopen your shell.",
    );
  }
  return EXIT_CODES.OK;
}

/**
 * The provider runtimes, as DATA.
 *
 * A table rather than two branches because the two branches drifted: the
 * Claude arm discarded `installPlugin`'s exit code while the Codex arm checked
 * it, so a Claude Code plugin that failed to install left `setup` reporting
 * success with nothing to act on — which is exactly how a Windows machine
 * ended up still showing only the pre-rename `stacks@stacks` plugin after a
 * clean run. One loop cannot drift from itself.
 */
const RUNTIMES = [
  {
    provider: "claude" as const,
    resolve: (deps: SetupCommandDeps) => deps.resolveClaude(),
    absent: [
      "note: the `claude` CLI was not found — skipped its plugin.",
      "      Installed already? This terminal's PATH may predate the install — reopen it and re-run, or run: jentrix plugin install claude",
      "      Otherwise install Claude Code (https://claude.com/claude-code) first.",
    ],
  },
  {
    provider: "codex" as const,
    resolve: (deps: SetupCommandDeps) => deps.resolveCodex(),
    absent: [
      "note: the `codex` CLI is not installed — skipped its plugin and MCP server.",
      "      Install Codex (https://developers.openai.com/codex/cli), then re-run this command.",
    ],
  },
];

/**
 * Register the plugin for each runtime present, and NAME each one that is
 * absent or that failed.
 *
 * A failed plugin never aborts setup — the CLI is installed and the sign-in,
 * MCP and git steps are still worth doing — but it is recorded, reported by
 * name, and carried into a non-zero exit, because "the toolchain installed"
 * and "your agent got its commands" are different claims.
 */
async function installRuntimes(
  deps: SetupCommandDeps,
  pending: Pending,
): Promise<void> {
  for (const runtime of RUNTIMES) {
    if (!(await runtime.resolve(deps))) {
      for (const line of runtime.absent) say(deps, line);
      continue;
    }
    if ((await deps.installPlugin(runtime.provider)) !== EXIT_CODES.OK) {
      pending.failedPlugins.push(runtime.provider);
    }
  }
}

/** What still has to happen by hand once setup returns. */
interface Pending {
  codexLoginUrl?: string;
  codexTokenUrl?: string;
  /** Providers whose plugin did not install — reported, and a non-zero exit. */
  failedPlugins: string[];
  /**
   * Folder alignment was ATTEMPTED and refused (JEN-465) — `--workspace`
   * named no workspace of the signed-in account, or the picker was declined.
   * Distinct from the no-credential skip, which is not a failure: the Setup
   * page's prompt relies on that exit 0 and binds in a later step.
   */
  bindingRefused: boolean;
}

/**
 * Register the Jentrix MCP server with Codex.
 *
 * The plugin and the MCP entry are TWO complementary halves and neither
 * substitutes for the other: the plugin carries the connected-session skills
 * and the trusted lifecycle hooks (where a Codex task gets a real session
 * identity), the MCP entry is what gives the agent Jentrix TOOLS. Installing
 * one and calling Codex connected is how an operator ends up with skills that
 * cannot read, or tools that cannot align.
 */
async function registerCodexMcp(
  deps: SetupCommandDeps,
  codex: string,
  pending: Pending,
  url: string | null,
): Promise<void> {
  const configPath = deps.codexConfigPath();
  const config = deps.readTextFile(configPath);

  // Either key counts as "already registered". A machine set up before the
  // Jentrix rename has [mcp_servers.stacks]; writing a second
  // [mcp_servers.jentrix] beside it would give Codex two servers for one
  // deployment and a duplicated tool surface. The old entry keeps working —
  // the server key is the CLIENT's to choose — so it is left alone.
  const existingKey = config
    ? /^\[mcp_servers\.jentrix\]/m.test(config)
      ? "jentrix"
      : /^\[mcp_servers\.stacks\]/m.test(config)
        ? "stacks"
        : null
    : null;
  if (existingKey) {
    say(
      deps,
      `note: Codex already has an [mcp_servers.${existingKey}] entry — left untouched.`,
    );
    say(
      deps,
      `      It may point at a different deployment; check ${configPath}.`,
    );
    say(
      deps,
      `      To move it off an exported STACKS_CODEX_TOKEN and onto sign-in:`,
    );
    say(
      deps,
      `      \`codex mcp remove ${existingKey}\`, then re-run this command.`,
    );
    return;
  }

  if (!url) {
    say(
      deps,
      "note: skipped the Codex MCP entry — this machine is not signed in yet, so",
    );
    say(
      deps,
      "      there is no endpoint to register. Run `jentrix login`, then re-run this command.",
    );
    return;
  }

  // Sign-in, not a pasted token: an entry with no `bearer_token_env_var` is
  // one Codex authenticates itself, through the same browser consent flow the
  // CLI uses (Jentrix registers the client per RFC 7591 and Codex holds a
  // rotating token of its own). The PAT below is the fallback for a Codex too
  // old to have `codex mcp login` — minting and exporting it was the one
  // manual step people skipped, ending up with skills and no tools.
  const oauth =
    (await deps.invoke(codex, ["mcp", "login", "--help"])).code === 0;

  if (config !== null) {
    const stamp = deps.now().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    deps.copyFile(configPath, `${configPath}.bak-jentrix-${stamp}`);
  }
  // Appending a table at EOF is always valid TOML: a header ends the table
  // before it. Written HERE rather than by `codex mcp add`, which starts the
  // OAuth flow itself and blocks until the browser comes back — with its
  // output suppressed that is an installer that hangs and never says why.
  const lines = ["", "# Added by the Jentrix installer."];
  lines.push(
    oauth
      ? "# Authenticated by `codex mcp login jentrix` — no token to export."
      : "# Needs STACKS_CODEX_TOKEN in the environment (a personal access token, scopes read + write).",
  );
  lines.push("[mcp_servers.jentrix]", `url = "${url}"`);
  if (!oauth) lines.push('bearer_token_env_var = "STACKS_CODEX_TOKEN"');
  deps.appendTextFile(configPath, `${lines.join("\n")}\n`);
  say(deps, `Codex: registered [mcp_servers.jentrix] → ${url}`);

  if (!oauth) {
    say(
      deps,
      "       (this Codex build has no `codex mcp login`, so the entry reads a token",
    );
    say(deps, "        from the environment)");
    pending.codexTokenUrl = `${url.replace(/\/api\/mcp$/, "")}/account/tokens`;
    return;
  }
  if (!deps.isInteractive) {
    pending.codexLoginUrl = url;
    return;
  }
  say(
    deps,
    "Signing Codex in — approve the Jentrix consent screen in your browser…",
  );
  // Foreground and unsuppressed on purpose: this step WAITS for the callback,
  // and the URL it prints is the operator's way through it.
  if ((await deps.invoke(codex, ["mcp", "login", "jentrix"])).code !== 0) {
    pending.codexLoginUrl = url;
  }
}

/**
 * Make the CURRENT folder session-ready. Never in $HOME, never
 * non-interactive: both would be a command quietly creating a repository
 * somewhere the operator did not ask for one.
 */
async function bootstrapRepository(deps: SetupCommandDeps): Promise<boolean> {
  const here = deps.cwd();
  if (!(await deps.resolveGit())) {
    say(deps, "note: `git` is not installed — skipped the repository step.");
    say(
      deps,
      "      Jentrix aligns sessions by repository identity, so install git (https://git-scm.com/downloads) and re-run.",
    );
    return false;
  }

  const inRepo = async () =>
    (await deps.git(["rev-parse", "--is-inside-work-tree"], here)).code === 0;

  if (!(await inRepo())) {
    const reply = await deps.readLine(
      `Initialize a git repository in ${here} so agent sessions can align here? [y/N] `,
    );
    if (!/^y/i.test(reply.trim())) return false;
    if ((await deps.git(["init"], here)).code !== 0) {
      say(deps, "note: `git init` failed — skipped the repository step.");
      return false;
    }
  }
  // From here the folder IS a work tree; the origin is optional.
  if ((await deps.git(["remote", "get-url", "origin"], here)).code === 0)
    return true;

  // The remote is OPTIONAL and does not have to exist yet: alignment only
  // needs a stable owner/name, and a checkout without one is identified by its
  // own directory under the reserved `local` owner.
  const fallback = here
    .split(/[/\\]/)
    .filter(Boolean)
    .pop()!
    .toLowerCase()
    .replace(/ /g, "-");
  say(
    deps,
    "Jentrix aligns sessions by repository identity (owner/name); the remote doesn't have to exist yet.",
  );
  say(
    deps,
    `Optional — leave it blank and this checkout aligns as local/${fallback}.`,
  );
  const answer = (
    await deps.readLine(
      "GitHub repo for origin (owner/name or full URL, blank to skip): ",
    )
  ).trim();
  if (!answer) return true;
  const url = /:\/\/|^[^/]+@[^:]+:/.test(answer)
    ? answer
    : /^[^/]+\/[^/]+$/.test(answer)
      ? `https://github.com/${answer}.git`
      : null;
  if (!url) {
    say(deps, `skipped — "${answer}" is neither owner/name nor a URL`);
    return true;
  }
  if ((await deps.git(["remote", "add", "origin", url], here)).code === 0) {
    say(deps, `origin → ${url}`);
  }
  return true;
}

/**
 * D6 (2026-08-23) — write the checkout's `./.mcp.json` so the NEXT agent
 * session in this folder already has the Jentrix server, instead of waiting
 * for the first align to write it (which cost a new user a third session:
 * setup → align → tools). The SAME plan align uses (OAuth mode: no header, no
 * credential; merge, never clobber), against the endpoint this machine is
 * signed in to — else the --url it was given — else nothing, with a note.
 * An unparseable file is left alone: merging is impossible and overwriting
 * would destroy the operator's other servers.
 */
function writeCheckoutMcpConfig(
  deps: SetupCommandDeps,
  url: string | null,
): void {
  const path = join(deps.cwd(), ".mcp.json");
  if (!url) {
    say(
      deps,
      "note: skipped ./.mcp.json — no endpoint is known yet (not signed in, no --url); the first `jentrix align` here writes it.",
    );
    return;
  }
  const raw = deps.readTextFile(path);
  let existing: unknown = null;
  if (raw !== null) {
    try {
      existing = JSON.parse(raw);
    } catch {
      say(
        deps,
        `note: ${path} is not valid JSON — left untouched (fix or remove it, then re-run; align refuses it the same way).`,
      );
      return;
    }
  }
  const plan = planMcpServerEntry(existing, url, null);
  if (plan.action === "unchanged") {
    say(deps, `./.mcp.json already names ${url}.`);
    return;
  }
  deps.writeTextFile(path, renderMcpConfig(plan.next));
  say(
    deps,
    plan.action === "repoint"
      ? `Repointed the "jentrix" MCP server in ./.mcp.json: ${plan.previousUrl} → ${url} (Claude Code reads it at session start; no credential inside).`
      : `Wrote ./.mcp.json → ${url} (Claude Code reads it at session start; no credential inside).`,
  );
  if (plan.removedAuthorization) {
    say(
      deps,
      "  Removed its Authorization header: a header suppresses the client's OAuth discovery. `jentrix align --pat` puts it back for a headless checkout.",
    );
  }
}

export async function runSetupCommand(
  flags: SetupFlags,
  deps: SetupCommandDeps,
): Promise<number> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(nodeMajor) && nodeMajor < 20) {
    deps.writeErr(
      `NODE_TOO_OLD: Jentrix requires Node.js >= 20 (running v${process.versions.node}) — upgrade from https://nodejs.org, then retry.`,
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  if (flags.url) {
    try {
      new URL(flags.url);
    } catch {
      deps.writeErr(`INVALID_URL: ${JSON.stringify(flags.url)}`);
      return EXIT_CODES.INVALID_INPUT;
    }
  }

  const toolchain = await installToolchain(deps);
  if (toolchain !== EXIT_CODES.OK) return toolchain;

  const pending: Pending = { failedPlugins: [], bindingRefused: false };
  await installRuntimes(deps, pending);

  // The login chain lives inside `jentrix plugin install`, so a machine with
  // NEITHER runtime would otherwise finish with no credential at all.
  if (!deps.hasCredential()) {
    if (deps.isInteractive) {
      say(deps, "");
      say(deps, "Connecting this machine to a Jentrix server…");
      if ((await deps.login({ url: flags.url, local: flags.local })) !== 0) {
        say(
          deps,
          "note: sign-in did not complete — run `jentrix login` when you're ready.",
        );
      }
    } else {
      say(
        deps,
        "note: no credential is configured — run `jentrix login` (interactive) to connect.",
      );
    }
  } else {
    // JEN-465: the skip was silent, so a new user could not tell from the
    // output whether sign-in had happened at all. The endpoint, never the
    // token.
    say(
      deps,
      `Signed in already (server ${deps.signedInUrl() ?? "unknown"}) — skipping the browser sign-in; \`jentrix logout\` to change it.`,
    );
  }

  const targetUrl = flags.url ?? deps.signedInUrl();
  // D11: provider-native MCP is optional and EXPLICIT — baseline setup
  // registers nothing; `--native-mcp` (or `jentrix mcp enable`) opts in.
  const codex = await deps.resolveCodex();
  if (flags.nativeMcp && codex) {
    await registerCodexMcp(deps, codex, pending, targetUrl);
  }

  if (flags.git !== false && deps.cwd() !== deps.homeDir()) {
    let inWorkTree: boolean;
    if (deps.isInteractive) {
      inWorkTree = await bootstrapRepository(deps);
    } else {
      inWorkTree =
        (await deps.resolveGit()) !== null &&
        (await deps.git(["rev-parse", "--is-inside-work-tree"], deps.cwd()))
          .code === 0;
      // The offer itself stays interactive-only (a piped run must never
      // create a repository), but the skip cannot be silent: align refuses a
      // non-repo folder, so "Next: align" below would otherwise be a lie.
      if (!inWorkTree) {
        say(
          deps,
          "note: skipped the repository offer (not an interactive terminal) — this folder is not a git work tree, and align requires one. Run `git init` here first.",
        );
      }
    }
    // Client-runtime v2 (§11.3, R1): folder alignment IS the setup's binding
    // step — endpoint + workspace onto the checkout, nothing created
    // server-side. `--no-git` means "skip folder alignment" (guarded above).
    if (inWorkTree && deps.hasCredential()) {
      const aligned = await deps.folderAlign({
        workspace: flags.workspace,
        yes: !deps.isInteractive,
      });
      if (aligned !== 0) {
        pending.bindingRefused = true;
        say(
          deps,
          "note: folder alignment did not complete — run `jentrix folder align` when ready (sessions need it).",
        );
      }
    } else if (inWorkTree) {
      say(
        deps,
        "note: skipped folder alignment (no credential yet) — run `jentrix folder align` after signing in.",
      );
    }
    // D11: ./.mcp.json only under --native-mcp — never as a baseline side
    // effect. Never in $HOME, never under --no-git (guarded above).
    if (inWorkTree && flags.nativeMcp) {
      writeCheckoutMcpConfig(deps, targetUrl);
    }
  }

  say(deps, "");
  if (pending.failedPlugins.length) {
    // Named, not implied: the CLI installed and signed in, so every other line
    // of this summary is true — which is precisely why the one part that did
    // NOT work has to say so rather than be inferred from an exit code.
    for (const provider of pending.failedPlugins) {
      say(
        deps,
        `note: the ${provider} plugin did NOT install — its commands will be missing.`,
      );
      say(
        deps,
        `      Run \`jentrix plugin install ${provider}\` on its own to see why.`,
      );
    }
    say(deps, "");
  }
  // JEN-465: "Done." above two failure notes and an exit 1 read as success
  // to an agent told to stop on an unexpected error. The closing line agrees
  // with the exit code.
  const problems =
    pending.failedPlugins.length + (pending.bindingRefused ? 1 : 0);
  say(
    deps,
    problems === 0
      ? "Done. Verify with: jentrix whoami"
      : `Finished with ${problems} problem(s) — see the note lines above. Verify with: jentrix whoami`,
  );
  if (pending.codexLoginUrl) {
    say(deps, "");
    say(
      deps,
      `One step left for Codex — approve its access to ${pending.codexLoginUrl}:`,
    );
    say(
      deps,
      "  codex mcp login jentrix    (opens the browser; no token to copy)",
    );
  }
  if (pending.codexTokenUrl) {
    say(deps, "");
    say(
      deps,
      "One step left for Codex — its MCP client carries its own token:",
    );
    say(
      deps,
      `  1. mint a personal access token (scopes read + write) at ${pending.codexTokenUrl}`,
    );
    say(
      deps,
      "  2. export STACKS_CODEX_TOKEN in the shell you start Codex from",
    );
    say(deps, "  3. restart Codex");
    say(
      deps,
      "  (deliberately not STACKS_TOKEN — that would also override the CLI's own",
    );
    say(deps, "   rotating login, which refreshes itself and needs no export)");
  }
  say(deps, "");
  say(deps, "Next: open your agent in the checkout and connect —");
  say(deps, "  Claude Code:  /jentrix-connect");
  say(deps, "  Codex:        $jentrix-connect");
  say(deps, "  any terminal: jentrix session connect --provider claude|codex");
  say(
    deps,
    "then anchor its work: jentrix session align --task <id-or-key>  (or --session-level)",
  );
  say(
    deps,
    "(Rebind this folder any time: jentrix folder align --workspace <slug>)",
  );
  // Everything else succeeded, so this is not a failed install — but a script
  // that treats 0 as "the agent is ready" would be wrong, and a human who
  // scrolled past the note deserves the second signal. A refused folder
  // binding counts the same way: sessions need it (JEN-465).
  return problems ? EXIT_CODES.INTERNAL : EXIT_CODES.OK;
}

export function registerSetupCommand(
  program: Command,
  deps: SetupCommandDeps,
  onExit: (code: number) => void,
): Command {
  return program
    .command("setup")
    .description(
      "Install and connect the whole local toolchain — the CLI (session " +
        "host included), the plugins for whichever agent runtimes are " +
        "present, browser sign-in, and this folder's workspace binding. " +
        "The same command on Windows, macOS and Linux. Safe to re-run.",
    )
    .option(
      "--url <url>",
      "MCP endpoint to sign in against (default: the interactive server picker)",
    )
    .option(
      "--local",
      "bind THIS folder to that server (./.stacks/config.json) instead of the machine-wide config",
    )
    .option("--no-git", "never touch the current folder's git repository")
    .option(
      "--workspace <id-or-slug>",
      "workspace for the folder binding (skips the picker)",
    )
    .option(
      "--native-mcp",
      "also write provider-native MCP configuration (./.mcp.json + Codex registration) — optional and explicit",
    )
    .action(async (options: SetupFlags) => {
      onExit(await runSetupCommand(options, deps));
    });
}
