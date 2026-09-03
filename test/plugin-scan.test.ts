import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Client-runtime v2 §17.4 — static enforcement over the PACKED plugin
 * content, plus the G6/§18 no-provider-SDK inspection of the shipped host.
 *
 * The scans run against `cli/plugins/` — the canonical source of the two
 * plugin PACKAGES (`@jentrix/plugin-claude`, `@jentrix/plugin-codex`, open-
 * client S3), packed verbatim from these directories, so what this test
 * reads IS what an operator installs. They fail on any reappearance of
 * the behavior §17.3 removed: runner session binaries, plane tools and
 * commands, Project-required align/connect language, wizard flags, raw
 * full-surface manifest references, and hook commands outside the
 * session-host/snapshot allowlist.
 */

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_ROOT = join(CLI_ROOT, "plugins");
const HOST_BUNDLE = join(CLI_ROOT, "dist", "session-host-main.js");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const pluginFiles = walk(PLUGINS_ROOT).filter((f) =>
  /\.(md|json|toml)$/.test(f),
);

describe("§17.4 packed-plugin static scans (both providers)", () => {
  it("scans a real corpus (both plugins present, non-trivial)", () => {
    assert.ok(existsSync(join(PLUGINS_ROOT, "claude")));
    assert.ok(existsSync(join(PLUGINS_ROOT, "codex")));
    assert.ok(pluginFiles.length >= 10, `only ${pluginFiles.length} files`);
  });

  // §17.3 line 1+6: runner session binaries are GONE after compatibility —
  // the packed plugins never name them, under any alias.
  // §17.3 line 6: no plane tool names or platform-only workflow commands.
  // §17.3 line 2/3: no wizard (`--questions`) and no align-side project
  // creation (`--new-project`).
  // §17.4: no raw full-surface manifest references.
  const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /stacks-runner/, why: "runner session binary (pre-rename)" },
    { pattern: /jentrix-runner/, why: "runner session binary" },
    { pattern: /jentrix runner\b/, why: "ops-plane runner command" },
    { pattern: /\bwork[-_ ]order/i, why: "plane: work orders" },
    { pattern: /\bagent[-_ ]job/i, why: "plane: agent jobs" },
    { pattern: /\bharness/i, why: "plane: harness" },
    { pattern: /\bplaybook/i, why: "plane: playbooks" },
    { pattern: /control[-_ ]tower/i, why: "plane: control tower" },
    { pattern: /--questions\b/, why: "retired align wizard" },
    { pattern: /--new-project\b/, why: "align-side project creation" },
    { pattern: /surface\.json/, why: "raw full-surface manifest reference" },
    { pattern: /agent-platform\.md/, why: "platform tool catalog reference" },
    // §17.3 line 2: a Project is never REQUIRED by connect/align — neither
    // command takes --project at all in v2, so its appearance on the same
    // line is the tell.
    { pattern: /session (connect|align)[^\n]*--project\b/, why: "Project-required align/connect" },
  ];

  for (const { pattern, why } of FORBIDDEN) {
    it(`no match for ${pattern} (${why})`, () => {
      const hits = pluginFiles.flatMap((file) => {
        const text = readFileSync(file, "utf8");
        return pattern.test(text) ? [relative(CLI_ROOT, file)] : [];
      });
      assert.deepEqual(hits, []);
    });
  }

  it("every hook command is an allowlisted session-host/snapshot executable", () => {
    const manifests = pluginFiles.filter((f) => f.endsWith("hooks.json"));
    assert.ok(manifests.length >= 2, "expected both providers' hooks.json");
    for (const file of manifests) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      for (const groups of Object.values(parsed.hooks)) {
        for (const group of groups) {
          for (const hook of group.hooks) {
            assert.ok(
              /^jentrix-session-host hook /.test(hook.command) ||
                /^jentrix session snapshot /.test(hook.command),
              `${relative(CLI_ROOT, file)}: non-allowlisted hook command: ${hook.command}`,
            );
            // STA-131: Windows runs hook commands without a POSIX shell, so a
            // literal $HOME on argv never expands there — the host resolves
            // the directory in code from --provider.
            assert.ok(
              !hook.command.includes("$HOME"),
              `${relative(CLI_ROOT, file)}: $HOME on hook argv: ${hook.command}`,
            );
          }
        }
      }
    }
  });

  it("claude command frontmatter never grants unrestricted tools", () => {
    for (const file of pluginFiles.filter(
      (f) => f.includes(`${join("claude", "commands")}`) && f.endsWith(".md"),
    )) {
      const text = readFileSync(file, "utf8");
      const match = /allowed-tools:\s*(.*)/.exec(text);
      if (!match) continue;
      for (const entry of match[1]!.split(",").map((e) => e.trim())) {
        assert.match(
          entry,
          /^Bash\(jentrix [a-z-]+:\*\)$/,
          `${relative(CLI_ROOT, file)}: over-broad allowed-tools entry: ${entry}`,
        );
      }
    }
  });
});

describe("G6/§18 — the shipped host carries no provider SDK", () => {
  it("cli production dependencies contain no provider SDK or runner", () => {
    const pkg = JSON.parse(
      readFileSync(join(CLI_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      assert.ok(
        ![
          "@anthropic-ai/claude-agent-sdk",
          "@openai/codex-sdk",
          "@jentrix/runner",
          "@jentrix/stacks-runner",
        ].includes(name),
        `forbidden production dependency: ${name}`,
      );
    }
  });

  // The bundle checks read dist/, which is gitignored — they run whenever a
  // build exists (CI builds before testing; locally `pnpm --dir cli build`).
  const built = existsSync(HOST_BUNDLE);

  it(
    built
      ? "the host bundle embeds no provider SDK code"
      : "SKIPPED (run `pnpm --dir cli build` for the bundle inspection)",
    { skip: !built },
    () => {
      const bundle = readFileSync(HOST_BUNDLE, "utf8");
      // The claude host is SDK-free by construction — not even the name.
      assert.ok(!bundle.includes("@anthropic-ai/claude-agent-sdk"));
      // The codex SDK is EXTERNAL (build.mjs) and unreachable (the dispatch
      // guard refuses codex launch mode): its specifier may appear in the
      // refused dynamic import, but no bundled module body does.
      assert.ok(!bundle.includes("node_modules/@openai"));
      assert.ok(!bundle.includes("node_modules/@anthropic-ai"));
    },
  );

  it(
    built
      ? "the packed hook path runs standalone (zero-network, no SDK resolution)"
      : "SKIPPED (run `pnpm --dir cli build` for the hook-path smoke)",
    { skip: !built },
    () => {
      // Real bundle, throwaway HOME, no node_modules on the resolution path
      // for the externalized SDK — if the hook verb touched it, this spawn
      // would crash with ERR_MODULE_NOT_FOUND.
      const home = mkdtempSync(join(tmpdir(), "jentrix-hook-smoke-"));
      try {
        execFileSync(
          process.execPath,
          [HOST_BUNDLE, "hook", "--provider", "claude", "--event", "Probe"],
          {
            input: JSON.stringify({ session_id: "smoke", cwd: home }),
            env: { PATH: process.env.PATH ?? "", HOME: home },
            cwd: home,
          },
        );
        const dir = join(home, ".config", "stacks", "claude-sessions");
        assert.ok(existsSync(dir), "hook did not write the context dir");
        assert.ok(readdirSync(dir).length > 0, "context dir is empty");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
