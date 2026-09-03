#!/usr/bin/env node
/**
 * Release guard: a `cli-v*` tag pins the CLI — package.json and
 * CLI_VERSION must equal the tag — and each official plugin package must
 * agree with itself: the version in its provider manifest (plugin.json, what
 * Claude Code / Codex cache BY) and in its package.json (what npm publishes)
 * are ONE version source with two readers (open-client S3, PRD §5.2). A
 * disagreement ships a plugin the provider will not refresh.
 *
 *   node scripts/check-version.mjs 0.7.0
 *
 * Only the three packages in this repository are checked; nothing here reads
 * outside it (open-client PRD §5.5).
 *
 * Exit 0 = consistent; 1 = mismatch; 2 = bad usage.
 */
import { readFileSync } from "node:fs";

const expected = process.argv[2];
if (!expected) {
  process.stderr.write("usage: check-version.mjs <version>\n");
  process.exit(2);
}

const read = (relative) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));

const pkg = read("../package.json");
const clientSrc = readFileSync(
  new URL("../src/client.ts", import.meta.url),
  "utf8",
);
const m = clientSrc.match(/CLI_VERSION\s*=\s*["']([^"']+)["']/);
const cliVersion = m ? m[1] : null;

/** Each plugin package's two version readers. */
export const PLUGIN_VERSION_SOURCES = [
  {
    name: "@jentrix/plugin-claude",
    packageJson: "../plugins/claude/package.json",
    manifest: "../plugins/claude/.claude-plugin/plugin.json",
  },
  {
    name: "@jentrix/plugin-codex",
    packageJson: "../plugins/codex/package.json",
    manifest: "../plugins/codex/plugins/jentrix/.codex-plugin/plugin.json",
  },
];

const problems = [];
if (pkg.version !== expected) {
  problems.push(`package.json version ${pkg.version} != tag ${expected}`);
}
if (cliVersion !== expected) {
  problems.push(
    `CLI_VERSION ${cliVersion ?? "(not found)"} != tag ${expected}`,
  );
}
for (const plugin of PLUGIN_VERSION_SOURCES) {
  const packaged = read(plugin.packageJson);
  const manifest = read(plugin.manifest);
  if (packaged.name !== plugin.name) {
    problems.push(
      `${plugin.packageJson} names ${packaged.name}, expected ${plugin.name}`,
    );
  }
  if (packaged.version !== manifest.version) {
    problems.push(
      `${plugin.name}: package.json ${packaged.version} != plugin.json ${manifest.version} (one version, two readers — bump both)`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write("version mismatch:\n  " + problems.join("\n  ") + "\n");
  process.exit(1);
}
const plugins = PLUGIN_VERSION_SOURCES.map(
  (p) => `${p.name}@${read(p.packageJson).version}`,
).join(", ");
process.stdout.write(
  `version ${expected} OK (CLI pinned to the tag; plugins self-consistent: ${plugins})\n`,
);
