#!/usr/bin/env node
/**
 * validate-examples — check a Jentrix extension (a Claude Code or Codex
 * plugin directory laid out like examples/acme-claude and examples/acme-codex)
 * the way a customer's CI should check its own: manifests parse and agree,
 * no reserved identity is used, versions are semver, hooks carry a timeout
 * and no credential, commands and skills have their front matter, and the
 * plugin declares a CLI range that includes the CLI in this tree.
 *
 *   pnpm validate:examples                       # every directory under examples/
 *   node scripts/validate-examples.mjs <dir>…    # your own plugin directories
 *
 * Hermetic: no provider binary, no network. `--provider-validate` adds
 * `claude plugin validate <dir>` when `claude` is on PATH (Claude Code
 * plugins only). Exit 0 = every directory valid; 1 = problems listed; 2 = usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/** Identities reserved to the official client (TRADEMARKS.md, PRD §4). */
const RESERVED_NAMES = new Set(["jentrix", "stacks"]);
const RESERVED_SCOPE = /^@jentrix\//;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** Things that must never appear in a hook command. */
const SECRET_PATTERNS = [
  [/\btm[or]?_[A-Za-z0-9]{8,}/, "a Jentrix token (tm_/tmo_/tmr_)"],
  [/\bghp_[A-Za-z0-9]{10,}/, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{12,}/, "an AWS key id"],
  [/\bsk-[A-Za-z0-9_-]{10,}/, "an API key (sk-…)"],
  [/--token\b/, "a --token argument (credentials never travel in argv)"],
  [/\bSTACKS_TOKEN\s*=\s*\S/, "an inline STACKS_TOKEN assignment"],
];
const MAX_HOOK_TIMEOUT_SECONDS = 30;

const args = process.argv.slice(2);
const providerValidate = args.includes("--provider-validate");
const dirs = args.filter((a) => !a.startsWith("--")).map((a) => resolve(a));
if (dirs.length === 0) {
  const examples = join(ROOT, "examples");
  if (!existsSync(examples)) {
    process.stderr.write("usage: validate-examples.mjs <plugin-dir>… (no examples/ directory found)\n");
    process.exit(2);
  }
  for (const name of readdirSync(examples).sort()) {
    const dir = join(examples, name);
    if (statSync(dir).isDirectory()) dirs.push(dir);
  }
}

function readJson(file, problems) {
  if (!existsSync(file)) {
    problems.push(`${file}: missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${file}: not valid JSON (${error.message})`);
    return null;
  }
}

function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function checkName(name, what, problems) {
  if (typeof name !== "string" || name.length === 0) {
    problems.push(`${what}: name missing`);
    return;
  }
  if (RESERVED_NAMES.has(name.toLowerCase()) || RESERVED_SCOPE.test(name)) {
    problems.push(`${what}: "${name}" is a reserved identity (TRADEMARKS.md) — use a name you control, e.g. acme-jentrix`);
  }
}

function checkHooks(file, problems) {
  if (!existsSync(file)) return 0;
  const parsed = readJson(file, problems);
  if (!parsed) return 0;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object") {
    problems.push(`${file}: no "hooks" object`);
    return 0;
  }
  let count = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      problems.push(`${file}: ${event} is not an array of hook groups`);
      continue;
    }
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        count += 1;
        const where = `${file}: ${event} hook #${count}`;
        if (hook.type !== "command" || typeof hook.command !== "string") {
          problems.push(`${where}: must be {"type":"command","command":"…"}`);
          continue;
        }
        if (typeof hook.timeout !== "number" || hook.timeout <= 0 || hook.timeout > MAX_HOOK_TIMEOUT_SECONDS) {
          problems.push(`${where}: needs a "timeout" in seconds between 1 and ${MAX_HOOK_TIMEOUT_SECONDS} (docs/hooks-security.md)`);
        }
        for (const [pattern, label] of SECRET_PATTERNS) {
          if (pattern.test(hook.command)) problems.push(`${where}: command carries ${label}`);
        }
      }
    }
  }
  return count;
}

/** Does `version` satisfy a range of the forms `>=A <B`, `>=A`, `^A`, `~A`, `A`? */
function satisfies(version, range) {
  const parse = (v) => v.split(".").map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const v = parse(version);
  if (!SEMVER.test(version)) return false;
  const clauses = range.trim().split(/\s+/);
  return clauses.every((clause) => {
    const m = /^(>=|<=|>|<|\^|~|=)?(\d+\.\d+\.\d+)$/.exec(clause);
    if (!m) return false;
    const [, op = "=", bound] = m;
    const b = parse(bound);
    switch (op) {
      case ">=": return cmp(v, b) >= 0;
      case ">": return cmp(v, b) > 0;
      case "<=": return cmp(v, b) <= 0;
      case "<": return cmp(v, b) < 0;
      case "^": return cmp(v, b) >= 0 && (b[0] > 0 ? v[0] === b[0] : b[1] > 0 ? v[0] === 0 && v[1] === b[1] : cmp(v, b) === 0);
      case "~": return cmp(v, b) >= 0 && v[0] === b[0] && v[1] === b[1];
      default: return cmp(v, b) === 0;
    }
  });
}

function checkRange(dir, problems) {
  const pkg = readJson(join(dir, "package.json"), problems);
  if (!pkg) return;
  checkName(pkg.name, `${dir}/package.json`, problems);
  const range = pkg.peerDependencies?.["@jentrix/cli"];
  if (typeof range !== "string") {
    problems.push(`${dir}/package.json: declare the CLI range you tested against — "peerDependencies": {"@jentrix/cli": ">=${CLI_VERSION} <${Number(CLI_VERSION.split(".")[0]) + 1}.0.0"} (docs/compatibility.md)`);
    return;
  }
  if (!satisfies(CLI_VERSION, range)) {
    problems.push(`${dir}/package.json: peerDependencies["@jentrix/cli"] is "${range}", which does not include the CLI in this tree (${CLI_VERSION}) or is not a range this script understands (>=A <B, ^A, ~A, A)`);
  }
}

function validateClaude(dir, problems) {
  const marketplace = readJson(join(dir, ".claude-plugin", "marketplace.json"), problems);
  if (!marketplace) return;
  checkName(marketplace.name, `${dir}: marketplace`, problems);
  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (entries.length === 0) problems.push(`${dir}: marketplace.json lists no plugins`);
  for (const entry of entries) {
    checkName(entry.name, `${dir}: marketplace plugin`, problems);
    const source = typeof entry.source === "string" ? entry.source : null;
    if (source === null) {
      problems.push(`${dir}: plugin "${entry.name}" has no string "source" (a path relative to the marketplace)`);
      continue;
    }
    const pluginDir = resolve(dir, source);
    const manifest = readJson(join(pluginDir, ".claude-plugin", "plugin.json"), problems);
    if (!manifest) continue;
    if (manifest.name !== entry.name) problems.push(`${pluginDir}: plugin.json names "${manifest.name}" but the marketplace entry says "${entry.name}"`);
    checkName(manifest.name, `${pluginDir}/plugin.json`, problems);
    if (!SEMVER.test(String(manifest.version))) problems.push(`${pluginDir}/plugin.json: version "${manifest.version}" is not semver (Claude Code caches by version — bump it with every change)`);
    if (typeof manifest.description !== "string" || manifest.description.length === 0) problems.push(`${pluginDir}/plugin.json: description missing`);
    const commands = join(pluginDir, "commands");
    if (existsSync(commands)) {
      for (const file of readdirSync(commands).filter((f) => f.endsWith(".md"))) {
        const fm = frontMatter(readFileSync(join(commands, file), "utf8"));
        if (!fm || !fm.description) problems.push(`${join(commands, file)}: needs front matter with a "description"`);
      }
    }
    const hooks = checkHooks(join(pluginDir, "hooks", "hooks.json"), problems);
    if (providerValidate) {
      try {
        execFileSync("claude", ["plugin", "validate", pluginDir], { stdio: "pipe", encoding: "utf8" });
      } catch (error) {
        problems.push(`${pluginDir}: claude plugin validate failed — ${(error.stdout || error.stderr || error.message).toString().trim().split("\n")[0]}`);
      }
    }
    process.stdout.write(`  claude plugin ${manifest.name}@${marketplace.name} ${manifest.version} — ${hooks} hook command(s)\n`);
  }
}

function validateCodex(dir, problems) {
  const marketplace = readJson(join(dir, ".agents", "plugins", "marketplace.json"), problems);
  if (!marketplace) return;
  checkName(marketplace.name, `${dir}: marketplace`, problems);
  const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  if (entries.length === 0) problems.push(`${dir}: marketplace.json lists no plugins`);
  for (const entry of entries) {
    checkName(entry.name, `${dir}: marketplace plugin`, problems);
    const path = entry.source?.source === "local" ? entry.source.path : null;
    if (typeof path !== "string") {
      problems.push(`${dir}: plugin "${entry.name}" needs "source": {"source":"local","path":"./plugins/<name>"}`);
      continue;
    }
    const pluginDir = resolve(dir, path);
    const manifest = readJson(join(pluginDir, ".codex-plugin", "plugin.json"), problems);
    if (!manifest) continue;
    if (manifest.name !== entry.name) problems.push(`${pluginDir}: plugin.json names "${manifest.name}" but the marketplace entry says "${entry.name}"`);
    checkName(manifest.name, `${pluginDir}/plugin.json`, problems);
    if (!SEMVER.test(String(manifest.version))) problems.push(`${pluginDir}/plugin.json: version "${manifest.version}" is not semver (Codex caches by version — bump it with every change)`);
    if (typeof manifest.description !== "string" || manifest.description.length === 0) problems.push(`${pluginDir}/plugin.json: description missing`);
    const skillsDir = resolve(pluginDir, typeof manifest.skills === "string" ? manifest.skills : "skills");
    if (existsSync(skillsDir)) {
      for (const name of readdirSync(skillsDir)) {
        const skill = join(skillsDir, name, "SKILL.md");
        if (!existsSync(skill)) {
          problems.push(`${join(skillsDir, name)}: no SKILL.md`);
          continue;
        }
        const fm = frontMatter(readFileSync(skill, "utf8"));
        if (!fm || fm.name !== name || !fm.description) problems.push(`${skill}: needs front matter with "name: ${name}" and a "description"`);
      }
    } else {
      problems.push(`${pluginDir}: skills directory ${skillsDir} missing`);
    }
    const hooks = checkHooks(join(pluginDir, "hooks", "hooks.json"), problems);
    process.stdout.write(`  codex plugin ${manifest.name}@${marketplace.name} ${manifest.version} — ${hooks} hook command(s)\n`);
  }
}

let failed = false;
for (const dir of dirs) {
  const problems = [];
  const isClaude = existsSync(join(dir, ".claude-plugin", "marketplace.json"));
  const isCodex = existsSync(join(dir, ".agents", "plugins", "marketplace.json"));
  process.stdout.write(`${dir}\n`);
  if (!isClaude && !isCodex) {
    problems.push(`${dir}: neither .claude-plugin/marketplace.json nor .agents/plugins/marketplace.json found`);
  }
  if (isClaude) validateClaude(dir, problems);
  if (isCodex) validateCodex(dir, problems);
  checkRange(dir, problems);
  if (problems.length > 0) {
    failed = true;
    for (const p of problems) process.stdout.write(`  ✗ ${p}\n`);
  } else {
    process.stdout.write(`  ✓ valid (CLI range includes ${CLI_VERSION})\n`);
  }
}
process.exit(failed ? 1 : 0);
