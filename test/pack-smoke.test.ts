import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Cold-install smoke (C4.3, open-client S3): prove the PACKED tarballs — all
 * three workspace packages — install and run on a clean machine/dir. The
 * acceptance criterion is "cold install from the packed tarballs works", and
 * the S3 questions are: did `pnpm pack` rewrite every `workspace:` range to
 * the exact version, does the CLI resolve the plugin PACKAGES from its
 * dependency tree (no `plugins/` inside the CLI package any more), and does
 * `surface.json` still resolve from `dist/`.
 *
 * This shells out to `pnpm -r pack` + `npm install` + real subprocesses, which
 * is slow and needs network-free npm on a bare dir, so it is GATED behind
 * `CLI_PACK_SMOKE=1`. Unset (the default, incl. plain `pnpm test`) → it
 * records a skip and passes as a no-op. The CI `cli` job runs it explicitly
 * with the flag set.
 *
 * Honesty note: it does NOT stub anything. It packs the real packages,
 * installs the real tarballs together into a throwaway prefix (no registry —
 * the plugin packages are unpublished), and invokes the installed `jentrix`
 * bin, including `plugin install <provider> --dry-run`, which resolves and
 * stages the plugin package exactly as an install would and registers
 * nothing — no `claude`/`codex` exists in that prefix.
 */

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENABLED = process.env.CLI_PACK_SMOKE === "1";

describe("packed tarballs — cold install of the three packages", () => {
  it(
    ENABLED
      ? "installs from `pnpm -r pack` output and runs `jentrix`"
      : "SKIPPED (set CLI_PACK_SMOKE=1 to run the cold-install smoke)",
    { skip: !ENABLED },
    () => {
      const work = mkdtempSync(join(tmpdir(), "stacks-pack-smoke-"));
      try {
        // 1. Pack ALL THREE workspace packages into the throwaway dir. The
        //    CLI's `prepack` rebuilds dist/ so its tarball is always fresh.
        runSync("pnpm", ["-r", "pack", "--pack-destination", work], CLI_ROOT);
        const tarballs = readdirSync(work).filter((f) => f.endsWith(".tgz"));
        const tarball = (prefix: string) => {
          const name = tarballs.find((f) => f.startsWith(prefix));
          assert.ok(name, `pnpm -r pack did not produce ${prefix}*.tgz`);
          return join(work, name);
        };
        const cliTgz = tarball("jentrix-cli-");
        const claudeTgz = tarball("jentrix-plugin-claude-");
        const codexTgz = tarball("jentrix-plugin-codex-");

        // 2. No `workspace:` range survives packing: pnpm rewrites the CLI's
        //    plugin pins to exact versions, and npm would refuse the tarball
        //    otherwise.
        for (const tgz of [cliTgz, claudeTgz, codexTgz]) {
          const manifest = execFileSync(
            "tar",
            ["-xzOf", tgz, "package/package.json"],
            { encoding: "utf8" },
          );
          assert.ok(
            !/workspace:/.test(manifest),
            `${tgz} still carries a workspace: range`,
          );
        }

        // 3. Cold-install the three tarballs TOGETHER into a fresh, empty
        //    project — no shared node_modules, no registry lookup for the
        //    (unpublished) plugin packages: the CLI's exact pins are satisfied
        //    by the tarballs beside it.
        const proj = join(work, "consumer");
        mkdirSync(proj, { recursive: true });
        writeFileSync(
          join(proj, "package.json"),
          JSON.stringify({ name: "consumer", private: true }, null, 2),
        );
        runSync(
          "npm",
          ["install", "--no-audit", "--no-fund", claudeTgz, codexTgz, cliTgz],
          proj,
        );

        // 4. Run the INSTALLED bin via the symlink npm created from the
        //    package's `bin` entry — the real command path, the shebang, and
        //    the executable bit, not just `node dist/main.js` (SVR C4.3-R1-2).
        //    All three bins must land: `jentrix`, the pre-rename `stacks`
        //    alias, and the `jentrix-session-host` hook forwarder.
        const exe = (name: string) =>
          join(
            proj,
            "node_modules",
            ".bin",
            process.platform === "win32" ? `${name}.cmd` : name,
          );
        const jentrixBin = exe("jentrix");
        for (const name of ["jentrix", "stacks", "jentrix-session-host"]) {
          assert.ok(
            existsSync(exe(name)),
            `installed bin symlink missing at ${exe(name)} — bad \`bin\` entry`,
          );
        }

        // 4a. `--version` — semver AND the tool count, which is present ONLY
        //     if surface.json shipped in the tarball and resolved from dist/.
        const version = execFileSync(jentrixBin, ["--version"], {
          encoding: "utf8",
        }).trim();
        assert.match(version, /^\d+\.\d+\.\d+\b/, `version line: ${version}`);
        assert.match(
          version,
          /\bsurface: \d+ tools\b/,
          `version line: ${version}`,
        );

        // 4b. `--help` — the GENERATED command tree must render.
        const help = execFileSync(jentrixBin, ["--help"], {
          encoding: "utf8",
        });
        assert.match(
          help,
          /\btool\b/,
          "escape hatch command missing from help",
        );
        assert.match(
          help,
          /\btask\b/,
          "generated command tree missing from help",
        );

        // 4c. The SESSION-HOST bin DISPATCHES through its symlink (JEN-461).
        //     npm puts the bin's own path in `argv[1]`, not the script's, so
        //     an entry guard that matched the script FILENAME exited 0 having
        //     done nothing — silently, which is the worst failure mode for a
        //     telemetry forwarder, and exactly the shape both plugins' bare
        //     `jentrix-session-host hook …` commands take. Only the real
        //     installed symlink proves it; `node dist/session-host-main.js`
        //     passed throughout the regression.
        const hostVersion = execFileSync(
          exe("jentrix-session-host"),
          ["version"],
          { encoding: "utf8" },
        ).trim();
        assert.match(
          hostVersion,
          /"protocolVersion":\s*\d+/,
          `session-host bin did not dispatch: ${JSON.stringify(hostVersion)}`,
        );

        // 5. The plugin PACKAGES landed as dependencies, the CLI package
        //    carries no plugins/ of its own, and the contract files shipped.
        const packageRoot = join(proj, "node_modules", "@jentrix", "cli");
        assert.equal(
          existsSync(join(packageRoot, "plugins")),
          false,
          "the CLI tarball must not carry plugins/ any more",
        );
        for (const path of [
          "@jentrix/plugin-claude/.claude-plugin/marketplace.json",
          "@jentrix/plugin-claude/.claude-plugin/plugin.json",
          "@jentrix/plugin-claude/hooks/hooks.json",
          "@jentrix/plugin-codex/.agents/plugins/marketplace.json",
          "@jentrix/plugin-codex/plugins/jentrix/.codex-plugin/plugin.json",
          "@jentrix/plugin-codex/plugins/jentrix/hooks/hooks.json",
          "@jentrix/plugin-codex/plugins/jentrix/skills/jentrix-align/SKILL.md",
          "@jentrix/cli/contract.json",
          "@jentrix/cli/contract-vectors.json",
          "@jentrix/cli/dist/core.js",
          "@jentrix/cli/dist/core.d.ts",
        ]) {
          assert.ok(
            existsSync(join(proj, "node_modules", path)),
            `${path} missing after the cold install`,
          );
        }

        // 6. `jentrix plugin install <provider> --dry-run` — the same
        //    resolution + staging an install performs, from the INSTALLED
        //    CLI's dependency tree. PATH carries only the node running this
        //    test (the bin's `#!/usr/bin/env node` shebang needs it), so no
        //    `claude` or `codex` can be found — a dry run never looks.
        for (const [provider, suffix] of [
          ["claude", join("node_modules", "@jentrix", "plugin-claude")],
          ["codex", join("node_modules", "@jentrix", "plugin-codex")],
        ] as const) {
          const dry = execFileSync(
            jentrixBin,
            ["plugin", "install", provider, "--dry-run"],
            {
              encoding: "utf8",
              env: { ...process.env, PATH: dirname(process.execPath) },
            },
          );
          assert.match(dry, /^dry run: would register /, dry);
          assert.ok(
            dry.includes(join(proj, suffix)),
            `dry run did not resolve ${provider} from the installed tree: ${dry}`,
          );
          assert.match(dry, /hooks\.json with \d+ hook commands/, dry);
          assert.doesNotMatch(dry, /NOT built/, dry);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

/** Run a command, inheriting stdio to surface failures, with a hard cap. */
function runSync(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    // `CI=true` mirrors the sandbox recipe so pnpm doesn't abort on no-TTY.
    env: { ...process.env, CI: "true" },
    timeout: 300_000,
  });
}
