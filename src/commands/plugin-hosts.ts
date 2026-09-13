/**
 * M2 (JEN-537) — `jentrix plugin install|remove opencode|pi`, and the state
 * the doctor reports for them. Neither host has a marketplace: OpenCode loads
 * every `*.js`/`*.ts` under its global `plugins/` folder at startup, and Pi
 * records package paths in its settings through its own CLI. So:
 *
 *   opencode — ONE managed loader file, `<config>/opencode/plugins/jentrix.js`,
 *              whose first line is a `// jentrix-managed:` marker and whose
 *              only statement re-exports the plugin package this CLI depends
 *              on. `opencode.json` is never touched; other plugin files are
 *              left alone; a file at that path that this CLI did not write is
 *              a refusal, never an overwrite. Removal deletes only that file.
 *   pi       — `pi install <package dir>` / `pi remove <package dir>`, and
 *              `pi list` as the activation proof (Pi's own CLI, never its
 *              settings files).
 *
 * Both hosts load plugins at startup, so the ready line says "restart".
 */

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { CLI_VERSION } from "../client";
import { EXIT_CODES } from "../errors";
import type { PluginCommandDeps, PluginInstallOptions } from "./plugin";

export type PluginHost = "opencode" | "pi";

export const HOST_LABEL: Record<PluginHost, string> = {
  opencode: "OpenCode",
  pi: "Pi",
};

const WORKFLOWS = [
  "connect",
  "align",
  "plan",
  "checkpoint",
  "review",
  "status",
  "end",
];

/** OpenCode's global config dir: `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` (what `opencode debug paths` reports). */
export function openCodeConfigDir(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "opencode");
}

/** The ONE file this CLI manages for OpenCode. */
export function openCodeLoaderPath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  return join(openCodeConfigDir(env, home), "plugins", "jentrix.js");
}

const LOADER_MARK = "// jentrix-managed:";

export interface ManagedLoader {
  package: string;
  version: string | null;
  dir: string;
  cli: string;
}

export function renderOpenCodeLoader(
  pluginDir: string,
  version: string | null,
): string {
  const meta: ManagedLoader = {
    package: "@jentrix/plugin-opencode",
    version,
    dir: pluginDir,
    cli: CLI_VERSION,
  };
  const entry = pathToFileURL(join(pluginDir, "src", "index.js")).href;
  return [
    `${LOADER_MARK}${JSON.stringify(meta)}`,
    "// Written by `jentrix plugin install opencode`; `jentrix plugin remove opencode` deletes it.",
    "// Do not edit: OpenCode loads this file at startup and it only re-exports the",
    "// @jentrix/plugin-opencode package the Jentrix CLI depends on.",
    `export { JentrixOpenCodePlugin } from ${JSON.stringify(entry)};`,
    "",
  ].join("\n");
}

/** The marker of a loader THIS CLI wrote, or null for any other file. */
export function parseManagedLoader(text: string | null): ManagedLoader | null {
  if (text === null) return null;
  const first = text.split("\n")[0] ?? "";
  if (!first.startsWith(LOADER_MARK)) return null;
  try {
    const parsed = JSON.parse(first.slice(LOADER_MARK.length)) as Partial<ManagedLoader>;
    return typeof parsed.dir === "string"
      ? {
          package: typeof parsed.package === "string" ? parsed.package : "",
          version: typeof parsed.version === "string" ? parsed.version : null,
          dir: parsed.dir,
          cli: typeof parsed.cli === "string" ? parsed.cli : "",
        }
      : null;
  } catch {
    return null;
  }
}

function normalizePath(raw: string): string {
  const r = resolve(raw).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Does `pi list` name this package directory? Matched on the normalised path. */
export function piListNames(stdout: string, pluginDir: string): boolean {
  const wanted = normalizePath(pluginDir);
  return stdout
    .split("\n")
    .some((line) => {
      const l = process.platform === "win32" ? line.toLowerCase() : line;
      return l.includes(wanted) || l.includes(wanted + sep);
    });
}

/** The pure fs check `main.ts` runs on a resolved package dir. */
export function isHostPluginDir(
  host: PluginHost,
  dir: string,
  readTextFile: (path: string) => string | null,
): boolean {
  const manifest = readTextFile(join(dir, "manifest.json"));
  if (manifest === null) return false;
  try {
    const parsed = JSON.parse(manifest) as { host?: unknown };
    return parsed.host === host;
  } catch {
    return false;
  }
}

export interface StagedHostPlugin {
  version: string;
  commands: number;
  problems: string[];
}

/** STAGE before anything moves: manifest, entry and the seven commands. */
export function stageHostPlugin(
  deps: Pick<PluginCommandDeps, "fileExists" | "readTextFile">,
  host: PluginHost,
  pluginDir: string,
): StagedHostPlugin {
  const problems: string[] = [];
  let version = "(no version)";
  const manifestPath = join(pluginDir, "manifest.json");
  const manifestText = deps.readTextFile(manifestPath);
  if (manifestText === null) {
    problems.push(`manifest.json missing or unreadable (${manifestPath})`);
  } else {
    try {
      const manifest = JSON.parse(manifestText) as { host?: unknown; version?: unknown };
      if (manifest.host !== host)
        problems.push(`manifest.json is for ${JSON.stringify(manifest.host)}, expected "${host}"`);
      if (typeof manifest.version === "string") version = manifest.version;
      else problems.push("manifest.json carries no version");
    } catch {
      problems.push(`manifest.json is not JSON (${manifestPath})`);
    }
  }
  if (!deps.fileExists(join(pluginDir, "src", "index.js")))
    problems.push("src/index.js (the plugin entry) is missing");
  let commands = 0;
  for (const name of WORKFLOWS) {
    if (deps.fileExists(join(pluginDir, "commands", `jentrix-${name}.md`))) commands += 1;
    else problems.push(`commands/jentrix-${name}.md is missing`);
  }
  return { version, commands, problems };
}

function pluginDirOf(deps: PluginCommandDeps, host: PluginHost): string | null {
  return host === "opencode"
    ? (deps.resolveOpenCodePluginDir?.() ?? null)
    : (deps.resolvePiPluginDir?.() ?? null);
}

function envOf(deps: PluginCommandDeps): Record<string, string | undefined> {
  return deps.env?.() ?? {};
}

function homeOf(deps: PluginCommandDeps): string {
  return deps.homeDir?.() ?? homedir();
}

const READY: Record<PluginHost, string> = {
  opencode:
    "Jentrix plugin ready for OpenCode: /jentrix-connect, /jentrix-align, /jentrix-plan, /jentrix-checkpoint, /jentrix-status, /jentrix-review, /jentrix-end load in NEW OpenCode sessions — restart OpenCode (plugins load at startup; a run started with --pure loads none).",
  pi: "Jentrix package ready for Pi: /jentrix-connect, /jentrix-align, /jentrix-plan, /jentrix-checkpoint, /jentrix-status, /jentrix-review, /jentrix-end load in NEW Pi sessions — restart Pi (extensions load at startup; a run started with --no-extensions loads none).",
};

export async function installHostPlugin(
  deps: PluginCommandDeps,
  host: PluginHost,
  options: PluginInstallOptions,
  finish: (deps: PluginCommandDeps, ready: string) => Promise<number>,
): Promise<number> {
  const pluginDir = pluginDirOf(deps, host);
  if (!pluginDir) {
    deps.writeErr(
      `PLUGIN_ASSETS_MISSING: this install cannot resolve @jentrix/plugin-${host} — reinstall with npm install -g @jentrix/cli, then retry.`,
    );
    return EXIT_CODES.INTERNAL;
  }
  const staged = stageHostPlugin(deps, host, pluginDir);
  if (staged.problems.length > 0) {
    deps.writeErr(
      `PLUGIN_STAGE_FAILED: ${pluginDir} is not a complete Jentrix ${host} plugin (${staged.problems.join("; ")}) — nothing was changed; reinstall with npm install -g @jentrix/cli, then retry.`,
    );
    return EXIT_CODES.INTERNAL;
  }
  if (host === "opencode") {
    const loaderPath = openCodeLoaderPath(envOf(deps), homeOf(deps));
    if (options.dryRun) {
      deps.writeOut(
        `dry run: would write the managed loader ${loaderPath} → ${pluginDir} (plugin ${staged.version}, ${staged.commands} commands; opencode.json untouched). Nothing written.`,
      );
      return EXIT_CODES.OK;
    }
    if (!(await deps.resolveOpenCode?.())) {
      deps.writeErr(
        "OPENCODE_NOT_INSTALLED: the plugin installs into OpenCode — install the `opencode` CLI first (https://opencode.ai), then retry.",
      );
      return 2;
    }
    const existing = deps.readTextFile(loaderPath);
    const managed = parseManagedLoader(existing);
    if (existing !== null && managed === null) {
      deps.writeErr(
        `PLUGIN_LOADER_CONFLICT: ${loaderPath} exists and was not written by this CLI — inspect it; move it aside if it is stale, then retry. Nothing was changed.`,
      );
      return EXIT_CODES.INVALID_INPUT;
    }
    const rendered = renderOpenCodeLoader(pluginDir, staged.version);
    if (existing === rendered) {
      deps.writeOut(`Managed loader already current: ${loaderPath} → ${pluginDir} (plugin ${staged.version}).`);
      return finish(deps, READY[host]);
    }
    try {
      deps.ensureDir?.(join(loaderPath, ".."));
      deps.writeTextFile(loaderPath, rendered);
    } catch (error) {
      deps.writeErr(
        `PLUGIN_INSTALL_FAILED: could not write ${loaderPath} (${error instanceof Error ? error.message : String(error)}).`,
      );
      return EXIT_CODES.INTERNAL;
    }
    if (deps.readTextFile(loaderPath) !== rendered) {
      deps.writeErr(`PLUGIN_INSTALL_FAILED: ${loaderPath} does not read back as written.`);
      return EXIT_CODES.INTERNAL;
    }
    deps.writeOut(
      managed !== null && !samePath(managed.dir, pluginDir)
        ? `Managed loader repointed: ${loaderPath} pointed at ${managed.dir} (an earlier copy) → ${pluginDir} (plugin ${staged.version}).`
        : `Managed loader written: ${loaderPath} → ${pluginDir} (plugin ${staged.version}).`,
    );
    return finish(deps, READY[host]);
  }
  // pi
  if (options.dryRun) {
    deps.writeOut(
      `dry run: would run \`pi install ${pluginDir}\` (plugin ${staged.version}, ${staged.commands} commands; Pi records the path in its settings). Nothing installed.`,
    );
    return EXIT_CODES.OK;
  }
  const pi = await deps.resolvePi?.();
  if (!pi) {
    deps.writeErr(
      "PI_NOT_INSTALLED: the package installs into Pi — install the `pi` CLI first (npm install -g @earendil-works/pi-coding-agent), then retry.",
    );
    return 2;
  }
  const before = await deps.invoke(pi, ["list"]);
  if (before.code === 0 && piListNames(before.stdout, pluginDir)) {
    deps.writeOut(`Pi package already registered: ${pluginDir} (plugin ${staged.version}).`);
    return finish(deps, READY[host]);
  }
  const installed = await deps.invoke(pi, ["install", pluginDir]);
  if (installed.code !== 0) {
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: \`pi install ${pluginDir}\` exited ${installed.code}${installed.stderr.trim() ? `: ${installed.stderr.trim().split("\n")[0]}` : ""}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  const after = await deps.invoke(pi, ["list"]);
  if (after.code !== 0 || !piListNames(after.stdout, pluginDir)) {
    deps.writeErr(
      `PLUGIN_INSTALL_FAILED: activation not proven — \`pi list\` does not name ${pluginDir} after \`pi install\`.`,
    );
    return EXIT_CODES.INTERNAL;
  }
  deps.writeOut(`Pi package registered: ${pluginDir} (plugin ${staged.version}).`);
  return finish(deps, READY[host]);
}

export async function removeHostPlugin(
  deps: PluginCommandDeps,
  host: PluginHost,
): Promise<number> {
  if (host === "opencode") {
    const loaderPath = openCodeLoaderPath(envOf(deps), homeOf(deps));
    const existing = deps.readTextFile(loaderPath);
    if (existing === null) {
      deps.writeOut(`Nothing to remove: no managed loader at ${loaderPath}.`);
      return EXIT_CODES.OK;
    }
    if (parseManagedLoader(existing) === null) {
      deps.writeErr(
        `PLUGIN_LOADER_CONFLICT: ${loaderPath} was not written by this CLI — not removed. Inspect it yourself.`,
      );
      return EXIT_CODES.INVALID_INPUT;
    }
    if (!deps.deleteFile) {
      deps.writeErr("PLUGIN_REMOVE_FAILED: this build cannot delete files.");
      return EXIT_CODES.INTERNAL;
    }
    deps.deleteFile(loaderPath);
    deps.writeOut(
      `Managed loader removed: ${loaderPath}. Running OpenCode sessions keep the plugin until they exit; opencode.json and other plugin files were not touched.`,
    );
    return EXIT_CODES.OK;
  }
  const pluginDir = pluginDirOf(deps, host);
  if (!pluginDir) {
    deps.writeErr(
      `PLUGIN_ASSETS_MISSING: this install cannot resolve @jentrix/plugin-${host}, so it cannot name the path Pi recorded — run \`pi list\` and \`pi remove <path>\` yourself.`,
    );
    return EXIT_CODES.INTERNAL;
  }
  const pi = await deps.resolvePi?.();
  if (!pi) {
    deps.writeErr("PI_NOT_INSTALLED: the `pi` CLI is not on PATH — nothing to remove from.");
    return 2;
  }
  const before = await deps.invoke(pi, ["list"]);
  if (before.code === 0 && !piListNames(before.stdout, pluginDir)) {
    deps.writeOut(`Nothing to remove: \`pi list\` does not name ${pluginDir}.`);
    return EXIT_CODES.OK;
  }
  const removed = await deps.invoke(pi, ["remove", pluginDir]);
  if (removed.code !== 0) {
    deps.writeErr(
      `PLUGIN_REMOVE_FAILED: \`pi remove ${pluginDir}\` exited ${removed.code}${removed.stderr.trim() ? `: ${removed.stderr.trim().split("\n")[0]}` : ""}`,
    );
    return EXIT_CODES.INTERNAL;
  }
  deps.writeOut(`Pi package removed: ${pluginDir}. Running Pi sessions keep the extension until they exit.`);
  return EXIT_CODES.OK;
}

/** What the doctor reports for a plugin host: where the host would load the plugin from. */
export interface HostPluginState {
  /** The registration the host reads: the loader file (opencode) or the `pi list` row. */
  registration:
    | { kind: "loader"; path: string; state: "absent" | "foreign" | "managed"; target: string | null }
    | { kind: "pi-list"; state: "unavailable" | "absent" | "present"; detail: string };
  /** The package.json of the copy the host would LOAD, when it can be named. */
  loadedPackageJson: string | null;
}

export async function hostPluginState(
  deps: Pick<PluginCommandDeps, "readTextFile" | "fileExists" | "invoke"> & {
    env?: () => Record<string, string | undefined>;
    homeDir?: () => string;
    resolvePi?: () => Promise<string | null>;
  },
  host: PluginHost,
  pluginDir: string,
): Promise<HostPluginState> {
  if (host === "opencode") {
    const path = openCodeLoaderPath(deps.env?.() ?? {}, deps.homeDir?.() ?? homedir());
    const text = deps.readTextFile(path);
    const managed = parseManagedLoader(text);
    return {
      registration: {
        kind: "loader",
        path,
        state: text === null ? "absent" : managed === null ? "foreign" : "managed",
        target: managed?.dir ?? null,
      },
      loadedPackageJson: managed ? join(managed.dir, "package.json") : null,
    };
  }
  const pi = await deps.resolvePi?.();
  if (!pi) {
    return {
      registration: { kind: "pi-list", state: "unavailable", detail: "pi is not installed here" },
      loadedPackageJson: null,
    };
  }
  const listed = await deps.invoke(pi, ["list"]);
  if (listed.code !== 0) {
    return {
      registration: { kind: "pi-list", state: "unavailable", detail: `\`pi list\` exited ${listed.code}` },
      loadedPackageJson: null,
    };
  }
  const present = piListNames(listed.stdout, pluginDir);
  return {
    registration: {
      kind: "pi-list",
      state: present ? "present" : "absent",
      detail: present ? `\`pi list\` names ${pluginDir}` : `\`pi list\` does not name ${pluginDir}`,
    },
    loadedPackageJson: present ? join(pluginDir, "package.json") : null,
  };
}
