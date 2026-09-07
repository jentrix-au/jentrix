/**
 * The CLIENT half of `jentrix session doctor` (open-client S5, PRD §7 —
 * "official versus custom"): what is installed and where it came from, who
 * owns each provider's `jentrix` marketplace, whether the hooks are pinned
 * and whether the provider's cached copy matches, and how this build's
 * ADOPTED contract compares with the one the endpoint serves. Read-only,
 * uploads nothing, and never demands byte equality after the hook rewrite
 * (D12: integrity is transformation-aware).
 *
 * Pure classifiers first (unit-tested on fixtures), then `clientChecks`,
 * which runs them over the injected probes the installer already uses.
 */
import { join } from "node:path";

import { CLI_VERSION } from "../client";
import { createSessionRedactor } from "../session-host/session-redact";
import {
  hookFilePath,
  isOwnInstalledPluginPath,
  readClaudeListing,
  readCodexListing,
  samePluginPath,
  type PluginInvocation,
  type PluginPathProbe,
  type PluginProvider,
} from "./plugin";
import type { DoctorCheck, SessionCommandDeps } from "./session";

/** What the client checks need — the installer's own resolvers, injected. */
export interface ClientProbeDeps extends PluginPathProbe {
  cliPackageRoot(): string;
  resolvePluginDir(): string | null;
  resolveCodexPluginDir(): string | null;
  resolveClaude(): Promise<string | null>;
  resolveCodex(): Promise<string | null>;
  invoke(file: string, args: string[]): Promise<PluginInvocation>;
  homeDir(): string;
}

export type InstallSource =
  "npm global" | "Homebrew" | "pnpm" | "npx cache" | "dev checkout";

/**
 * Where an installed package directory came from, read off its path: every
 * global install puts our packages under `node_modules/@jentrix/<name>`; the
 * segments around it say which tool did. Anything outside `node_modules` is a
 * checkout of the source tree.
 */
export function installSource(dir: string): InstallSource {
  const p = dir.replace(/\\/g, "/");
  if (!/\/node_modules\/@jentrix\//i.test(p)) return "dev checkout";
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(p)) return "Homebrew";
  if (/\/\.pnpm\//.test(p) || /\/pnpm\/global\//.test(p)) return "pnpm";
  if (/\/_npx\//.test(p)) return "npx cache";
  return "npm global";
}

export type MarketplaceOwnership =
  "official" | "official-stale" | "user-managed" | "unregistered" | "unknown";

/**
 * Who owns the provider's `jentrix` marketplace row. `registered` is the
 * row's directory (null = no row; undefined = the listing was unavailable);
 * `pluginDir` is the package this CLI would register.
 */
export function classifyMarketplace(
  registered: string | null | undefined,
  pluginDir: string | null,
  probe: PluginPathProbe,
): MarketplaceOwnership {
  if (registered === undefined) return "unknown";
  if (registered === null) return "unregistered";
  if (pluginDir !== null && samePluginPath(registered, pluginDir)) {
    return "official";
  }
  return isOwnInstalledPluginPath(registered, probe)
    ? "official-stale"
    : "user-managed";
}

/** Every `command` string of a hooks.json, in document order. */
export function hookCommands(text: string | null): string[] | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return null;
  const out: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray((group as { hooks?: unknown }).hooks)
        ? ((group as { hooks: unknown[] }).hooks as unknown[])
        : []) {
        const command = (hook as { command?: unknown }).command;
        if (typeof command === "string") out.push(command);
      }
    }
  }
  return out;
}

/**
 * The absolute script the hooks are pinned to (JEN-305), or null when they
 * still ship as bare commands. Read off the first `hook` verb: a pinned
 * command is `"<node>" "<script>" hook …`, so the second quoted token is the
 * target.
 */
export function pinnedHookTarget(commands: string[]): string | null {
  for (const command of commands) {
    const tokens = command.match(/"[^"]*"|\S+/g) ?? [];
    const verbAt = tokens.findIndex((t) => t === "hook");
    if (verbAt < 0) continue;
    if (
      verbAt >= 2 &&
      tokens[0]!.startsWith('"') &&
      tokens[1]!.startsWith('"')
    ) {
      return tokens[1]!.slice(1, -1);
    }
    return null;
  }
  return null;
}

/**
 * The redacted support bundle `jentrix session doctor --bundle` writes
 * (PRD §8 Phase 5, T6): what a support request needs and NOTHING a support
 * request must not carry. Built from the doctor's checks only — never from
 * a transcript, a spool, a hooks file or any other file's contents — so the
 * exclusions are structural: only the four check fields are copied, `data`
 * survives for the contract check alone (both sides of the digest
 * comparison), every string passes the session redactor (token literals and
 * patterns → ‹redacted›, the home directory → ~), and the error categories
 * are the UPPER_SNAKE codes the failing checks led with, not their prose.
 * The user previews the file and shares it by hand; nothing uploads it.
 */
export interface DoctorBundle {
  kind: "jentrix-doctor-bundle";
  bundleVersion: 1;
  generatedAt: string;
  cli: { version: string };
  platform: { os: string; arch: string; node: string };
  summary: { ok: number; warn: number; fail: number; skip: number };
  /** The categories of what went wrong in this run — codes, never messages. */
  errorCategories: string[];
  checks: Array<{
    name: string;
    status: DoctorCheck["status"];
    detail: string;
    fix?: string;
    data?: Record<string, unknown>;
  }>;
}

export function doctorBundle(
  checks: DoctorCheck[],
  opts: {
    env: Record<string, string | undefined>;
    homedir: string | null;
    /** Extra literals to scrub — the resolved bearer, when there is one. */
    literals?: string[];
    now?: Date;
    node?: string;
    os?: string;
    arch?: string;
  },
): DoctorBundle {
  const redactor = createSessionRedactor({
    env: opts.env,
    homedir: opts.homedir,
    literals: opts.literals ?? [],
  });
  const text = (s: string) => redactor.text(s);
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  const errorCategories = new Set<string>();
  const out: DoctorBundle["checks"] = [];
  for (const check of checks) {
    summary[check.status] += 1;
    if (check.status === "fail" || check.status === "warn") {
      const code = /^([A-Z][A-Z0-9_]{3,})\b/.exec(check.detail)?.[1];
      errorCategories.add(
        code ??
          `${check.name.replace(/\s+/g, "_").toUpperCase()}_${check.status.toUpperCase()}`,
      );
    }
    const entry: DoctorBundle["checks"][number] = {
      name: check.name,
      status: check.status,
      detail: text(check.detail),
    };
    if (check.fix) entry.fix = text(check.fix);
    // Only the contract check's structured facts travel: adopted vs served
    // surface, release and digest. Anything else a check attached (a
    // transcript excerpt, a hook body, a file) is not what support needs.
    if (check.name === "contract" && check.data) {
      entry.data = JSON.parse(text(JSON.stringify(check.data))) as Record<
        string,
        unknown
      >;
    }
    out.push(entry);
  }
  return {
    kind: "jentrix-doctor-bundle",
    bundleVersion: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    cli: { version: CLI_VERSION },
    platform: {
      os: opts.os ?? process.platform,
      arch: opts.arch ?? process.arch,
      node: opts.node ?? process.version,
    },
    summary,
    errorCategories: [...errorCategories],
    checks: out,
  };
}

export interface AdoptedContract {
  surface: string;
  apiRelease: string;
  digest: string;
}

export interface ServedContract {
  surface: string;
  apiRelease: string;
  digest: string;
  publicationState?: string;
  supportedReleases?: string[];
}

function semver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The connect-time decision order (PRD §5.4, "client side"): surface must
 * match; the API release must be inside the client's range (same major); the
 * server must still list that line as supported; an equal digest is the
 * TESTED contract; a different digest inside the range is COMPATIBLE DRIFT —
 * disclosed, never a refusal (D5).
 */
export function compareContract(
  adopted: AdoptedContract | null,
  served: ServedContract | null,
  endpoint: string,
): DoctorCheck {
  const name = "contract";
  if (adopted === null) {
    return {
      name,
      status: "fail",
      detail:
        "this install carries no contract.json — the CLI was not built from an adopted contract",
      fix: "reinstall: npm i -g @jentrix/cli",
    };
  }
  const data: Record<string, unknown> = {
    adopted,
    ...(served ? { served } : {}),
  };
  if (served === null) {
    return {
      name,
      status: "warn",
      detail: `adopted ${adopted.surface} ${adopted.apiRelease} (digest ${adopted.digest.slice(0, 12)}…) — could not read ${endpoint}/contract to compare`,
      data,
    };
  }
  if (served.surface !== adopted.surface) {
    return {
      name,
      status: "fail",
      detail: `SURFACE_MISMATCH: this CLI targets the ${adopted.surface} surface; ${endpoint} serves ${served.surface} (D11 — ops is not a compatibility target)`,
      data,
    };
  }
  const a = semver(adopted.apiRelease);
  const s = semver(served.apiRelease);
  if (!a || !s) {
    return {
      name,
      status: "warn",
      detail: `unreadable release (adopted ${adopted.apiRelease}, served ${served.apiRelease})`,
      data,
    };
  }
  if (s[0] !== a[0]) {
    return {
      name,
      status: "fail",
      detail: `API release ${served.apiRelease} at ${endpoint} is outside this build's range (^${adopted.apiRelease})`,
      fix: "upgrade the CLI: npm i -g @jentrix/cli",
      data,
    };
  }
  const line = `${a[0]}.x`;
  if (
    Array.isArray(served.supportedReleases) &&
    !served.supportedReleases.includes(line)
  ) {
    return {
      name,
      status: "fail",
      detail: `release line ${line} is no longer supported by ${endpoint} (supported: ${served.supportedReleases.join(", ")})`,
      fix: "upgrade the CLI: npm i -g @jentrix/cli",
      data,
    };
  }
  const state =
    served.publicationState && served.publicationState !== "supported"
      ? ` — endpoint publication state: ${served.publicationState}`
      : "";
  if (served.digest === adopted.digest) {
    return {
      name,
      status: "ok",
      detail: `tested contract: ${adopted.surface} ${adopted.apiRelease}, digest ${adopted.digest.slice(0, 12)}… matches ${endpoint}${state}`,
      data,
    };
  }
  const behind = s[1] < a[1] || (s[1] === a[1] && s[2] < a[2]);
  return {
    name,
    status: "warn",
    detail: `compatible drift: ${endpoint} serves ${served.apiRelease} (digest ${served.digest.slice(0, 12)}…), this build adopted ${adopted.apiRelease} (digest ${adopted.digest.slice(0, 12)}…)${behind ? " — the server is BEHIND this build; commands for newer tools will be refused" : " — newer tools are not generated locally"}${state}`,
    fix: behind ? undefined : "upgrade the CLI: npm i -g @jentrix/cli",
    data,
  };
}

function readJson(
  probe: PluginPathProbe,
  path: string,
): Record<string, unknown> | null {
  const text = probe.readTextFile(path);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const MANIFEST: Record<PluginProvider, string> = {
  claude: join(".claude-plugin", "plugin.json"),
  codex: join("plugins", "jentrix", ".codex-plugin", "plugin.json"),
};

/** The client checks, appended to the doctor's list. Empty without probes. */
export async function clientChecks(
  deps: Pick<SessionCommandDeps, "client" | "fetchImpl" | "resolveTarget">,
): Promise<DoctorCheck[]> {
  const client = deps.client;
  if (!client) return [];
  const checks: DoctorCheck[] = [];
  const root = client.cliPackageRoot();
  checks.push({
    name: "cli",
    status: "ok",
    detail: `@jentrix/cli ${CLI_VERSION} — ${installSource(root)} (${root})`,
  });

  for (const provider of ["claude", "codex"] as const) {
    const pluginDir =
      provider === "codex"
        ? client.resolveCodexPluginDir()
        : client.resolvePluginDir();
    const pkg = `@jentrix/plugin-${provider}`;
    if (pluginDir === null) {
      checks.push({
        name: `plugin ${provider}`,
        status: "fail",
        detail: `${pkg} does not resolve from this install`,
        fix: "reinstall: npm i -g @jentrix/cli",
      });
      continue;
    }
    const packaged = readJson(client, join(pluginDir, "package.json"));
    const manifest = readJson(client, join(pluginDir, MANIFEST[provider]));
    const packagedVersion =
      typeof packaged?.version === "string" ? packaged.version : null;
    const manifestVersion =
      typeof manifest?.version === "string" ? manifest.version : null;
    checks.push(
      packagedVersion !== null && packagedVersion === manifestVersion
        ? {
            name: `plugin ${provider}`,
            status: "ok",
            detail: `${pkg} ${packagedVersion} — ${installSource(pluginDir)} (${pluginDir})`,
          }
        : {
            name: `plugin ${provider}`,
            status: "warn",
            detail: `${pkg} package ${packagedVersion ?? "?"} vs manifest ${manifestVersion ?? "?"} at ${pluginDir} — one version source, two readers`,
            fix: "reinstall: npm i -g @jentrix/cli",
          },
    );

    // Marketplace ownership, from the provider's own listing.
    const executable =
      provider === "codex"
        ? await client.resolveCodex()
        : await client.resolveClaude();
    if (!executable) {
      checks.push({
        name: `marketplace ${provider}`,
        status: "skip",
        detail: `${provider} is not installed here`,
      });
      continue;
    }
    const listed = await client.invoke(executable, [
      "plugin",
      "marketplace",
      "list",
      "--json",
    ]);
    // Four states with the evidence (JEN-466). The fallback used to print
    // the first line of the listing — "{" for a pretty-printed catalog with
    // no `jentrix` row — and a row Codex had left unlabeled read as
    // "Unregistered". Ownership still keys on the SOURCE: a row that names
    // none falls back to its `root`, a git row never does.
    const read =
      provider === "codex"
        ? readCodexListing(listed)
        : readClaudeListing(listed);
    const command = `\`${provider} plugin marketplace list --json\``;
    const row = read.local;
    const ownership =
      read.state === "non-local"
        ? "user-managed"
        : classifyMarketplace(
            read.state === "exited" || read.state === "not-json"
              ? undefined
              : row,
            pluginDir,
            client,
          );
    const label = {
      official: "Official",
      "official-stale": "Official (stale copy)",
      "user-managed": "User-managed",
      unregistered: "Unregistered",
      unknown: "Unknown",
    }[ownership];
    checks.push(
      ownership === "official"
        ? {
            name: `marketplace ${provider}`,
            status: "ok",
            detail: `${label}: jentrix → ${row}${read.unlabeled ? " (its root; Codex reported no source for the row)" : ""}`,
          }
        : ownership === "official-stale"
          ? {
              name: `marketplace ${provider}`,
              status: "warn",
              detail: `${label}: jentrix → ${row} is an earlier installed copy, not this package`,
              fix: `jentrix plugin install ${provider}`,
            }
          : ownership === "user-managed"
            ? {
                name: `marketplace ${provider}`,
                status: "warn",
                detail: `${label}: ${row !== null ? `jentrix → ${row}` : `${command} ${read.why}`}; not written by this CLI — official support stops at the API boundary; \`${provider} plugin marketplace remove jentrix\` then \`jentrix plugin install ${provider}\` returns to the official plugin`,
              }
            : ownership === "unregistered"
              ? {
                  name: `marketplace ${provider}`,
                  status: "warn",
                  detail: `${label}: ${command} ${read.why}`,
                  fix: `jentrix plugin install ${provider}`,
                }
              : {
                  name: `marketplace ${provider}`,
                  status: "warn",
                  detail: `${label}: ${command} ${read.why}`,
                },
    );

    // Hook pinning: the package's hooks.json, and the copy the provider runs.
    const packageHooks = hookCommands(
      client.readTextFile(hookFilePath(provider, pluginDir)),
    );
    if (packageHooks === null) {
      checks.push({
        name: `hooks ${provider}`,
        status: "warn",
        detail: `${pkg} carries no readable hooks.json`,
        fix: "reinstall: npm i -g @jentrix/cli",
      });
      continue;
    }
    const target = pinnedHookTarget(packageHooks);
    let cachedPath: string | null = null;
    if (provider === "claude") {
      cachedPath =
        manifestVersion === null
          ? null
          : join(
              client.homeDir(),
              ".claude",
              "plugins",
              "cache",
              "jentrix",
              "jentrix",
              manifestVersion,
              "hooks",
              "hooks.json",
            );
    } else {
      const inventory = await client.invoke(executable, [
        "plugin",
        "list",
        "--json",
      ]);
      const rows = readJson(
        { readTextFile: () => inventory.stdout, fileExists: () => true },
        "",
      );
      const installed = Array.isArray(rows?.installed)
        ? (rows!.installed as Array<Record<string, unknown>>)
        : [];
      const ours = installed.find((r) => r.pluginId === "jentrix@jentrix");
      const source = (ours?.source as { path?: unknown } | undefined)?.path;
      cachedPath =
        typeof source === "string" ? join(source, "hooks", "hooks.json") : null;
    }
    const cached =
      cachedPath !== null && client.fileExists(cachedPath)
        ? hookCommands(client.readTextFile(cachedPath))
        : null;
    const cacheNote =
      cached === null
        ? cachedPath === null
          ? "; the provider reports no installed copy"
          : `; no cached copy at ${cachedPath} (the plugin has not been installed into ${provider} yet)`
        : JSON.stringify(cached) === JSON.stringify(packageHooks)
          ? `; the provider's cached copy matches (${cachedPath})`
          : `; the provider's cached copy DIFFERS (${cachedPath}) — new sessions run the cache`;
    const mismatch = cached !== null && cacheNote.includes("DIFFERS");
    checks.push(
      target === null
        ? {
            name: `hooks ${provider}`,
            status: "warn",
            detail: `not pinned — the ${packageHooks.length} hook commands resolve through PATH only (JEN-305)${cacheNote}`,
            fix: `jentrix plugin install ${provider}`,
          }
        : {
            name: `hooks ${provider}`,
            status: mismatch ? "warn" : "ok",
            detail: `${packageHooks.length} commands pinned to ${target}${cacheNote}`,
            ...(mismatch ? { fix: `jentrix plugin install ${provider}` } : {}),
          },
    );
  }

  // The adopted contract against the endpoint's.
  const adoptedRaw = readJson(client, join(root, "contract.json"));
  const adopted: AdoptedContract | null =
    adoptedRaw &&
    typeof adoptedRaw.surface === "string" &&
    typeof adoptedRaw.apiRelease === "string" &&
    typeof adoptedRaw.digest === "string"
      ? {
          surface: adoptedRaw.surface,
          apiRelease: adoptedRaw.apiRelease,
          digest: adoptedRaw.digest,
        }
      : null;
  let endpoint: string | null = null;
  try {
    endpoint = deps.resolveTarget().url.replace(/\/+$/, "");
  } catch {
    endpoint = null;
  }
  if (endpoint === null) {
    checks.push(
      adopted === null
        ? compareContract(null, null, "")
        : {
            name: "contract",
            status: "skip",
            detail: `adopted ${adopted.surface} ${adopted.apiRelease} (digest ${adopted.digest.slice(0, 12)}…) — no endpoint configured to compare against`,
            fix: "jentrix login",
            data: { adopted },
          },
    );
    return checks;
  }
  let served: ServedContract | null = null;
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${endpoint}/contract`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      if (
        typeof body.surface === "string" &&
        typeof body.apiRelease === "string" &&
        typeof body.digest === "string"
      ) {
        served = {
          surface: body.surface,
          apiRelease: body.apiRelease,
          digest: body.digest,
          publicationState:
            typeof body.publicationState === "string"
              ? body.publicationState
              : undefined,
          supportedReleases: Array.isArray(body.supportedReleases)
            ? (body.supportedReleases as string[])
            : undefined,
        };
      }
    }
  } catch {
    served = null;
  }
  checks.push(compareContract(adopted, served, endpoint));
  return checks;
}
