import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * THE dependency firewall (plan README §4.3 / design.md § layout).
 *
 * The core modules are imported by the app repo for contract testing (C3.1),
 * so they may depend ONLY on `@modelcontextprotocol/sdk` (version-matched
 * with the app), `node:` builtins, and each other. `commander`, `zod`, and
 * every other CLI-shell dependency must stay in `main.ts` + `commands/`.
 */
const CORE_FILES = [
  "call.ts",
  "errors.ts",
  "render.ts",
  "retry.ts",
  "surface.ts",
  // The package entry (`@jentrix/cli/core`) re-exports the five above and
  // nothing else — it is firewalled the same way.
  "core.ts",
] as const;

function isAllowed(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "@modelcontextprotocol/sdk" ||
    specifier.startsWith("@modelcontextprotocol/sdk/") ||
    specifier.startsWith("node:")
  );
}

/** Extract every static/dynamic import + require specifier from TS source. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']/g, // import … from / export … from
    /import\s*["']([^"']+)["']/g, // bare side-effect import
    /import\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import()
    /require\s*\(\s*["']([^"']+)["']\s*\)/g, // stray CJS require
  ];
  const specifiers: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

describe("dependency firewall — core modules", () => {
  it("core files import only @modelcontextprotocol/sdk, node: builtins, and each other", () => {
    const violations: string[] = [];
    let totalImports = 0;
    for (const file of CORE_FILES) {
      const source = readFileSync(
        new URL(`../src/${file}`, import.meta.url),
        "utf8",
      );
      for (const specifier of importSpecifiers(source)) {
        totalImports += 1;
        if (!isAllowed(specifier)) {
          violations.push(`src/${file} imports "${specifier}"`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Dependency-firewall violation(s):\n  ${violations.join("\n  ")}\n` +
        "Core modules may import only @modelcontextprotocol/sdk, node: builtins, and siblings.",
    );
    // Guard against a vacuous scan: the core genuinely imports things.
    assert.ok(
      totalImports > 0,
      "scanner found no imports at all — extractor broken?",
    );
  });

  it("self-check: the extractor catches disallowed imports (scanner is not vacuous)", () => {
    const fixture = [
      'import { Command } from "commander";',
      'import type { Client } from "@modelcontextprotocol/sdk/client/index.js";',
      'import { z } from "zod";',
      'import fs from "node:fs";',
      'const dyn = await import("chalk");',
      'const cjs = require("yargs");',
      'import "./sibling";',
      "import {",
      "  many,",
      "  names,",
      '} from "some-package/deep/path";',
    ].join("\n");
    const found = importSpecifiers(fixture);
    assert.deepEqual(found.filter((s) => !isAllowed(s)).sort(), [
      "chalk",
      "commander",
      "some-package/deep/path",
      "yargs",
      "zod",
    ]);
    // And the allowed ones are recognized as such.
    assert.ok(isAllowed("@modelcontextprotocol/sdk/client/index.js"));
    assert.ok(isAllowed("node:fs"));
    assert.ok(isAllowed("./sibling"));
    assert.ok(!isAllowed("@modelcontextprotocol-sdk-lookalike"));
  });

  it("every core file exists (renames must update this test + the plan)", () => {
    for (const file of CORE_FILES) {
      assert.ok(
        readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
          .length > 0,
        `src/${file} missing or empty`,
      );
    }
  });

  it("the firewall set is frozen (config/client/main stay OUTSIDE it)", () => {
    // C1.2 added config.ts / client.ts / main.ts / commands/ — none of them
    // may join the firewalled core set silently. Growing this list is a
    // deliberate plan change (README §4.3 + design.md § layout), not a
    // side effect of adding a module.
    // `core.ts` joined deliberately in open-client S2 (PRD §5.5 row 4): it is
    // the `@jentrix/cli/core` package entry and re-exports the other five,
    // nothing more — the application reaches the core through it.
    assert.deepEqual(
      [...CORE_FILES].sort(),
      [
        "call.ts",
        "core.ts",
        "errors.ts",
        "render.ts",
        "retry.ts",
        "surface.ts",
      ],
      "CORE_FILES changed — update plans/stacks-cli/design.md and README §4.3 first",
    );
  });

  it("core files' relative imports resolve only to other core files", () => {
    // `./config` or `./client` would pass the specifier allowlist above
    // (relative imports are allowed) while smuggling shell concerns — and
    // transitively their deps — into the firewalled set. Forbid it.
    const coreNames = new Set(
      CORE_FILES.map((file) => file.replace(/\.ts$/, "")),
    );
    const violations: string[] = [];
    for (const file of CORE_FILES) {
      const source = readFileSync(
        new URL(`../src/${file}`, import.meta.url),
        "utf8",
      );
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          continue;
        }
        const target = specifier.replace(/^\.\//, "").replace(/\.(ts|js)$/, "");
        if (!coreNames.has(target)) {
          violations.push(`src/${file} imports "${specifier}"`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Core modules may relative-import ONLY other core modules:\n  ${violations.join("\n  ")}`,
    );
  });
});
