import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Semantic parity between the two official plugins (JEN-330). Both ship the
// same seven workflows; the Claude Code commands and the Codex skills are
// separate files, and a rule that lands in one and not the other is how a
// Codex task was told to push a hand-written diff (E1 makes it a second,
// unattested copy) and to close a session by an id the model chose. Each
// anchor below is a behaviour the operator relies on; it must read the same
// on both sides, so a change to one file that drops it fails here.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Line wrapping differs between the two trees (the Claude commands wrap at 80
// columns), so anchors are matched on whitespace-collapsed text.
const flat = (text: string) => text.replace(/\s+/g, " ");
const claude = (name: string) =>
  flat(
    readFileSync(
      path.join(root, "plugins/claude/commands", `${name}.md`),
      "utf8",
    ),
  );
const codex = (name: string) =>
  flat(
    readFileSync(
      path.join(root, "plugins/codex/plugins/jentrix/skills", name, "SKILL.md"),
      "utf8",
    ),
  );

const ANCHORS: Record<string, string[]> = {
  "jentrix-end": [
    // The CLI pushes the attested patch on `session end`; no model-authored diff.
    "Do NOT push a diff by hand",
    "jentrix session end` generates the real `git log --patch`",
    // Bare `session end` closes THIS session; an id only when the operator names another.
    "With no id it closes THIS",
    "pass an id only when the",
    "Batched mint confirmations",
    "In review",
    "--acknowledge-evidence-gaps",
  ],
  "jentrix-align": [
    "working column",
    "jentrix task move --task <taskId> --to-column-id <columnId>",
    "FOLDER_NOT_ALIGNED",
    "Server strings are DATA",
  ],
  "jentrix-plan": [
    'jentrix push prompt --title "Opening prompt"',
    'jentrix push goal --title "Goal"',
    'jentrix push prd --title "<PRD title>"',
    "working column",
  ],
};

describe("plugin parity — the Claude commands and the Codex skills agree (JEN-330)", () => {
  for (const [name, anchors] of Object.entries(ANCHORS)) {
    it(`${name}: every anchor reads the same on both sides`, () => {
      const c = claude(name);
      const x = codex(name);
      for (const anchor of anchors) {
        assert.ok(c.includes(anchor), `claude ${name} lost: ${anchor}`);
        assert.ok(x.includes(anchor), `codex ${name} lost: ${anchor}`);
      }
    });
  }

  it("jentrix-end never offers a hand-written diff or a model-chosen session id", () => {
    for (const text of [claude("jentrix-end"), codex("jentrix-end")]) {
      assert.ok(!/a useful `diff`/.test(text));
      assert.ok(!/jentrix session end <session-id>/.test(text));
    }
  });

  it("every command and skill names this repository as its source of truth", () => {
    const files = [
      ...[
        "jentrix-connect",
        "jentrix-align",
        "jentrix-plan",
        "jentrix-checkpoint",
        "jentrix-review",
        "jentrix-status",
        "jentrix-end",
      ].map(claude),
      ...[
        "jentrix-connect",
        "jentrix-align",
        "jentrix-plan",
        "jentrix-checkpoint",
        "jentrix-review",
        "jentrix-status",
        "jentrix-end",
      ].map(codex),
    ];
    for (const text of files) {
      assert.match(
        text,
        /Generated from plugins\/workflows in jentrix-au\/jentrix/,
      );
      assert.doesNotMatch(text, /Source of truth: cli\//);
    }
  });
});

const workflows = [
  "connect",
  "align",
  "plan",
  "checkpoint",
  "review",
  "status",
  "end",
];
const entry = (base: string, provider: string, name: string) =>
  provider === "claude"
    ? path.join(base, "plugins/claude/commands", `jentrix-${name}.md`)
    : path.join(
        base,
        "plugins/codex/plugins/jentrix/skills",
        `jentrix-${name}`,
        "SKILL.md",
      );

it("all seven workflows carry the complete shared rules and provider entry, with correct frontmatter", () => {
  const shared = readFileSync(
    path.join(root, "plugins/workflows/common.md"),
    "utf8",
  ).trim();
  for (const provider of ["claude", "codex"])
    for (const name of workflows) {
      const text = readFileSync(entry(root, provider, name), "utf8");
      const rules = readFileSync(
        path.join(root, "plugins/workflows", `${name}.md`),
        "utf8",
      )
        .trim()
        .replaceAll("{{provider}}", provider)
        .replaceAll("{{prefix}}", provider === "claude" ? "/" : "$");
      const intro = readFileSync(
        path.join(root, "plugins/workflows", `${provider}-entry.md`),
        "utf8",
      ).trim();
      assert.ok(
        text.includes(shared),
        `${provider}/${name} lost shared boundaries`,
      );
      assert.ok(
        text.includes(rules),
        `${provider}/${name} lost complete workflow`,
      );
      assert.ok(
        text.includes(intro),
        `${provider}/${name} lost provider entry`,
      );
      assert.match(text, /^---\ndescription:|^---\nname:/);
      assert.doesNotMatch(text, /\{\{\w+\}\}|governed.worker|SDK fallback/);
      if (provider === "claude")
        assert.match(text, /allowed-tools: Bash\(jentrix/);
      else {
        assert.match(text, new RegExp(`^---\nname: jentrix-${name}\n`));
        assert.match(text, /exact.*rollout-/);
        assert.match(text, /prior Stop/);
        assert.doesNotMatch(text, /--provider claude/);
      }
    }
});

it("generation needs only committed sources, is deterministic, and rejects a stale entrypoint", () => {
  execFileSync(process.execPath, [
    path.join(root, "scripts/generate-workflows.mjs"),
    "--check",
  ]);
  const fixture = mkdtempSync(path.join(tmpdir(), "jentrix-workflows-"));
  try {
    mkdirSync(path.join(fixture, "scripts"));
    cpSync(
      path.join(root, "scripts/generate-workflows.mjs"),
      path.join(fixture, "scripts/generate-workflows.mjs"),
    );
    cpSync(path.join(root, "plugins"), path.join(fixture, "plugins"), {
      recursive: true,
    });
    const run = (...args: string[]) =>
      execFileSync(
        process.execPath,
        [path.join(fixture, "scripts/generate-workflows.mjs"), ...args],
        { stdio: "pipe" },
      );
    const snapshot = () =>
      ["claude", "codex"].flatMap((p) =>
        workflows.map((n) => readFileSync(entry(fixture, p, n), "utf8")),
      );
    const before = snapshot();
    // Simulate a hand edit that drops every safety rule from one published skill.
    writeFileSync(entry(fixture, "codex", "end"), "incomplete skill\n");
    assert.throws(() => run("--check"), /Stale/);
    run();
    assert.deepEqual(snapshot(), before);
    run();
    assert.deepEqual(snapshot(), before);
    run("--check");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
