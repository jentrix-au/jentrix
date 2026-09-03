/**
 * `jentrix` — process edge. As thin as possible (design.md §2): build the
 * real dependencies (fs, stdin, HTTP client, clock), mount the commands,
 * translate commander errors to the frozen exit codes, and set
 * `process.exitCode` (never `process.exit()` mid-stream, so stdout always
 * flushes). Tests never import this file — they drive `commands/tool.ts`
 * and `commands/build.ts` with injected deps instead.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";

import {
  CLI_VERSION,
  connectJentrixClientWithRefresh,
  RefreshFailedError,
} from "./client";
import {
  ConfigError,
  configPathFor,
  ensureInstallationId,
  readConfigFile,
  resolveConfig,
  resolveConfigPath,
  scaffoldProjectConfigDir,
  type JentrixConfigFile,
} from "./config";
import { execTarget } from "./exec-target";
import { bindLoopback, openBrowser } from "./loopback";
import { installProxyDispatcher } from "./proxy";
import { registerArtifactCommand } from "./commands/artifact";
import { ALIASES, FLAG_RENAMES } from "./commands/aliases";
import { mountCommandTree, planCommandTree } from "./commands/build";
import { isFlagError } from "./commands/flags";
import {
  registerLoginCommand,
  runLoginCommand,
  type LoginDeps,
} from "./commands/login";
import { registerLogoutCommand, type LogoutDeps } from "./commands/logout";
import {
  isCodexPluginMarketplaceDir,
  isPluginMarketplaceDir,
  persistentPluginRoot,
  registerPluginCommand,
  runPluginInstall,
  type PluginCommandDeps,
} from "./commands/plugin";
import {
  invokeRunnerProcess,
  platformExecutableNames,
  registerRunnerCommand,
  resolveClaudeExecutable,
  resolveExecutableOnPath,
  resolveRunnerExecutable,
  runRunnerForeground,
} from "./commands/runner";
import {
  readAlignmentMarker,
  readCurrentProviderHookContext,
  registerSessionCommand,
  type SessionCommandDeps,
} from "./commands/session";
import { defaultGitRunner, inspectRepository } from "./repo";
import { registerAlignCommand } from "./commands/align";
import { registerFolderCommand, runFolderAlign } from "./commands/folder";
import { registerMcpCommand } from "./commands/mcp";
import { registerTaskProjectCommand } from "./commands/task-project";
import { registerMintIssueCommand, registerPushCommand } from "./commands/push";
import { registerSetupCommand } from "./commands/setup";
import { registerSnapshotCommand } from "./commands/snapshot";
import { registerToolCommand, type ToolCommandDeps } from "./commands/tool";
import { registerWhoamiCommand } from "./commands/whoami";
import { EXIT_CODES } from "./errors";
import { loadSurface, type SurfaceManifest } from "./surface";
import { formatVersion } from "./version";

/** Absolute path of the bundled manifest — the single source for both the
 *  command tree and the `--version` freshness date (its file mtime). */
const SURFACE_URL = new URL("../surface.json", import.meta.url);

/**
 * The bundled manifest (sits next to dist/ and src/ alike). It powers the
 * generated command tree and the unknown-name notice; an unreadable manifest
 * degrades to "no generated commands, no notice" — `jentrix tool` always
 * works, so a broken install still has the full escape hatch.
 */
function loadManifest(): SurfaceManifest | null {
  try {
    const raw = readFileSync(SURFACE_URL, "utf8");
    return loadSurface(raw);
  } catch {
    return null;
  }
}

/**
 * The surface-file date shown by `--version`: the on-disk mtime of
 * `surface.json` as an ISO string, or null when it can't be stat'd. The
 * manifest is deliberately timestamp-free (byte-stable regeneration, C0.2), so
 * the file's mtime is the only date available — it is honestly "when this
 * install's surface.json was written", not a proof of surface-generation time
 * (see version.ts). No fabricated date is ever produced.
 */
function surfaceFileMtime(): string | null {
  try {
    return statSync(SURFACE_URL).mtime.toISOString();
  } catch {
    return null;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
    process.stdin.on("error", reject);
  });
}

/**
 * AGE-952 per-project servers: a `.stacks/config.json` found walking up from
 * the cwd IS the config file (own url + token, no merge with the home file),
 * so different folders bind to different Jentrix servers. Fallback: the home
 * file. The one exception is the installation id — a MACHINE identity — which
 * always lives in the home file regardless of which config is active.
 */
const CONFIG_PATH = resolveConfigPath(process.cwd(), homedir());
const HOME_CONFIG_PATH = configPathFor(homedir());

// JEN-306 — before anything captures `fetch`: Node's built-in fetch ignores
// HTTPS_PROXY/NO_PROXY without a dispatcher, so every network call below
// (MCP transport included) was taking the direct path on a proxied network.
installProxyDispatcher();

/** Lazy so `jentrix tool --help` works even with a malformed config file. */
function configFile(): JentrixConfigFile | null {
  return readConfigFile(CONFIG_PATH);
}

/** Read one line from stdin (login --paste / interactive prompt). */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Read one line from stdin while something else races it — login's concurrent
 * paste (C1.1). Resolves `null` when the race is aborted (the OAuth callback
 * arrived) or stdin closes, and writes the newline that ends the half-typed
 * prompt so the success lines do not land on top of it. `settled` guards the
 * `close` the abort itself triggers.
 */
function readPastedRedirect(
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rl.close();
      resolve(value);
    };
    const onAbort = () => {
      process.stdout.write("\n");
      done(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.on("close", () => done(null));
    rl.question(prompt, (answer) => done(answer));
  });
}

const manifest = loadManifest();

const deps: ToolCommandDeps = {
  env: process.env,
  configFile,
  knownTools: manifest
    ? new Set(manifest.tools.map((tool) => tool.name))
    : null,
  connect: async (target) => {
    // Transparent OAuth refresh (C4.2): refresh + retry-once-on-401 handling
    // lives in connectJentrixClientWithRefresh. It only refreshes when the token
    // being used IS the one login stored (config-file access token) AND an
    // oauth record is present; a `--token`/env override is used verbatim (we
    // never refresh a token the caller supplied explicitly).
    let oauth;
    try {
      const file = readConfigFile(CONFIG_PATH);
      oauth =
        file?.oauth && file.token === target.token ? file.oauth : undefined;
    } catch {
      // A malformed config file here would already have been surfaced by the
      // command layer's own resolveConfig read; ignore and connect PAT-style.
      oauth = undefined;
    }
    try {
      const handle = await connectJentrixClientWithRefresh({
        url: target.url,
        token: target.token,
        sessionId: target.sessionId,
        oauth,
        configPath: CONFIG_PATH,
      });
      return { caller: handle.client, close: handle.close };
    } catch (e) {
      // A failed refresh is a dead OAuth session → surface as a 401-shaped
      // error carrying the OAuth remediation, so the command layer prints
      // "run jentrix login" (exit 7), NOT the mint-a-PAT message.
      if (e instanceof RefreshFailedError) {
        throw Object.assign(new Error(e.reloginMessage), {
          code: 401,
          reloginMessage: e.reloginMessage,
        });
      }
      throw e;
    }
  },
  // STA-59: the SAME correlation resolution `jentrix push` uses — this
  // checkout's marker for THIS provider session, never the repo's newest
  // (that would attribute one session's writes to another).
  sessionId: async () => {
    const inspection = await inspectRepository(process.cwd());
    if (!inspection) return null;
    const marker = readAlignmentMarker(
      CONFIG_PATH,
      inspection.root,
      readCurrentProviderHookContext({
        env: process.env,
        cwd: () => process.cwd(),
      })?.sessionId ?? null,
    );
    return marker?.sessionId ?? null;
  },
  readStdin,
  readFile: (path) => readFileSync(path, "utf8"),
  writeOut: (text) => process.stdout.write(`${text}\n`),
  writeErr: (text) => process.stderr.write(`${text}\n`),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const loginDeps: LoginDeps = {
  env: process.env,
  configPath: CONFIG_PATH,
  cwd: () => process.cwd(),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  scaffoldProjectDir: scaffoldProjectConfigDir,
  bindLoopback,
  openBrowser,
  readLine,
  readPastedRedirect,
  readFileIfPresent: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeOut: (text) => process.stdout.write(`${text}\n`),
  writeErr: (text) => process.stderr.write(`${text}\n`),
  now: () => Date.now(),
  fetchImpl: fetch,
};

const logoutDeps: LogoutDeps = {
  configPath: CONFIG_PATH,
  writeOut: (text) => process.stdout.write(`${text}\n`),
  writeErr: (text) => process.stderr.write(`${text}\n`),
};

const onExit = (code: number) => {
  process.exitCode = code;
};

/**
 * Which bin the user typed. The package links BOTH `jentrix` (primary) and
 * `stacks` (the pre-rename alias, kept for one deprecation window) at this
 * same entry point, and `process.argv[1]` is the path the shell resolved, so
 * its basename names the alias actually invoked. Help text then echoes the
 * command the user really types instead of a name that may not be on their
 * PATH. Windows `.cmd` shims pass the real script path rather than the shim,
 * so an unrecognised basename degrades to the primary name rather than
 * guessing — the notice is advisory, never load-bearing.
 */
const PRIMARY_BIN = "jentrix";
const LEGACY_BIN = "stacks";

export function invokedBinName(argv1: string | undefined): string {
  const base = argv1
    ? basename(argv1).replace(/\.(js|mjs|cjs|cmd|exe|ps1)$/i, "")
    : "";
  return base === LEGACY_BIN ? LEGACY_BIN : PRIMARY_BIN;
}

const invokedAs = invokedBinName(process.argv[1]);

// One line, on stderr, so it can never corrupt `--json` on stdout or break a
// pipeline that parses this command's output.
if (invokedAs === LEGACY_BIN) {
  process.stderr.write(
    `note: \`${LEGACY_BIN}\` is now \`${PRIMARY_BIN}\` — the product was renamed. ` +
      `\`${LEGACY_BIN}\` keeps working; switch when convenient.\n`,
  );
}

const program = new Command();
program
  .name(invokedAs)
  .description(
    "Command-line client for the Jentrix MCP surface. " +
      `Auth: STACKS_TOKEN env, --token, ./.stacks/config.json (per-folder, ` +
      `see \`${invokedAs} login --local\`), or ~/.config/stacks/config.json. ` +
      "The stacks-prefixed env var and config paths are historical and " +
      "deliberately unchanged, so existing installs keep working.",
  )
  // `--version` reports the CLI semver PLUS this build's surface size and the
  // bundled surface.json file's date (its mtime), so freshness is visible
  // without a second command. Count/date degrade gracefully if the bundled
  // manifest is missing.
  .version(
    formatVersion({
      version: CLI_VERSION,
      toolCount: manifest ? manifest.generatedForToolCount : null,
      surfaceFileMtime: surfaceFileMtime(),
    }),
  )
  .configureHelp({ helpWidth: 100 })
  .exitOverride();

registerToolCommand(program, deps, onExit);
registerWhoamiCommand(program, deps, onExit);
registerLoginCommand(program, loginDeps, onExit);
registerLogoutCommand(program, logoutDeps, onExit);
// Client-runtime v2 Phase D: `jentrix runner` is a hidden one-window
// delegate to the `jentrix-runner` bin — doctor/setup/up orchestration lives
// in the runner package now (§15.7).
registerRunnerCommand(
  program,
  {
    resolveRunner: () => resolveRunnerExecutable(process.env),
    runRunner: (file, args) => runRunnerForeground(file, args),
    writeErr: (text) => process.stderr.write(`${text}\n`),
  },
  onExit,
);

// M20.1: connected sessions — hand-registered like the runner group; the
// generated tree never carries process-spawning commands.
const sessionDeps: SessionCommandDeps = {
  env: process.env,
  cwd: () => process.cwd(),
  configPath: CONFIG_PATH,
  resolveTarget: () => {
    const target = resolveConfig({ env: process.env, file: configFile() });
    return {
      token: target.token,
      url: target.url,
      tokenSource: target.tokenSource,
    };
  },
  ensureInstallationId: () => ensureInstallationId(HOME_CONFIG_PATH),
  connect: async (target) => {
    const handle = await deps.connect(target);
    return { caller: handle.caller, close: handle.close };
  },
  writeOut: (text) => process.stdout.write(`${text}\n`),
  writeErr: (text) => process.stderr.write(`${text}\n`),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readLine,
  // Client-runtime v2 D10: the session host ships INSIDE this package —
  // dist/session-host-main.js next to dist/main.js. No PATH lookup, no
  // installed runner; SESSION_HOST overrides for tests/source checkouts.
  resolveSessionHost: () => {
    const override = process.env.SESSION_HOST;
    if (override) return override;
    const hostPath = fileURLToPath(
      new URL("./session-host-main.js", import.meta.url),
    );
    return existsSync(hostPath) ? hostPath : null;
  },
  runSessionHost: (hostPath, planPath, env) =>
    runRunnerForeground(
      process.execPath,
      [hostPath, "run", "--plan-file", planPath],
      env,
    ),
  spawnSessionHostDetached: (hostPath, planPath, logPath, env) => {
    // Background capture host (F-4/AGE-930): survives this process; the
    // child unlinks the 0600 plan file on read; stdio lands in host.log.
    // `env` is the D18 credential channel for non-config tokens — merged
    // into the child's environment, never written to the plan file.
    // Spawned as `node <host.js>` — a plain script, so no Windows .cmd
    // shim indirection (see src/exec-target.ts) applies here.
    const fd = openSync(logPath, "a", 0o600);
    try {
      const child = spawn(
        process.execPath,
        [hostPath, "run", "--plan-file", planPath],
        {
          detached: true,
          stdio: ["ignore", fd, fd],
          ...(env ? { env: { ...process.env, ...env } } : {}),
        },
      );
      child.unref();
      return child.pid ?? -1;
    } finally {
      closeSync(fd);
    }
  },
  spoolRoot: join(homedir(), ".config", "stacks", "session-spool"),
};
const sessionCommand = registerSessionCommand(program, sessionDeps, onExit);
registerSnapshotCommand(sessionCommand, sessionDeps, onExit);
// Client-runtime v2: the two alignment LEVELS ride the same session deps —
// folder (checkout ↔ workspace) and session (work anchoring); `jentrix align`
// stays as a D16 alias of `session align` for one window.
registerFolderCommand(program, sessionDeps, onExit);
registerAlignCommand(program, sessionDeps, onExit);
registerTaskProjectCommand(program, sessionDeps, onExit);
registerMcpCommand(program, sessionDeps, onExit);
registerPushCommand(program, sessionDeps, onExit);

// Single-command toolchain install. The official plugins are PACKAGES this
// CLI depends on (`@jentrix/plugin-claude`, `@jentrix/plugin-codex` — exact
// pins, open-client S3), so their directories are answered by module
// resolution from a file inside the CLI package whose dependency tree should
// decide: this module for an ordinary run, the persistent global copy under
// `jentrix setup`'s npx redirect below. Never a path joined next to dist/.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The resolved directory of `@jentrix/plugin-<provider>`, or null. */
function pluginPackageDir(
  from: string,
  provider: "claude" | "codex",
): string | null {
  try {
    return dirname(
      createRequire(from).resolve(`@jentrix/plugin-${provider}/package.json`),
    );
  } catch {
    return null;
  }
}
/** Plugin resolvers for the CLI package at `packageRoot` (a directory). */
function pluginResolvers(
  packageRoot: string,
): Pick<
  PluginCommandDeps,
  "resolvePluginDir" | "resolveCodexPluginDir" | "cliPackageRoot"
> {
  const from = join(packageRoot, "package.json");
  return {
    resolvePluginDir: () => {
      const dir = pluginPackageDir(from, "claude");
      return dir !== null && isPluginMarketplaceDir(dir) ? dir : null;
    },
    resolveCodexPluginDir: () => {
      const dir = pluginPackageDir(from, "codex");
      return dir !== null && isCodexPluginMarketplaceDir(dir) ? dir : null;
    },
    cliPackageRoot: () => packageRoot,
  };
}
const pluginDeps: PluginCommandDeps = {
  ...pluginResolvers(PACKAGE_ROOT),
  // STA-133: PATH plus the native installer's ~/.local/bin, so a terminal
  // whose PATH predates the Claude Code install still finds the binary.
  resolveClaude: () => resolveClaudeExecutable(process.env),
  resolveCodex: () =>
    resolveExecutableOnPath(platformExecutableNames("codex"), process.env),
  resolveSessionHostBin: () =>
    resolveExecutableOnPath(
      platformExecutableNames("jentrix-session-host"),
      process.env,
    ),
  // JEN-305: the hooks are pinned to the node running this install and to the
  // package's own dist entries, so they resolve without a PATH.
  nodeExecPath: () => process.execPath,
  fileExists: (path) => existsSync(path),
  readTextFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeTextFile: (path, text) => writeFileSync(path, text, "utf8"),
  invoke: invokeRunnerProcess,
  writeOut: (text) => process.stdout.write(`${text}\n`),
  writeErr: (text) => process.stderr.write(`${text}\n`),
  // AGE-952: the one-liner install ends connected — same in-process login
  // reuse as runner setup (never a `jentrix` subprocess).
  hasCredential: () => {
    try {
      resolveConfig({ env: process.env, file: configFile() });
      return true;
    } catch {
      return false;
    }
  },
  login: () => runLoginCommand({}, loginDeps),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};
registerPluginCommand(program, pluginDeps, onExit);
// Open-client S5: the doctor reports the client's own state — versions and
// install source, marketplace ownership, hook pinning, and the adopted
// contract against the endpoint's — through the same resolvers the installer
// uses, so the two can never disagree about where the plugins are.
sessionDeps.client = {
  cliPackageRoot: pluginDeps.cliPackageRoot,
  resolvePluginDir: pluginDeps.resolvePluginDir,
  resolveCodexPluginDir: pluginDeps.resolveCodexPluginDir,
  resolveClaude: pluginDeps.resolveClaude,
  resolveCodex: pluginDeps.resolveCodex,
  invoke: (file, args) => invokeRunnerProcess(file, args),
  fileExists: pluginDeps.fileExists,
  readTextFile: pluginDeps.readTextFile,
  homeDir: () => homedir(),
};

// The universal installer (`npx @jentrix/cli setup`). It reuses the plugin
// deps wholesale rather than restating them — the two commands resolve the
// same executables and share the same in-process login chain, and a second
// copy of that wiring is how the shell installers drifted apart in the first
// place.
registerSetupCommand(
  program,
  {
    ...pluginDeps,
    resolveNpm: () =>
      resolveExecutableOnPath(platformExecutableNames("npm"), process.env),
    // npm's global prefix, read from npm itself — never a PATH probe. Under
    // `npx @jentrix/cli setup` the _npx cache is prepended to PATH and holds a
    // `jentrix` shim, so a PATH answer is always yes and always meaningless.
    globalInstall: async () => {
      const npm = await resolveExecutableOnPath(
        platformExecutableNames("npm"),
        process.env,
      );
      const ask = async (args: string[]) => {
        if (!npm) return null;
        const out = (await invokeRunnerProcess(npm, args)).stdout.trim();
        return out || null;
      };
      const root = await ask(["root", "-g"]);
      const prefix = await ask(["prefix", "-g"]);
      // Windows puts the shims in the prefix itself; posix uses <prefix>/bin.
      const binDir = prefix
        ? process.platform === "win32"
          ? prefix
          : join(prefix, "bin")
        : null;
      const dir = (name: string) => {
        if (!root) return null;
        const candidate = join(root, "@jentrix", name);
        return existsSync(join(candidate, "package.json")) ? candidate : null;
      };
      const cliDir = dir("cli");
      // The installed package's OWN version, not this build's constant: the
      // two differ under `npx`, which is exactly when it matters.
      const versionOf = (packageDir: string | null) => {
        if (!packageDir) return null;
        try {
          const raw = readFileSync(join(packageDir, "package.json"), "utf8");
          const parsed: unknown = JSON.parse(raw);
          const value =
            typeof parsed === "object" && parsed !== null
              ? (parsed as { version?: unknown }).version
              : undefined;
          return typeof value === "string" ? value : null;
        } catch {
          return null;
        }
      };
      return {
        cliDir,
        cliVersion: versionOf(cliDir),
        runnerDir: dir("runner"),
        binDir,
        binDirOnPath: Boolean(
          binDir &&
          (process.env.PATH ?? "")
            .split(delimiter)
            .some((entry) => entry && resolve(entry) === resolve(binDir)),
        ),
        runningFromGlobal: Boolean(
          cliDir && resolve(cliDir) === resolve(PACKAGE_ROOT),
        ),
      };
    },
    resolveGit: () =>
      resolveExecutableOnPath(platformExecutableNames("git"), process.env),
    // Register the plugin from whichever copy of the package PERSISTS. Under
    // `npx @jentrix/cli setup` the running module lives in npm's _npx cache,
    // and a marketplace registered from there dangles the moment npm prunes
    // it. `npm root -g` names the copy that stays.
    installPlugin: async (provider) => {
      const npm = await resolveExecutableOnPath(
        platformExecutableNames("npm"),
        process.env,
      );
      const root = npm
        ? (await invokeRunnerProcess(npm, ["root", "-g"])).stdout.trim() || null
        : null;
      // The persistent copy qualifies only when ITS dependency tree resolves
      // the plugin packages (a pre-S3 global install carries none — then the
      // running copy is the one that can register, exactly as before).
      const packageRoot = persistentPluginRoot(
        root,
        PACKAGE_ROOT,
        (dir) => pluginPackageDir(join(dir, "package.json"), "claude") !== null,
      );
      // W3/C3.4 — BOTH branches validate (`pluginResolvers` checks the
      // marketplace manifest), so a redirected root that cannot resolve a
      // complete plugin package hits the PLUGIN_ASSETS_MISSING refusal instead
      // of dead-ending inside `claude plugin marketplace add`.
      return runPluginInstall(
        packageRoot === PACKAGE_ROOT
          ? pluginDeps
          : { ...pluginDeps, ...pluginResolvers(packageRoot) },
        provider,
      );
    },
    // The endpoint a token actually resolves against — the in-process answer
    // to what install.sh had to ask for with `jentrix whoami --json`.
    signedInUrl: () => {
      try {
        return resolveConfig({ env: process.env, file: configFile() }).url;
      } catch {
        return null;
      }
    },
    login: (flags) => runLoginCommand(flags, loginDeps),
    codexConfigPath: () =>
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
    readTextFile: (path) =>
      existsSync(path) ? readFileSync(path, "utf8") : null,
    appendTextFile: (path, text) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, text);
    },
    // D6 — the checkout's ./.mcp.json (OAuth mode, no credential inside).
    writeTextFile: (path, text) => writeFileSync(path, text, { mode: 0o644 }),
    copyFile: (from, to) => copyFileSync(from, to),
    now: () => new Date(),
    cwd: () => process.cwd(),
    homeDir: () => homedir(),
    git: defaultGitRunner,
    // Client-runtime v2 §14 R1: setup COMPOSES folder alignment — in
    // process, on the session deps, never a `jentrix` subprocess.
    folderAlign: (flags) => runFolderAlign(flags, sessionDeps),
    readLine,
  },
  onExit,
);

// F-6/AGE-932: the upload-grant artifact path, hand-registered (it mixes
// REST + MCP in one flow, which the generated tree never does).
const artifactCommand = registerArtifactCommand(
  program,
  {
    resolveTarget: () => {
      const target = resolveConfig({ env: process.env, file: configFile() });
      return { token: target.token, url: target.url };
    },
    connect: async (target) => {
      const handle = await deps.connect(target);
      return { caller: handle.caller, close: handle.close };
    },
    writeOut: (text) => process.stdout.write(`${text}\n`),
    writeErr: (text) => process.stderr.write(`${text}\n`),
  },
  onExit,
);
// The command the findings-push offer prints (`jentrix artifact mint-issue`) —
// session deps because the mint writes through MCP with correlation.
registerMintIssueCommand(artifactCommand, sessionDeps, onExit);

if (manifest) {
  try {
    mountCommandTree(
      program,
      planCommandTree(manifest, {
        aliases: ALIASES,
        flagRenames: FLAG_RENAMES,
      }),
      { deps, onExit },
    );
  } catch (e) {
    // A manifest this CLI build cannot mount (e.g. regenerated in place)
    // must never take down the escape hatch [C2.2-R1-1].
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `notice: failed to mount generated commands (${detail}) — ` +
        "`jentrix tool <name>` still works\n",
    );
  }
} else {
  program.addHelpText(
    "after",
    "\n(generated commands unavailable: bundled surface.json is missing or " +
      "unreadable — `jentrix tool <name>` still works)",
  );
}

try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof CommanderError) {
    // --help / --version "errors" exit 0; genuine usage errors exit 2.
    // Commander has already printed its message to stderr at this point.
    process.exitCode =
      e.exitCode === 0 ? EXIT_CODES.OK : EXIT_CODES.INVALID_INPUT;
  } else if (e instanceof ConfigError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else if (isFlagError(e)) {
    // Belt-and-braces: coercion errors normally surface as commander usage
    // errors (build.ts wraps them), but never let one become a stack trace.
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = e.exitCode;
  } else {
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: unexpected failure: ${detail}\n`);
    process.exitCode = EXIT_CODES.INTERNAL;
  }
}
