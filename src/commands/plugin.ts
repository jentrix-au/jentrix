/**
 * `jentrix plugin install [claude|codex]` — install either official provider
 * plugin so one command covers the whole local toolchain.
 *
 *   npm install -g @jentrix/cli && jentrix plugin install
 *
 * Since open-client S3 (PRD §5.2, §5.3) the plugins are their own packages —
 * `@jentrix/plugin-claude` and `@jentrix/plugin-codex`, exact dependencies of
 * this CLI — and their directories are RESOLVED (`main.ts`, module
 * resolution), never joined from a path next to dist/. Their skills and
 * trusted lifecycle hooks match the CLI version by the dependency pin.
 *
 * The hooks execute `jentrix-session-host hook`, a bin of THIS package: on a
 * global install it is resolvable exactly when `jentrix` is, so there is no
 * second package to install (the old @jentrix/runner self-heal is gone). The
 * one machine that can differ is an `npx` run — the hook bin lives in npx's
 * throwaway cache — so a missing bin is a WARNING naming the global install,
 * never an auto-install.
 */

import { existsSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";

import { Command } from "commander";

import { CLI_VERSION } from "../client";
import { EXIT_CODES } from "../errors";

export interface PluginInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

export type PluginProvider = "claude" | "codex";

export interface PluginCommandDeps {
  /** Absolute path of the resolved Claude plugin package dir, or null. */
  resolvePluginDir: () => string | null;
  /** Absolute path of the resolved Codex plugin package dir, or null. */
  resolveCodexPluginDir: () => string | null;
  /**
   * The CLI package root whose `dist/` the hooks are pinned to — the running
   * package, or the persistent global copy under `jentrix setup`'s redirect.
   * The plugin packages no longer live inside it, so it cannot be derived
   * from a plugin directory (open-client S3).
   */
  cliPackageRoot: () => string;
  /** Absolute path of the `claude` executable, or null when not on PATH. */
  resolveClaude: () => Promise<string | null>;
  /** Absolute path of the `codex` executable, or null when not on PATH. */
  resolveCodex: () => Promise<string | null>;
  /** Absolute path of `jentrix-session-host`, or null (the hooks' bin). */
  resolveSessionHostBin: () => Promise<string | null>;
  /** The node binary running this CLI — what the hooks are pinned to. */
  nodeExecPath: () => string;
  /** Does this path (file OR directory) exist? Also probes ownership. */
  fileExists: (path: string) => boolean;
  /** Read a UTF-8 file, or null when it is absent or unreadable. */
  readTextFile: (path: string) => string | null;
  /** Write a UTF-8 file. Throws on failure; the caller degrades gracefully. */
  writeTextFile: (path: string, text: string) => void;
  invoke: (
    file: string,
    args: string[],
    stdin?: string,
    timeoutMs?: number,
  ) => Promise<PluginInvocation>;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
  /** Is a token already resolvable (env / config file)? Same as runner setup. */
  hasCredential: () => boolean;
  /** In-process `jentrix login` (interactive server picker included). */
  login: () => Promise<number>;
  /** TTY on both ends — gates the post-install login chain. */
  isInteractive: boolean;
}

export interface PluginInstallOptions {
  /**
   * Resolve and validate the plugin package, print what WOULD be registered
   * (directory, manifests, hook count, the pin target) and stop: no provider
   * executable is needed, nothing is written or invoked. The pack smoke runs
   * this in a clean prefix with no `claude`/`codex` present.
   */
  dryRun?: boolean;
}

/** The marketplace + plugin identity shared by both official plugins. */
const MARKETPLACE_NAME = "jentrix";
const PLUGIN_REF = "jentrix@jentrix";

/**
 * The pre-rename plugin identity. A machine that installed the plugin before
 * the rename still has it registered under this name, registering the same six
 * commands — and once the installer drops the superseded npm package, its
 * marketplace points into a `node_modules` directory that no longer exists,
 * so Claude Code carries it as "failed to load". Duplicate at best, dangling
 * at worst; neither is a state to leave an operator in.
 */
const LEGACY_MARKETPLACE = "stacks";
const LEGACY_PLUGIN_REF = "stacks@stacks";

/**
 * Retire the pre-rename plugin, after the new one is in place so a failure
 * here can never leave a machine with neither.
 *
 * The MARKETPLACE removal is the probe, not the plugin removal: `claude
 * plugin uninstall` and `codex plugin marketplace remove` both exit non-zero
 * on a name they don't have, but `codex plugin remove` exits 0 for a plugin
 * that was never installed — probing on that would announce a removal on
 * every fresh Codex machine. Both providers agree on the marketplace call, so
 * that one decides what we claim.
 *
 * Best-effort throughout: a machine that never had the old plugin takes both
 * non-zero exits silently, and nothing here can fail the install it follows.
 */
async function removeLegacyPlugin(
  deps: PluginCommandDeps,
  executable: string,
  provider: PluginProvider,
): Promise<string> {
  // Plugin first, then its marketplace — the reverse orphans the entry.
  await deps.invoke(executable, [
    "plugin",
    provider === "codex" ? "remove" : "uninstall",
    LEGACY_PLUGIN_REF,
  ]);
  const dropped = await deps.invoke(executable, [
    "plugin",
    "marketplace",
    "remove",
    LEGACY_MARKETPLACE,
  ]);
  return dropped.code === 0
    ? ` Removed the pre-rename plugin (\`${LEGACY_PLUGIN_REF}\`) — it registered these same commands.`
    : "";
}

/** Does a failed `claude plugin …` invocation mean "already there"? */
function alreadyExists(result: PluginInvocation): boolean {
  return /already/i.test(`${result.stdout}\n${result.stderr}`);
}

function relayFailure(
  deps: PluginCommandDeps,
  step: string,
  result: PluginInvocation,
  restored = "",
): number {
  const detail = (result.stderr || result.stdout).trim();
  deps.writeErr(
    `PLUGIN_INSTALL_FAILED: \`${step}\` exited ${result.code}${detail ? `: ${detail}` : ""}${restored}`,
  );
  return EXIT_CODES.INTERNAL;
}

/**
 * Which copy of the CLI package should the plugin be registered FROM.
 *
 * Both providers register a marketplace as a LOCAL DIRECTORY, so that path has
 * to outlive the install. It normally does — the plugin packages sit in the
 * global npm package's dependency tree. But `npx @jentrix/cli setup`, the
 * universal installer's own entry point, runs out of npm's `_npx` cache:
 * registering from there points Claude Code and Codex at a directory npm is
 * free to prune, which is the dangling-marketplace state the pre-rename plugin
 * left behind (`removeLegacyPlugin` above exists to clean up exactly that).
 *
 * So once a global install exists, it is the copy the plugin is registered
 * from, whoever is doing the registering. PURE — `exists` is injected (it
 * answers whether that copy can resolve the plugin packages), and the
 * fallback is the running module, which is correct for every non-npx run.
 */
export function persistentPluginRoot(
  globalNodeModules: string | null,
  ownRoot: string,
  exists: (dir: string) => boolean,
): string {
  if (!globalNodeModules) return ownRoot;
  const global = join(globalNodeModules, "@jentrix", "cli");
  return exists(global) ? global : ownRoot;
}

/**
 * Verify a resolved plugin dir is a Claude plugin marketplace (it carries
 * `.claude-plugin/marketplace.json`). Exported for main.ts's resolver.
 */
export function isPluginMarketplaceDir(dir: string): boolean {
  return existsSync(join(dir, ".claude-plugin", "marketplace.json"));
}

/**
 * Are two marketplace source paths the same directory? Codex stores ITS
 * canonicalized form of the path it was handed — on Windows that is a
 * `\\?\C:\…` verbatim path (Rust's `fs::canonicalize`), and NTFS compares
 * case-insensitively — so a byte-equal `resolve()` check reports a conflict
 * against a registration this same build just wrote, and every re-run of
 * `jentrix setup` dead-ends on PLUGIN_MARKETPLACE_CONFLICT (observed on the
 * 0.5.18 Windows first run). Strip the verbatim prefix, resolve with win32
 * semantics, case-fold. Exported for tests; `win` is only overridden there.
 */
function normalizePluginPath(raw: string, win: boolean): string {
  const bare = raw.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const abs = win ? win32.resolve(bare) : resolve(bare);
  return win ? abs.toLowerCase() : abs;
}

export function samePluginPath(
  a: string,
  b: string,
  win = process.platform === "win32",
): boolean {
  return normalizePluginPath(a, win) === normalizePluginPath(b, win);
}

/** What the ownership rule needs from the filesystem — `PluginCommandDeps` is one. */
export interface PluginPathProbe {
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string | null;
}

/** The packages whose installed directories this installer may repoint. */
const OUR_PACKAGES = new Set([
  "@jentrix/cli",
  "@jentrix/plugin-claude",
  "@jentrix/plugin-codex",
]);

/**
 * An INSTALLED copy of one of our packages, in any global layout: npm global
 * (`<prefix>/lib/node_modules/@jentrix/cli/node_modules/@jentrix/plugin-*`),
 * Homebrew (`…/libexec/lib/node_modules/@jentrix/…`), pnpm global
 * (`…/.pnpm/@jentrix+plugin-claude@x/node_modules/@jentrix/plugin-claude`) and
 * the persistent root an `npx` bootstrap installs into (`…/_npx/…/node_modules/
 * @jentrix/…`) all put the package under `node_modules/@jentrix/<name>/`; so
 * does the pre-S3 bundled layout (`…/@jentrix/cli/plugins/<provider>`, and
 * before 0.6.0 `…/@jentrix/cli/<provider>-plugin`), which is exactly what the
 * migration has to recognise once it dangles. A dev checkout never does.
 */
const INSTALLED_LAYOUT =
  /[\\/]node_modules[\\/]@jentrix[\\/](?:cli|plugin-claude|plugin-codex)(?=[\\/]|$)/i;

/** The `name` of the nearest package.json at or above `path`, or null. */
function nearestPackageName(
  path: string,
  probe: PluginPathProbe,
  win: boolean,
): string | null {
  const P = win ? win32 : posix;
  let dir = normalizePluginPath(path, win);
  for (;;) {
    const manifest = P.join(dir, "package.json");
    if (probe.fileExists(manifest)) {
      const parsed = parseJsonObject(probe.readTextFile(manifest) ?? "");
      return typeof parsed?.name === "string" ? parsed.name : null;
    }
    const up = P.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Is `path` an installed copy of OUR packages? The layout is the first test;
 * when the directory still exists the nearest package.json walking up must
 * name one of ours (a foreign package cannot sit under our node_modules
 * name, but a squatted directory could); when it dangles — the upgraded
 * package no longer ships that directory — the layout is the whole evidence,
 * which is the case the migration exists for.
 */
export function isOwnInstalledPluginPath(
  path: string,
  probe: PluginPathProbe,
  win = process.platform === "win32",
): boolean {
  const normalized = normalizePluginPath(path, win);
  if (!INSTALLED_LAYOUT.test(normalized)) return false;
  if (!probe.fileExists(normalized) && !probe.fileExists(path)) return true;
  const owner = nearestPackageName(path, probe, win);
  return owner !== null && OUR_PACKAGES.has(owner);
}

/**
 * Is a stale marketplace row provably an EARLIER COPY OF THE SAME INSTALL —
 * rather than something the operator registered themselves (W3/C3.3)?
 *
 * Two shapes qualify, and only two:
 *
 * 1. **A sibling of the directory being registered.** `…/claude-plugin` next
 *    to `…/codex-plugin`, or `@jentrix/plugin-claude` next to
 *    `@jentrix/plugin-codex` — one root, the wrong half of it.
 * 2. **Another installed copy of our packages**, when the directory being
 *    registered is one too: the `_npx`-cache copy `npx @jentrix/cli setup`
 *    registers and npm is free to prune (`persistentPluginRoot` above), the
 *    global install of an older Node version after an nvm switch, or the
 *    bundled `plugins/<provider>` directory the pre-S3 CLI carried and this
 *    one no longer ships (open-client S3 — the four global layouts named on
 *    `isOwnInstalledPluginPath`).
 *
 * The second condition is deliberately symmetric. An earlier draft asked only
 * whether the EXISTING row looked like ours, and a dev checkout's `plugin
 * install codex` then silently repointed a machine's real global registration
 * at the checkout — observed live, 2026-08-27. "Ours" has to mean the same
 * distribution, not merely a familiar-looking path; a checkout is never an
 * installed layout, in either direction.
 *
 * Everything else is FOREIGN and still refused: an operator who pointed the
 * `jentrix` marketplace somewhere on purpose gets a refusal, not a repoint.
 */
export function isOwnStalePluginPath(
  source: string,
  pluginDir: string,
  probe: PluginPathProbe,
  win = process.platform === "win32",
): boolean {
  const from = normalizePluginPath(source, win);
  const to = normalizePluginPath(pluginDir, win);
  const parent = (path: string) => path.replace(/[\\/][^\\/]*$/, "");
  if (parent(from) === parent(to)) return true;
  return (
    isOwnInstalledPluginPath(source, probe, win) &&
    isOwnInstalledPluginPath(pluginDir, probe, win)
  );
}

export function isCodexPluginMarketplaceDir(dir: string): boolean {
  return existsSync(join(dir, ".agents", "plugins", "marketplace.json"));
}

/**
 * JEN-305 — the hooks are launched by ABSOLUTE PATH, not by name.
 *
 * Both official plugins ship their hooks as bare commands
 * (`jentrix-session-host hook …`, `jentrix session snapshot …`), which resolve
 * only if the process running the hook has this package's bin directory on its
 * PATH. An INTERACTIVE terminal does; a Claude Code launched from the macOS
 * Dock inherits launchd's minimal PATH and does not — and on this Mac the bin
 * exists only under nvm. The hook then fails to resolve, silently: Claude Code
 * retains no hook stderr, so the only symptom is a session that can be bound
 * but never recorded, which is JEN-303's worst input.
 *
 * `plugin install` therefore rewrites both commands to
 * `"<node>" "<pkg>/dist/<entry>.js" <verb> …` before the marketplace add or
 * update — before, because the by-version cache Claude Code copies is taken at
 * that moment. Quoted absolute paths, no `sh -c` and no `$HOME`: the same form
 * has to stay valid on Windows, which has no POSIX shell to expand either
 * (STA-131).
 *
 * The rewrite is IDEMPOTENT and re-run on every install (which `jentrix setup`
 * re-runs after every upgrade), because an install-time absolute path goes
 * stale the moment nvm switches node versions — the JEN-297 class of failure.
 * Idempotence comes from keying on the VERB rather than on the leading token:
 * whatever precedes `hook` or `session` is discarded and rebuilt, so a
 * previously rewritten file rewrites to itself.
 */
export function absoluteHookCommand(
  command: string,
  nodePath: string,
  hostScript: string,
  cliScript: string,
): string {
  const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
  // The verb the plugins declare: `hook` belongs to the session-host bin,
  // `session` (snapshot) to the CLI. Exact-token match, so a directory that
  // happens to be named "session" inside a QUOTED path can never be mistaken
  // for it.
  const verbAt = tokens.findIndex((t) => t === "hook" || t === "session");
  if (verbAt < 0) return command;
  const script = tokens[verbAt] === "hook" ? hostScript : cliScript;
  // A path containing a double quote cannot be quoted portably. Leaving the
  // command alone is the safe answer: the bare form still works wherever PATH
  // carries the bin, which is every case that works today.
  if (nodePath.includes('"') || script.includes('"')) return command;
  return [`"${nodePath}"`, `"${script}"`, ...tokens.slice(verbAt)].join(" ");
}

/** Where a provider's plugin package keeps its `hooks.json`. */
export function hookFilePath(
  provider: PluginProvider,
  pluginDir: string,
): string {
  return provider === "codex"
    ? join(pluginDir, "plugins", "jentrix", "hooks", "hooks.json")
    : join(pluginDir, "hooks", "hooks.json");
}

/** The two dist entries the hooks are pinned to, under a CLI package root. */
function hookScripts(packageRoot: string): {
  hostScript: string;
  cliScript: string;
} {
  return {
    hostScript: join(packageRoot, "dist", "session-host-main.js"),
    cliScript: join(packageRoot, "dist", "main.js"),
  };
}

/**
 * Rewrite the plugin package's hook commands in place. Never fails the
 * install: a read-only install directory, a missing file or unparseable JSON
 * all leave the shipped bare commands, which are exactly today's behaviour.
 */
function pinHookCommands(
  deps: PluginCommandDeps,
  provider: PluginProvider,
  pluginDir: string,
): void {
  const file = hookFilePath(provider, pluginDir);
  // The scripts come from the CLI package that OWNS this install (the running
  // package, or the persistent copy `jentrix setup` redirects to) — the
  // plugin package is a sibling dependency, not a parent, so nothing can be
  // derived from `pluginDir` (open-client S3).
  const packageRoot = deps.cliPackageRoot();
  const { hostScript, cliScript } = hookScripts(packageRoot);
  // Pinning to a path that does not exist would BREAK hooks that work today
  // through PATH — a dev checkout with no build is the case that matters.
  if (!deps.fileExists(hostScript) || !deps.fileExists(cliScript)) {
    deps.writeOut(
      `Hook commands left as shipped: ${packageRoot} carries no built dist/ to pin them to.`,
    );
    return;
  }
  const raw = deps.readTextFile(file);
  const parsed = raw === null ? null : parseJsonObject(raw);
  if (!parsed) {
    deps.writeOut(`Hook commands left as shipped: cannot read ${file}.`);
    return;
  }
  const nodePath = deps.nodeExecPath();
  let rewritten = 0;
  for (const entry of hookEntries(parsed)) {
    const next = absoluteHookCommand(
      entry.command,
      nodePath,
      hostScript,
      cliScript,
    );
    if (next !== entry.command) rewritten += 1;
    entry.command = next;
  }
  try {
    deps.writeTextFile(file, `${JSON.stringify(parsed, null, 2)}\n`);
    deps.writeOut(
      rewritten === 0
        ? `Hook commands already pinned to ${nodePath}.`
        : `Hook commands pinned to ${nodePath} (${rewritten} rewritten) so they resolve without PATH.`,
    );
  } catch {
    deps.writeOut(
      `Hook commands left as shipped: ${file} is not writable — the hooks need \`jentrix-session-host\` on PATH.`,
    );
  }
}

/** Every `{ command }` hook entry of a parsed hooks.json, in document order. */
function hookEntries(parsed: Record<string, unknown>): { command: string }[] {
  const out: { command: string }[] = [];
  for (const groups of Object.values(
    (parsed.hooks ?? {}) as Record<string, unknown>,
  )) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const hooks = (group as { hooks?: unknown }).hooks;
      for (const hook of Array.isArray(hooks) ? hooks : []) {
        const entry = hook as { command?: unknown };
        if (typeof entry.command === "string") {
          out.push(entry as { command: string });
        }
      }
    }
  }
  return out;
}

/** The provider manifests a plugin package must carry to be registered. */
function manifestPaths(
  provider: PluginProvider,
  pluginDir: string,
): { marketplace: string; plugin: string; hooks: string } {
  return provider === "codex"
    ? {
        marketplace: join(pluginDir, ".agents", "plugins", "marketplace.json"),
        plugin: join(
          pluginDir,
          "plugins",
          "jentrix",
          ".codex-plugin",
          "plugin.json",
        ),
        hooks: hookFilePath("codex", pluginDir),
      }
    : {
        marketplace: join(pluginDir, ".claude-plugin", "marketplace.json"),
        plugin: join(pluginDir, ".claude-plugin", "plugin.json"),
        hooks: hookFilePath("claude", pluginDir),
      };
}

interface StagedPlugin {
  version: string;
  hookCommands: number;
  problems: string[];
}

/**
 * STAGE the resolved package before anything moves (open-client S3, two-phase
 * migration): the marketplace manifest must name `jentrix`, the plugin
 * manifest must parse with a version, and the hooks file must parse. A
 * failure here leaves whatever registration exists exactly as it was.
 */
function stagePlugin(
  deps: PluginCommandDeps,
  provider: PluginProvider,
  pluginDir: string,
): StagedPlugin {
  const paths = manifestPaths(provider, pluginDir);
  const problems: string[] = [];
  const read = (file: string, label: string) => {
    const parsed = parseJsonObject(deps.readTextFile(file) ?? "");
    if (!parsed) problems.push(`${label} missing or unreadable (${file})`);
    return parsed;
  };
  const marketplace = read(paths.marketplace, "marketplace.json");
  if (marketplace && marketplace.name !== MARKETPLACE_NAME) {
    problems.push(
      `marketplace.json names ${JSON.stringify(marketplace.name)}, expected "${MARKETPLACE_NAME}"`,
    );
  }
  const plugin = read(paths.plugin, "plugin.json");
  const version =
    typeof plugin?.version === "string" ? plugin.version : "(no version)";
  if (plugin && typeof plugin.version !== "string") {
    problems.push("plugin.json carries no version");
  }
  const hooks = read(paths.hooks, "hooks.json");
  const hookCommands = hooks ? hookEntries(hooks).length : 0;
  if (hooks && hookCommands === 0) problems.push("hooks.json declares no hook");
  return { version, hookCommands, problems };
}

async function finishInstall(
  deps: PluginCommandDeps,
  ready: string,
): Promise<number> {
  deps.writeOut(ready);
  if (!deps.hasCredential()) {
    if (deps.isInteractive) {
      deps.writeOut("");
      deps.writeOut("No Jentrix credentials found — let's connect you now.");
      const login = await deps.login();
      if (login !== EXIT_CODES.OK) {
        deps.writeOut(
          "You can connect later with `jentrix login` (or `jentrix login " +
            "--local` to bind just one folder to a server).",
        );
      }
    } else {
      deps.writeOut(
        "Next: run `jentrix login` to connect to your Jentrix server.",
      );
    }
  }
  return EXIT_CODES.OK;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Restore the registration a failed swap displaced — best effort, and SAID
 * either way. Returns the sentence appended to the failure line.
 */
async function restorePrevious(
  deps: PluginCommandDeps,
  executable: string,
  provider: PluginProvider,
  previous: string | null,
): Promise<string> {
  if (previous === null) return "";
  await deps.invoke(executable, [
    "plugin",
    "marketplace",
    "remove",
    MARKETPLACE_NAME,
  ]);
  const readd = await deps.invoke(executable, [
    "plugin",
    "marketplace",
    "add",
    previous,
    ...(provider === "codex" ? ["--json"] : []),
  ]);
  return readd.code === 0
    ? ` — the previous registration at ${previous} was restored`
    : ` — the previous registration at ${previous} could NOT be restored (\`${provider} plugin marketplace add ${previous}\` exited ${readd.code}); run it by hand`;
}

/**
 * The `jentrix` row of a `codex plugin marketplace list --json` document:
 * null when there is none, else its local directory (null for a non-local
 * source). Exported for the doctor, which reads the same listing.
 */
export function parseCodexMarketplaceRow(
  stdout: string,
): { path: string | null } | null {
  const catalog = parseJsonObject(stdout);
  if (!catalog) return null;
  const marketplaces = Array.isArray(catalog.marketplaces)
    ? (catalog.marketplaces as Array<Record<string, unknown>>)
    : [];
  const existing = marketplaces.find((row) => row.name === MARKETPLACE_NAME);
  if (!existing) return null;
  const source = existing.marketplaceSource as
    { sourceType?: unknown; source?: unknown } | undefined;
  return {
    path:
      source?.sourceType === "local" && typeof source.source === "string"
        ? source.source
        : null,
  };
}

/** The `jentrix` row's local source of a Codex marketplace listing. */
function codexRowSource(listing: PluginInvocation): {
  supported: boolean;
  row: boolean;
  local: string | null;
} {
  if (listing.code !== 0 || !parseJsonObject(listing.stdout)) {
    return { supported: false, row: false, local: null };
  }
  const row = parseCodexMarketplaceRow(listing.stdout);
  if (!row) return { supported: true, row: false, local: null };
  return { supported: true, row: true, local: row.path };
}

/**
 * The directory Codex blames when it refuses to LIST because our own
 * marketplace row dangles — observed on this Mac after the 0.6.0 layout
 * change: `Error: failed to load marketplace(s):\n- \`jentrix\` at
 * <path>/@jentrix/cli/codex-plugin: marketplace root does not contain a
 * supported manifest`. Codex exits 1 and prints no catalog at all, so the
 * installer could neither read nor repair the row it had itself written.
 */
export function danglingCodexMarketplace(
  listing: PluginInvocation,
): string | null {
  const text = `${listing.stdout}\n${listing.stderr}`;
  const match = /`jentrix` at (.+?): marketplace root does not contain/.exec(
    text,
  );
  return match ? match[1]!.trim() : null;
}

async function installCodexPlugin(
  deps: PluginCommandDeps,
  codex: string,
  pluginDir: string,
  expectedVersion: string,
): Promise<number> {
  let listed = await deps.invoke(codex, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  // The registration a failed swap must put back.
  let previous: string | null = null;
  if (listed.code !== 0) {
    // A dangling row of OURS makes Codex refuse the whole listing. The same
    // ownership rule as the repoint below applies: an installed copy of our
    // packages is repaired and SAID; anything else is relayed as before.
    const dangling = danglingCodexMarketplace(listed);
    if (dangling !== null && isOwnStalePluginPath(dangling, pluginDir, deps)) {
      const removed = await deps.invoke(codex, [
        "plugin",
        "marketplace",
        "remove",
        MARKETPLACE_NAME,
      ]);
      if (removed.code !== 0) {
        return relayFailure(
          deps,
          `codex plugin marketplace remove ${MARKETPLACE_NAME}`,
          removed,
        );
      }
      deps.writeOut(
        `Marketplace "${MARKETPLACE_NAME}" pointed at a stale copy of this CLI (${dangling}) that Codex could no longer load — removed; registering ${pluginDir}.`,
      );
      previous = dangling;
      listed = await deps.invoke(codex, [
        "plugin",
        "marketplace",
        "list",
        "--json",
      ]);
    }
    if (listed.code !== 0) {
      return relayFailure(deps, "codex plugin marketplace list --json", listed);
    }
  }
  const existing = codexRowSource(listed);
  if (existing.row) {
    const local = existing.local;
    if (local === null || !samePluginPath(local, pluginDir)) {
      // W3/C3.3 — a row pointing at an installed copy of our packages is
      // provably OUR OWN earlier write (a `claude-plugin` sibling, a pruned
      // `_npx` copy, an old global after an nvm switch, the bundled
      // `plugins/codex` of a pre-S3 CLI). Dead-ending the installer on a mess
      // it made itself is what the "never re-run setup" prose existed to work
      // around; repair it and say what was repaired instead.
      if (local !== null && isOwnStalePluginPath(local, pluginDir, deps)) {
        previous = local;
        const removed = await deps.invoke(codex, [
          "plugin",
          "marketplace",
          "remove",
          MARKETPLACE_NAME,
        ]);
        if (removed.code !== 0) {
          return relayFailure(
            deps,
            `codex plugin marketplace remove ${MARKETPLACE_NAME}`,
            removed,
          );
        }
        const readded = await deps.invoke(codex, [
          "plugin",
          "marketplace",
          "add",
          pluginDir,
          "--json",
        ]);
        if (readded.code !== 0) {
          return relayFailure(
            deps,
            "codex plugin marketplace add",
            readded,
            await restorePrevious(deps, codex, "codex", previous),
          );
        }
        deps.writeOut(
          `Marketplace "${MARKETPLACE_NAME}" pointed at a stale copy of this CLI (${local}) — repointed to ${pluginDir}.`,
        );
      } else {
        deps.writeErr(
          `PLUGIN_MARKETPLACE_CONFLICT: Codex marketplace "${MARKETPLACE_NAME}" points at ${local ?? "a non-local source"}, which this install did not write — inspect with \`codex plugin marketplace list\`; if that registration is stale, run \`codex plugin marketplace remove ${MARKETPLACE_NAME}\` and retry`,
        );
        return EXIT_CODES.INVALID_INPUT;
      }
    } else {
      deps.writeOut(
        `Marketplace "${MARKETPLACE_NAME}" already registered (${pluginDir}).`,
      );
    }
  } else {
    const added = await deps.invoke(codex, [
      "plugin",
      "marketplace",
      "add",
      pluginDir,
      "--json",
    ]);
    if (added.code !== 0) {
      return relayFailure(deps, "codex plugin marketplace add", added);
    }
    deps.writeOut(`Marketplace "${MARKETPLACE_NAME}" added (${pluginDir}).`);
  }

  const installed = await deps.invoke(codex, [
    "plugin",
    "add",
    PLUGIN_REF,
    "--json",
  ]);
  if (installed.code !== 0 && !alreadyExists(installed)) {
    return relayFailure(
      deps,
      "codex plugin add",
      installed,
      await restorePrevious(deps, codex, "codex", previous),
    );
  }
  // ACTIVATION PROOF (open-client S3): the marketplace row must now name the
  // directory we registered, and the plugin must be installed from it. A
  // swap that cannot prove this is undone, not reported as done.
  const after = codexRowSource(
    await deps.invoke(codex, ["plugin", "marketplace", "list", "--json"]),
  );
  if (
    after.supported &&
    (after.local === null || !samePluginPath(after.local, pluginDir))
  ) {
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: activation not proven — \`codex plugin marketplace list --json\` shows "${MARKETPLACE_NAME}" at ${after.local ?? "a non-local source"}, expected ${pluginDir}${await restorePrevious(deps, codex, "codex", previous)}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  const verified = await deps.invoke(codex, ["plugin", "list", "--json"]);
  if (verified.code !== 0) {
    return relayFailure(
      deps,
      "codex plugin list --json",
      verified,
      await restorePrevious(deps, codex, "codex", previous),
    );
  }
  const inventory = parseJsonObject(verified.stdout);
  const rows = Array.isArray(inventory?.installed)
    ? (inventory.installed as Array<Record<string, unknown>>)
    : [];
  const row = rows.find(
    (candidate) =>
      candidate.pluginId === PLUGIN_REF && candidate.installed === true,
  );
  if (!row) {
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: \`codex plugin list --json\` did not report ${PLUGIN_REF} as installed${await restorePrevious(deps, codex, "codex", previous)}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  // "Installed" alone proved nothing about WHICH copy: `codex plugin add`
  // treats an already-installed plugin as a benign no-op, so a stale
  // by-version cache answered `installed: true` and this command reported the
  // new skills and hooks as ready when the old ones were still in place
  // (JEN-330). The row names the version and the directory it was installed
  // from; both must be this CLI's.
  if (typeof row.version === "string" && row.version !== expectedVersion) {
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: activation not proven — \`codex plugin list --json\` reports ${PLUGIN_REF} at version ${row.version}, expected ${expectedVersion} (a stale by-version cache)${await restorePrevious(deps, codex, "codex", previous)}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  const sourcePath =
    row.source && typeof row.source === "object"
      ? (row.source as { path?: unknown }).path
      : undefined;
  if (typeof sourcePath === "string" && !isInsidePluginDir(sourcePath, pluginDir)) {
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: activation not proven — \`codex plugin list --json\` reports ${PLUGIN_REF} installed from ${sourcePath}, expected a directory under ${pluginDir}${await restorePrevious(deps, codex, "codex", previous)}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  return finishInstall(
    deps,
    "Jentrix Codex plugin ready: $jentrix-connect, $jentrix-align, $jentrix-plan, " +
      "$jentrix-checkpoint, $jentrix-status, $jentrix-review, and $jentrix-end are available in NEW " +
      "Codex tasks. Type `/hooks` at Codex's own prompt (in-session, not a shell command) and trust the Jentrix hooks before use." +
      (await removeLegacyPlugin(deps, codex, "codex")),
  );
}

/**
 * The `jentrix` row of `claude plugin marketplace list --json`: `supported`
 * is false for a Claude Code too old for `--json` (the caller falls through
 * to the plain add→update path it always had, and cannot prove activation);
 * `row` is null when there is none; `path` is the registered directory for a
 * directory source, null for git/github rows.
 */
/**
 * Is `child` `pluginDir` itself or a directory under it? Codex installs the
 * plugin from `<marketplace root>/plugins/jentrix`, so the row's source path
 * is INSIDE the directory the installer registered, never equal to it.
 */
function isInsidePluginDir(child: string, pluginDir: string): boolean {
  const normalize = (value: string) =>
    value.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const inner = normalize(child);
  const outer = normalize(pluginDir);
  return inner === outer || inner.startsWith(`${outer}/`);
}

async function claudeMarketplaceListing(
  deps: PluginCommandDeps,
  claude: string,
): Promise<{
  supported: boolean;
  row: { path: string | null; source: string | null } | null;
}> {
  const listed = await deps.invoke(claude, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  if (listed.code !== 0) return { supported: false, row: null };
  const row = parseClaudeMarketplaceRow(listed.stdout);
  if (row === undefined) return { supported: false, row: null };
  return { supported: true, row };
}

/**
 * The `jentrix` row of a `claude plugin marketplace list --json` document:
 * `undefined` when the text is not that document (a Claude Code too old for
 * `--json`), null when there is no row, else the registered directory for a
 * directory source (null for git/github rows) and the source kind. Exported
 * for the doctor, which reads the same listing.
 */
export function parseClaudeMarketplaceRow(
  stdout: string,
): { path: string | null; source: string | null } | null | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find(
    (r): r is Record<string, unknown> =>
      typeof r === "object" &&
      r !== null &&
      (r as { name?: unknown }).name === MARKETPLACE_NAME,
  );
  if (!row) return null;
  return {
    path: typeof row.path === "string" ? row.path : null,
    source: typeof row.source === "string" ? row.source : null,
  };
}

export async function runPluginInstall(
  deps: PluginCommandDeps,
  provider: PluginProvider = "claude",
  options: PluginInstallOptions = {},
): Promise<number> {
  const pluginDir =
    provider === "codex"
      ? deps.resolveCodexPluginDir()
      : deps.resolvePluginDir();
  if (!pluginDir) {
    deps.writeErr(
      `PLUGIN_ASSETS_MISSING: this install cannot resolve @jentrix/plugin-${provider} — reinstall with npm install -g @jentrix/cli, then retry.`,
    );
    return EXIT_CODES.INTERNAL;
  }
  // Phase 1 of the two-phase install: stage the package. Nothing has moved
  // yet, so a refusal here leaves any existing registration untouched.
  const staged = stagePlugin(deps, provider, pluginDir);
  if (staged.problems.length > 0) {
    deps.writeErr(
      `PLUGIN_STAGE_FAILED: ${pluginDir} is not a complete Jentrix ${provider} plugin (${staged.problems.join("; ")}) — the existing registration, if any, is untouched; reinstall with npm install -g @jentrix/cli, then retry.`,
    );
    return EXIT_CODES.INTERNAL;
  }
  if (options.dryRun) {
    const packageRoot = deps.cliPackageRoot();
    const { hostScript, cliScript } = hookScripts(packageRoot);
    deps.writeOut(
      `dry run: would register ${pluginDir} as marketplace "${MARKETPLACE_NAME}" for ${provider} (plugin ${staged.version}, hooks.json with ${staged.hookCommands} hook commands pinned to "${deps.nodeExecPath()}" + ${hostScript} / ${cliScript}${deps.fileExists(hostScript) && deps.fileExists(cliScript) ? "" : " — NOT built, hooks would be left as shipped"}). Nothing registered.`,
    );
    return EXIT_CODES.OK;
  }
  const executable =
    provider === "codex"
      ? await deps.resolveCodex()
      : await deps.resolveClaude();
  if (!executable) {
    deps.writeErr(
      provider === "codex"
        ? "CODEX_NOT_INSTALLED: the plugin installs into Codex — install the `codex` CLI first, then retry."
        : "CLAUDE_NOT_INSTALLED: the plugin installs into Claude Code — install the `claude` CLI first (https://claude.com/claude-code), then retry.",
    );
    return 2;
  }
  if (!(await deps.resolveSessionHostBin())) {
    // The hooks run `jentrix-session-host hook` — a bin of this very package,
    // so a global install always has it. Warn (don't fail, don't install):
    // the one path here is npx, whose cache evaporates after this run.
    deps.writeOut(
      "WARNING: `jentrix-session-host` is not on PATH — the plugin's lifecycle hooks need it. Install the CLI globally (`npm install -g @jentrix/cli@" +
        CLI_VERSION +
        "`) so the hooks resolve it.",
    );
  }

  // JEN-305 — BEFORE either marketplace call, for both providers: Claude Code
  // and Codex copy the plugin into a by-version cache at add/update time, so a
  // rewrite after that lands only in the package directory nobody executes.
  pinHookCommands(deps, provider, pluginDir);

  if (provider === "codex") {
    return installCodexPlugin(deps, executable, pluginDir, staged.version);
  }

  const claude = executable;

  // JEN-297: read the registry FIRST (the Codex branch's shape). "Refresh the
  // existing row" was the only move here, and `marketplace update` on a row
  // whose directory is gone — the pre-0.6.0 `claude-plugin/` layout, a pruned
  // `_npx` cache, an older global after an nvm switch, the bundled
  // `plugins/claude` a pre-S3 CLI carried — dead-ended every operator who
  // upgraded across the layout change with PLUGIN_INSTALL_FAILED and no
  // repair. A row that is provably an earlier copy of THIS install is
  // repointed and SAID; a foreign row is still refused, never repointed.
  const listing = await claudeMarketplaceListing(deps, claude);
  const registered = listing.row;
  // Phase 2: swap. `previous` is what a failed swap must put back.
  let previous: string | null = null;
  if (
    registered !== null &&
    (registered.path === null || !samePluginPath(registered.path, pluginDir))
  ) {
    if (
      registered.path === null ||
      !isOwnStalePluginPath(registered.path, pluginDir, deps)
    ) {
      deps.writeErr(
        `PLUGIN_MARKETPLACE_CONFLICT: Claude Code marketplace "${MARKETPLACE_NAME}" points at ${registered.path ?? `a non-local source (${registered.source ?? "unknown"})`}, which this install did not write — inspect with \`claude plugin marketplace list\`; if that registration is stale, run \`claude plugin marketplace remove ${MARKETPLACE_NAME}\` and retry`,
      );
      return EXIT_CODES.INVALID_INPUT;
    }
    previous = registered.path;
    const removed = await deps.invoke(claude, [
      "plugin",
      "marketplace",
      "remove",
      MARKETPLACE_NAME,
    ]);
    if (removed.code !== 0) {
      return relayFailure(
        deps,
        `claude plugin marketplace remove ${MARKETPLACE_NAME}`,
        removed,
      );
    }
    deps.writeOut(
      `Marketplace "${MARKETPLACE_NAME}" pointed at a stale copy of this CLI (${registered.path}) — repointed to ${pluginDir}.`,
    );
  }

  // Marketplace: add the resolved dir; when the name is already registered
  // (an earlier install, or a dev checkout's own source), refresh it instead
  // of repointing — the npm path is stable across upgrades, so refresh is all
  // an upgrade needs.
  const add = await deps.invoke(claude, [
    "plugin",
    "marketplace",
    "add",
    pluginDir,
  ]);
  if (add.code !== 0) {
    if (!alreadyExists(add)) {
      return relayFailure(
        deps,
        "claude plugin marketplace add",
        add,
        await restorePrevious(deps, claude, "claude", previous),
      );
    }
    const refresh = await deps.invoke(claude, [
      "plugin",
      "marketplace",
      "update",
      MARKETPLACE_NAME,
    ]);
    if (refresh.code !== 0) {
      return relayFailure(deps, "claude plugin marketplace update", refresh);
    }
    deps.writeOut(
      `Marketplace "${MARKETPLACE_NAME}" already present — refreshed.`,
    );
  } else {
    // JEN-465: on a Claude Code whose `marketplace add` exits 0 for a row it
    // already has, a no-change re-run read "added" — as if it had registered
    // something. The listing above already knew the row was right.
    const unchanged =
      registered !== null &&
      registered.path !== null &&
      samePluginPath(registered.path, pluginDir);
    deps.writeOut(
      unchanged
        ? `Marketplace "${MARKETPLACE_NAME}" already registered (${pluginDir}).`
        : `Marketplace "${MARKETPLACE_NAME}" added (${pluginDir}).`,
    );
  }

  const install = await deps.invoke(claude, ["plugin", "install", PLUGIN_REF]);
  if (install.code !== 0 && !alreadyExists(install)) {
    return relayFailure(
      deps,
      "claude plugin install",
      install,
      await restorePrevious(deps, claude, "claude", previous),
    );
  }
  // AGE-977: the update is UNCONDITIONAL. `claude plugin install` treats an
  // already-installed plugin as a benign no-op and exits 0, so keying the
  // update off a FAILED install left every upgrading operator on their old
  // plugin — while this command printed "Plugin installed" and the ready
  // banner. The plugin package has no other delivery path into Claude Code's
  // by-version cache: a silent no-op here means new skills and hooks never
  // arrive. (Reproduced 2026-08-11: cli 0.4.19 shipped plugin 0.3.0 and the
  // cache stayed at 0.2.3.)
  const update = await deps.invoke(claude, ["plugin", "update", PLUGIN_REF]);
  if (update.code !== 0 && !alreadyExists(update)) {
    return relayFailure(
      deps,
      "claude plugin update",
      update,
      await restorePrevious(deps, claude, "claude", previous),
    );
  }
  // ACTIVATION PROOF (open-client S3): when Claude Code can list its
  // marketplaces, the `jentrix` row must now name the directory we
  // registered. A swap that cannot prove this is undone, not reported as done.
  if (listing.supported) {
    const after = await claudeMarketplaceListing(deps, claude);
    if (
      after.supported &&
      (after.row === null ||
        after.row.path === null ||
        !samePluginPath(after.row.path, pluginDir))
    ) {
      deps.writeErr(
        `PLUGIN_INSTALL_FAILED: activation not proven — \`claude plugin marketplace list --json\` shows "${MARKETPLACE_NAME}" at ${after.row?.path ?? "no directory"}, expected ${pluginDir}${await restorePrevious(deps, claude, "claude", previous)}`,
      );
      return EXIT_CODES.INTERNAL;
    }
  }
  // Report what the update actually DID rather than asserting success: the
  // version transition is the only evidence the operator has that the copy in
  // place is this CLI's copy. Both wordings are true whether the install was
  // fresh or a no-op — which the exit code alone cannot distinguish.
  const updated = `${update.stdout}\n${update.stderr}`.match(
    /updated from ([\w.-]+) to ([\w.-]+)/i,
  );
  if (updated && updated[2] !== staged.version) {
    // The provider says it moved the cache — to a version that is not the
    // one this CLI staged, so the copy in place is still not this CLI's.
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: activation not proven — \`claude plugin update\` reports ${updated[1]} → ${updated[2]}, expected ${staged.version}${await restorePrevious(deps, claude, "claude", previous)}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  deps.writeOut(
    updated
      ? `Plugin updated ${updated[1]} → ${updated[2]} (this CLI's copy).`
      : "Plugin in place at this CLI's copy.",
  );

  return finishInstall(
    deps,
    `Jentrix plugin ready: /jentrix-connect, /jentrix-align, /jentrix-plan, /jentrix-checkpoint, /jentrix-status, /jentrix-review, /jentrix-end are available in NEW Claude Code sessions (running sessions pick it up on restart).${await removeLegacyPlugin(deps, claude, "claude")}`,
  );
}

export function registerPluginCommand(
  program: Command,
  deps: PluginCommandDeps,
  onExit: (code: number) => void,
): Command {
  const plugin = program
    .command("plugin")
    .description(
      "Manage the official Claude Code and Codex plugins (skills + lifecycle hooks).",
    );
  plugin
    .command("install [provider]")
    .description(
      "Install (or refresh) the Jentrix plugin into Claude Code (default) or Codex from the plugin package this CLI depends on.",
    )
    .option(
      "--dry-run",
      "resolve and validate the plugin package and print what would be registered; register nothing",
    )
    .action(
      async (provider: string | undefined, flags: { dryRun?: boolean }) => {
        if (
          provider !== undefined &&
          provider !== "claude" &&
          provider !== "codex"
        ) {
          deps.writeErr('error: provider must be "claude" or "codex"');
          onExit(EXIT_CODES.INVALID_INPUT);
          return;
        }
        onExit(
          await runPluginInstall(deps, provider ?? "claude", {
            dryRun: Boolean(flags.dryRun),
          }),
        );
      },
    );
  return plugin;
}
