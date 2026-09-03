/**
 * Generated command tree (stage C2.2): manifest + aliases → mount plan →
 * commander tree. Planning is PURE (data in, data out, deterministic);
 * mounting is a thin commander layer; execution reuses the C1.2
 * `runToolCommand` seam so config resolution, redaction, retry, exit codes,
 * and rendering behave identically to `jentrix tool`.
 *
 * PLANNING (`planCommandTree`):
 * - Aliased tools mount at their curated "noun verb" path (aliases.ts).
 * - Every other tool AUTO-MOUNTS under a group derived from its name: a
 *   leading known verb folds behind the noun (`list_harness_stages` →
 *   `harness list-stages`), and the group word is naively singularized so
 *   `list_agents` and `get_agent` share one `agent` group. Derivation is
 *   total and deterministic (tools are processed in name order), so every
 *   manifest tool lands somewhere even with an empty alias table.
 * - CROSS-CUTTING FLAGS are detected from each tool's input schema, never
 *   from tool-name lists: a schema with `idempotencyKey` yields
 *   `--idempotency-key <value>` (the C2.1 mapper already emits it — the
 *   detection is by construction); `expectedUpdatedAt` is renamed to
 *   `--if-unmodified-since <iso>` (a plain string property — the value
 *   passes through verbatim, no Date round-trip); `workspaceId`/`boardId`/
 *   `taskId` become `--workspace`/`--board`/`--task`.
 * - REQUIRED properties never use commander-mandatory options (commander
 *   would reject before `--args` or a config default could satisfy them):
 *   requiredness is enforced post-merge in `runGeneratedCommand`, still with
 *   exit-2 usage semantics, and required flags say "(required)" in help.
 *   Required `workspaceId`/`boardId` fall back to the config file's
 *   `defaults.workspace`/`defaults.board`.
 *
 * Collisions are never fatal: a colliding command path or flag name gets a
 * deterministic `-2`/`-3` suffix plus a warning, and test/build.test.ts
 * asserts ZERO warnings over the real surface — so alias/manifest drift is
 * a CI failure in this package, not a silent runtime rename. (Limitation:
 * a suffix-renamed flag keeps its original coercion error label; cosmetic,
 * and unreachable while the zero-warnings test holds.)
 *
 * EXECUTION (`runGeneratedCommand`) merges three argument sources with a
 * documented precedence, tested in both directions:
 *
 *   explicit flag  >  --args JSON key  >  config default (required ws/board)
 */

import { Command, InvalidArgumentError, Option } from "commander";

import { ConfigError } from "../config";
import { EXIT_CODES } from "../errors";
import type { SurfaceManifest, SurfaceTool } from "../surface";
import {
  argsFromFlagValues,
  isFlagError,
  buildToolFlags,
  optionKeyOf,
  type FlagDescriptor,
} from "./flags";
import {
  DEFAULT_MAX_WAIT_SECONDS,
  parseArgsJson,
  runToolCommand,
  type ToolCommandDeps,
} from "./tool";

// ---------------------------------------------------------------------------
// Plan shapes
// ---------------------------------------------------------------------------

export interface AliasConfig {
  /** Tool name → "noun verb" command path (see aliases.ts). */
  aliases: Record<string, string>;
  /** Tool name → { schema property → flag name } (see aliases.ts). */
  flagRenames: Record<string, Record<string, string>>;
}

/** A required workspace/board flag fillable from config `defaults`. */
export interface DefaultableFlag {
  property: "workspaceId" | "boardId";
  optionKey: string;
  flagName: string;
  configKey: "workspace" | "board";
}

export interface CommandMount {
  tool: SurfaceTool;
  /** Full command path under the root, e.g. ["task", "create"]. */
  path: readonly [string, string];
  mountedVia: "alias" | "auto";
  /** Post-rename flag descriptors — what actually mounts as options. */
  descriptors: FlagDescriptor[];
  defaultable: DefaultableFlag[];
}

export interface CommandTreePlan {
  mounts: CommandMount[];
  /**
   * Every anomaly: bad alias data, path/flag collisions, skipped renames,
   * mapper degradations. test/build.test.ts asserts [] on the real surface.
   */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Naming rules (all data-driven, all deterministic)
// ---------------------------------------------------------------------------

/**
 * Verbs that fold behind the noun when auto-mounting. `bulk` is deliberately
 * absent (`bulk_create_tasks` reads best as `jentrix bulk create-tasks`).
 * An unknown first word simply becomes the group, so new server tools always
 * mount somewhere.
 */
const AUTO_MOUNT_VERBS = new Set([
  "acquire",
  "add",
  "archive",
  "attach",
  "authorize",
  "cancel",
  "claim",
  "convert",
  "create",
  "delete",
  "fail",
  "find",
  "freeze",
  "get",
  "heartbeat",
  "link",
  "list",
  "manage",
  "move",
  "release",
  "remove",
  "rename",
  "request",
  "resolve",
  "retry",
  "search",
  "set",
  "start",
  "submit",
  "toggle",
  "unfreeze",
  "unlink",
  "update",
  "version",
]);

/** Top-level names the generated tree must not shadow (C1.2 escape hatch + commander's help). */
// `align` and `push` are hand-registered Jentrix MVP commands (the wizard and
// the typed-push pipeline), `plugin` the bundled-plugin installer — a derived
// group must never shadow them.
const RESERVED_TOP_LEVEL = new Set([
  "tool",
  "runner",
  "help",
  "align",
  "push",
  "plugin",
]);

/** Groups get an implicit `help [command]` subcommand from commander. */
const RESERVED_LEAF_NAME = "help";

/**
 * Cross-cutting execution flags mounted on EVERY generated leaf (same set
 * `jentrix tool` exposes, minus --args-file). Schema flags colliding with
 * these are suffix-renamed (warning) unless aliases.ts renames them first.
 */
const RESERVED_FLAG_NAMES = [
  "help",
  "args",
  "json",
  "url",
  "token",
  "wait",
  "no-wait",
  "max-wait",
] as const;

/**
 * Schema-detected flag renames applied to every tool whose input schema has
 * the property (single-flag string properties across the whole surface).
 * Per-tool renames from aliases.ts win over this table.
 */
const CROSS_CUTTING_RENAMES: Record<
  string,
  { name: string; placeholder?: string }
> = {
  workspaceId: { name: "workspace", placeholder: "<id>" },
  boardId: { name: "board", placeholder: "<id>" },
  taskId: { name: "task", placeholder: "<id>" },
  expectedUpdatedAt: { name: "if-unmodified-since", placeholder: "<iso>" },
};

/**
 * Naive singular form for auto-mount GROUP words only (`boards` → `board`,
 * `policies` → `policy`, `harnesses` → `harness`). Imperfect by design —
 * the result is frozen by the help snapshot, so oddities are visible, not
 * silent.
 */
function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ss")) return word;
  if (word.endsWith("s") && word.length > 1) return word.slice(0, -1);
  return word;
}

/** `list_harness_stages` → ["harness", "list-stages"]; `bulk_create_tasks` → ["bulk", "create-tasks"]. */
export function autoMountPath(toolName: string): [string, string] {
  const words = toolName.split("_").filter((word) => word.length > 0);
  if (words.length >= 2 && AUTO_MOUNT_VERBS.has(words[0])) {
    const leaf = [words[0], ...words.slice(2)].join("-");
    return [singularize(words[1]), leaf];
  }
  if (words.length >= 2) {
    return [singularize(words[0]), words.slice(1).join("-")];
  }
  const only = words[0] ?? toolName;
  return [singularize(only), only];
}

const PATH_SEGMENT = /^[a-z][a-z0-9-]*$/;

function desiredPath(
  toolName: string,
  aliases: Record<string, string>,
  warnings: string[],
): { path: [string, string]; via: "alias" | "auto" } {
  const alias = aliases[toolName];
  if (alias !== undefined) {
    const segments = alias.trim().split(/\s+/);
    if (segments.length !== 2 || !segments.every((s) => PATH_SEGMENT.test(s))) {
      warnings.push(
        `${toolName}: alias "${alias}" is not two kebab-case segments — auto-mounting instead`,
      );
    } else if (RESERVED_TOP_LEVEL.has(segments[0])) {
      warnings.push(
        `${toolName}: alias "${alias}" shadows the reserved command "${segments[0]}" — auto-mounting instead`,
      );
    } else {
      return { path: [segments[0], segments[1]], via: "alias" };
    }
  }
  return { path: autoMountPath(toolName), via: "auto" };
}

function allocatePath(
  desired: [string, string],
  usedPaths: Set<string>,
  toolName: string,
  warnings: string[],
): [string, string] {
  let group = desired[0];
  if (RESERVED_TOP_LEVEL.has(group)) {
    const base = group;
    group = `${base}-2`;
    warnings.push(
      `${toolName}: derived group "${base}" shadows a reserved command — mounted under "${group}"`,
    );
  }
  const leaf = desired[1];
  const collides = (candidate: string) =>
    candidate === RESERVED_LEAF_NAME || usedPaths.has(`${group} ${candidate}`);
  if (!collides(leaf)) {
    usedPaths.add(`${group} ${leaf}`);
    return [group, leaf];
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${leaf}-${i}`;
    if (!collides(candidate)) {
      warnings.push(
        `${toolName}: command path "${group} ${leaf}" collides with an earlier mount — renamed to "${group} ${candidate}"`,
      );
      usedPaths.add(`${group} ${candidate}`);
      return [group, candidate];
    }
  }
}

// ---------------------------------------------------------------------------
// Descriptor transform: renames + reserved-name collision handling
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite `--from` → `--to` in help prose (negated form first, boundary-aware). */
function replaceFlagRef(text: string, from: string, to: string): string {
  return text
    .replace(
      new RegExp(`--no-${escapeRegExp(from)}(?![a-z0-9-])`, "g"),
      `--no-${to}`,
    )
    .replace(
      new RegExp(`--${escapeRegExp(from)}(?![a-z0-9-])`, "g"),
      `--${to}`,
    );
}

function placeholderIn(flag: string): string {
  const space = flag.indexOf(" ");
  return space === -1 ? "<value>" : flag.slice(space + 1);
}

function planFlags(
  tool: SurfaceTool,
  toolRenames: Record<string, string>,
  warnings: string[],
): { descriptors: FlagDescriptor[]; defaultable: DefaultableFlag[] } {
  const built = buildToolFlags(tool);
  for (const warning of built.warnings) {
    warnings.push(`${tool.name}: ${warning}`);
  }
  const descriptors = built.descriptors.map((d) => ({ ...d }));

  // A rename can re-label a value flag and its paired `--clear-*` (nullable
  // properties). JSON-mode groups keep their derived names: `--foo-json` /
  // `--foo-file` renames have no real-surface need and would multiply the
  // rename surface for nothing.
  const groupRoles = new Map<string, Set<string>>();
  for (const d of descriptors) {
    const roles = groupRoles.get(d.property) ?? new Set<string>();
    roles.add(d.role);
    groupRoles.set(d.property, roles);
  }
  const renameEligible = (property: string) => {
    const roles = groupRoles.get(property);
    if (!roles) return false;
    return [...roles].every((role) => role === "value" || role === "clear");
  };

  // Per-tool renames (aliases.ts) win over the cross-cutting table.
  const properties = tool.inputSchema.properties;
  const hasProperty = (name: string) =>
    typeof properties === "object" &&
    properties !== null &&
    name in (properties as Record<string, unknown>);
  const renamePlan = new Map<string, { name: string; placeholder?: string }>();
  for (const [property, rename] of Object.entries(CROSS_CUTTING_RENAMES)) {
    if (hasProperty(property)) renamePlan.set(property, rename);
  }
  for (const [property, name] of Object.entries(toolRenames)) {
    if (!hasProperty(property)) {
      warnings.push(
        `${tool.name}: flag rename for unknown property "${property}" — ignored`,
      );
      continue;
    }
    renamePlan.set(property, { name });
  }

  // Re-allocate every flag name against the reserved cross-cutting set.
  const usedNames = new Set<string>(RESERVED_FLAG_NAMES);
  const usedKeys = new Set<string>(RESERVED_FLAG_NAMES.map(optionKeyOf));
  const applied: { from: string; to: string }[] = [];

  for (const d of descriptors) {
    let desired = d.name;
    let placeholder = placeholderIn(d.flag);
    const rename = renamePlan.get(d.property);
    if (rename) {
      if (renameEligible(d.property)) {
        if (d.role === "value") {
          desired = rename.name;
          if (rename.placeholder) placeholder = rename.placeholder;
        } else if (d.role === "clear") {
          desired = `clear-${rename.name}`;
        }
      } else if (d.role === "json") {
        // Warn once, on the group's primary descriptor.
        warnings.push(
          `${tool.name}: cannot rename "${d.property}" to --${rename.name} ` +
            `(JSON-mode flag group) — keeping --${d.name}`,
        );
      }
    }

    // A boolean's implicit `--no-<name>` is a real mounted flag, so its
    // availability is part of the collision predicate — otherwise a property
    // named `noFoo` before a boolean `foo` would pass planning and then
    // throw inside commander at mount time [C2.2-R1-1].
    const taken = (name: string) =>
      usedNames.has(name) || usedKeys.has(optionKeyOf(name));
    const conflicts = (name: string) =>
      taken(name) || (d.negatable && taken(`no-${name}`));
    let finalName = desired;
    if (conflicts(finalName)) {
      for (let i = 2; ; i += 1) {
        const candidate = `${desired}-${i}`;
        if (!conflicts(candidate)) {
          finalName = candidate;
          break;
        }
      }
      warnings.push(
        `${tool.name}: flag --${desired} collides with a reserved or earlier ` +
          `flag — renamed to --${finalName}`,
      );
    }
    if (finalName.startsWith("no-")) {
      // Commander strips a leading `no-` when deriving the storage key, so a
      // value flag literally named `no-*` would silently mis-key. No real
      // surface property does this; make it a loud CI failure if one appears.
      warnings.push(
        `${tool.name}: flag --${finalName} starts with "no-", which commander ` +
          `reserves for boolean negation — add a FLAG_RENAMES entry in aliases.ts`,
      );
    }
    usedNames.add(finalName);
    usedKeys.add(optionKeyOf(finalName));
    if (d.negatable) {
      usedNames.add(`no-${finalName}`);
      usedKeys.add(optionKeyOf(`no-${finalName}`));
    }

    if (finalName !== d.name) {
      applied.push({ from: d.name, to: finalName });
      d.name = finalName;
      d.optionKey = optionKeyOf(finalName);
      d.flag = d.takesValue
        ? `--${finalName} ${placeholder}`
        : `--${finalName}`;
    }
  }

  // Fix cross-references in help prose (clear/json pairs name their partner).
  for (const { from, to } of applied) {
    for (const d of descriptors) {
      d.helpText = replaceFlagRef(d.helpText, from, to);
    }
  }

  // Required workspace/board flags are fillable from config defaults.
  const defaultable: DefaultableFlag[] = [];
  for (const d of descriptors) {
    if (d.role !== "value" || !d.propertyRequired) continue;
    if (d.property !== "workspaceId" && d.property !== "boardId") continue;
    const configKey = d.property === "workspaceId" ? "workspace" : "board";
    defaultable.push({
      property: d.property,
      optionKey: d.optionKey,
      flagName: d.name,
      configKey,
    });
    d.helpText = [
      d.helpText,
      `(required; falls back to "defaults.${configKey}" in ~/.config/stacks/config.json)`,
    ]
      .filter((part) => part.length > 0)
      .join(" ");
  }

  // Generated commands NEVER use commander-mandatory options: a required
  // property may be satisfied by --args or by a config default, and
  // commander validates mandatory options before the action can merge
  // either. Requiredness is enforced post-merge in runGeneratedCommand with
  // identical exit-2 semantics; required flags are annotated in help.
  const defaultableProps = new Set<string>(defaultable.map((d) => d.property));
  for (const d of descriptors) {
    d.required = false;
    if (
      d.propertyRequired &&
      !defaultableProps.has(d.property) &&
      (d.role === "value" || d.role === "json")
    ) {
      d.helpText =
        d.helpText.length > 0 ? `${d.helpText} (required)` : "(required)";
    }
  }

  return { descriptors, defaultable };
}

// ---------------------------------------------------------------------------
// planCommandTree — the pure heart
// ---------------------------------------------------------------------------

export function planCommandTree(
  manifest: SurfaceManifest,
  config: AliasConfig,
): CommandTreePlan {
  const warnings: string[] = [];
  const tools = [...manifest.tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const aliased of Object.keys(config.aliases)) {
    if (!toolNames.has(aliased)) {
      warnings.push(
        `alias for "${aliased}" references a tool not in the manifest — ignored`,
      );
    }
  }
  for (const renamed of Object.keys(config.flagRenames)) {
    if (!toolNames.has(renamed)) {
      warnings.push(
        `flag renames for "${renamed}" reference a tool not in the manifest — ignored`,
      );
    }
  }

  const usedPaths = new Set<string>();
  const mounts: CommandMount[] = [];
  for (const tool of tools) {
    const { path: wanted, via } = desiredPath(
      tool.name,
      config.aliases,
      warnings,
    );
    const path = allocatePath(wanted, usedPaths, tool.name, warnings);
    const { descriptors, defaultable } = planFlags(
      tool,
      config.flagRenames[tool.name] ?? {},
      warnings,
    );
    mounts.push({ tool, path, mountedVia: via, descriptors, defaultable });
  }
  return { mounts, warnings };
}

// ---------------------------------------------------------------------------
// Execution — reuses the C1.2 runToolCommand seam
// ---------------------------------------------------------------------------

/**
 * Run one generated command. `options` is commander's parsed option bag for
 * the leaf (descriptor optionKeys + the cross-cutting keys). Returns the
 * process exit code; all output goes through the injected deps.
 *
 * Argument precedence (documented in the --args help text and tested in
 * both directions): explicit flag > --args key > config default.
 */
export async function runGeneratedCommand(
  mount: CommandMount,
  options: Record<string, unknown>,
  deps: ToolCommandDeps,
): Promise<number> {
  // ---- --args override (usage problems exit 2, nothing sent) -----------
  let argsJson: Record<string, unknown> = {};
  if (options.args !== undefined) {
    if (typeof options.args !== "string") {
      deps.writeErr("error: --args expects a JSON object string");
      return EXIT_CODES.INVALID_INPUT;
    }
    const parsed = parseArgsJson(options.args, "--args");
    if (!parsed.ok) {
      deps.writeErr(`error: ${parsed.error}`);
      return EXIT_CODES.INVALID_INPUT;
    }
    argsJson = parsed.value;
  }

  // ---- config defaults for REQUIRED workspace/board ---------------------
  const values: Record<string, unknown> = { ...options };
  if (mount.defaultable.length > 0) {
    let file;
    try {
      file = deps.configFile();
    } catch (e) {
      if (e instanceof ConfigError) {
        deps.writeErr(`error: ${e.message}`);
        return e.exitCode;
      }
      throw e;
    }
    const defaults = file?.defaults ?? {};
    for (const d of mount.defaultable) {
      // Any flag of the property's group counts as explicit (a paired
      // --clear-* would otherwise collide with the injected value).
      const groupProvided = mount.descriptors.some(
        (descriptor) =>
          descriptor.property === d.property &&
          (descriptor.role === "clear"
            ? values[descriptor.optionKey] === true
            : values[descriptor.optionKey] !== undefined),
      );
      if (groupProvided) continue; // explicit flag wins
      if (d.property in argsJson) continue; // --args wins over defaults
      const fallback = defaults[d.configKey];
      if (typeof fallback === "string" && fallback.trim() !== "") {
        values[d.optionKey] = fallback;
      } else if (fallback !== undefined) {
        deps.writeErr(
          `notice: config defaults.${d.configKey} is not a string — ignored`,
        );
      }
    }
  }

  // ---- flags → args (group rules enforced by the C2.1 mapper) -----------
  let stdinContent: string | null = null;
  if (
    mount.descriptors.some(
      (d) => d.role === "json-file" && values[d.optionKey] === "-",
    )
  ) {
    stdinContent = await deps.readStdin();
  }
  // A required property already present in --args is satisfied — relax the
  // group's requiredness so argsFromFlagValues doesn't demand the flag too.
  const descriptors = mount.descriptors.map((d) =>
    d.propertyRequired && d.property in argsJson
      ? { ...d, propertyRequired: false }
      : d,
  );
  let flagArgs: Record<string, unknown>;
  try {
    flagArgs = argsFromFlagValues(descriptors, values, {
      readFile: (path) =>
        path === "-" && stdinContent !== null
          ? stdinContent
          : deps.readFile(path),
    });
  } catch (e) {
    if (isFlagError(e)) {
      deps.writeErr(`error: ${e.message}`);
      return EXIT_CODES.INVALID_INPUT;
    }
    throw e;
  }

  // Precedence: explicit flags > --args keys (> config defaults, above).
  const merged = { ...argsJson, ...flagArgs };

  return runToolCommand(
    mount.tool.name,
    {
      args: JSON.stringify(merged),
      json: options.json === true,
      url: typeof options.url === "string" ? options.url : undefined,
      token: typeof options.token === "string" ? options.token : undefined,
      wait: options.wait !== false,
      maxWait:
        typeof options.maxWait === "string"
          ? options.maxWait
          : String(DEFAULT_MAX_WAIT_SECONDS),
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Mounting — thin commander layer
// ---------------------------------------------------------------------------

export interface TreeRuntime {
  deps: ToolCommandDeps;
  onExit(code: number): void;
}

/** Pinned help width → deterministic wrapping (snapshots + prod alike). */
const HELP_WIDTH = 100;

/** First sentence of the tool description, capped, for subcommand listings. */
function summarize(description: string): string {
  const firstLine = description.split("\n", 1)[0] ?? "";
  const match = /^.*?\.(?=\s|$)/.exec(firstLine);
  const sentence = (match ? match[0] : firstLine).trim();
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}

function groupDescription(mounts: CommandMount[]): string {
  const leaves = mounts.map((mount) => mount.path[1]);
  const shown = leaves.slice(0, 6).join(", ");
  return leaves.length > 6 ? `${shown}, … (${leaves.length} commands)` : shown;
}

function wrapCoerce(coerce: NonNullable<FlagDescriptor["coerce"]>) {
  return (raw: string, previous?: unknown) => {
    try {
      return coerce(raw, previous);
    } catch (e) {
      // FlagCoercionError → commander's usage error (main maps it to exit 2).
      if (isFlagError(e)) throw new InvalidArgumentError(e.message);
      throw e;
    }
  };
}

function mountLeaf(
  group: Command,
  mount: CommandMount,
  runtime: TreeRuntime,
): void {
  const leaf = group
    .command(mount.path[1])
    .summary(summarize(mount.tool.description))
    .description(mount.tool.description)
    .configureHelp({ helpWidth: HELP_WIDTH });

  for (const d of mount.descriptors) {
    // Never makeOptionMandatory: requiredness is enforced post-merge in
    // runGeneratedCommand (see planFlags), so --args and config defaults
    // can satisfy required properties.
    const option = new Option(d.flag, d.helpText);
    if (d.coerce) option.argParser(wrapCoerce(d.coerce));
    leaf.addOption(option);
    if (d.negatable) {
      leaf.addOption(
        new Option(`--no-${d.name}`, `set ${d.property} to false`),
      );
    }
  }

  // Cross-cutting execution flags — on the SUBCOMMAND (commander root
  // options do not parse after a subcommand name; C1.2 note).
  leaf
    .option(
      "--args <json>",
      "extra tool arguments as a JSON object, merged under the flags " +
        "(explicit flags win over --args keys; --args keys win over config defaults)",
    )
    .option("--json", "print stable JSON on stdout (machine mode)")
    .option(
      "--url <url>",
      "MCP endpoint (default: STACKS_MCP_URL, config file, or production)",
    )
    .option(
      "--token <token>",
      "API token (default: STACKS_TOKEN or config file)",
    )
    .option("--no-wait", "fail RATE_LIMITED calls immediately (never sleep)")
    .option(
      "--max-wait <seconds>",
      "cap total RATE_LIMITED wait time",
      String(DEFAULT_MAX_WAIT_SECONDS),
    );

  leaf.addHelpText(
    "after",
    `\nTool: ${mount.tool.name} (${mount.tool.toolClass} scope)`,
  );

  leaf.action(async (options: Record<string, unknown>) => {
    runtime.onExit(await runGeneratedCommand(mount, options, runtime.deps));
  });
}

/**
 * Mount a plan onto an existing program (main.ts mounts next to the C1.2
 * `tool` command). Groups and leaves are inserted in sorted order so help
 * output is deterministic.
 */
export function mountCommandTree(
  program: Command,
  plan: CommandTreePlan,
  runtime: TreeRuntime,
): void {
  const groups = new Map<string, CommandMount[]>();
  for (const mount of plan.mounts) {
    const list = groups.get(mount.path[0]);
    if (list) list.push(mount);
    else groups.set(mount.path[0], [mount]);
  }
  for (const groupName of [...groups.keys()].sort()) {
    const mounts = groups
      .get(groupName)!
      .sort((a, b) => (a.path[1] < b.path[1] ? -1 : 1));
    // A hand-registered group with the same name (e.g. `artifact`, which
    // carries the upload-grant `upload` leaf) must be REUSED — commander
    // dispatches to the first command matching a name, so a duplicate group
    // would silently shadow whichever registered second.
    const existing = program.commands.find(
      (command) => command.name() === groupName,
    );
    const group =
      existing ??
      program
        .command(groupName)
        .description(groupDescription(mounts))
        .configureHelp({ helpWidth: HELP_WIDTH });
    for (const mount of mounts) mountLeaf(group, mount, runtime);
  }
}

/**
 * Build a standalone root program carrying only the generated tree — the
 * pure entry point (stage contract: `buildProgram(manifest, aliases) →
 * Command`). Tests snapshot its help; main.ts uses `mountCommandTree`
 * against the real root instead.
 */
export function buildProgram(
  manifest: SurfaceManifest,
  config: AliasConfig,
  runtime: TreeRuntime,
): Command {
  const program = new Command("jentrix");
  program.exitOverride().configureHelp({ helpWidth: HELP_WIDTH });
  mountCommandTree(program, planCommandTree(manifest, config), runtime);
  return program;
}
