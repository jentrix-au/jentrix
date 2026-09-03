import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Semantic parity between the two official plugins (JEN-330). Both ship the
// same six workflows; the Claude Code commands and the Codex skills are
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
      ...["jentrix-connect", "jentrix-align", "jentrix-plan", "jentrix-checkpoint", "jentrix-review", "jentrix-status", "jentrix-end"].map(claude),
      ...["jentrix-connect", "jentrix-align", "jentrix-plan", "jentrix-checkpoint", "jentrix-review", "jentrix-status", "jentrix-end"].map(codex),
    ];
    for (const text of files) {
      assert.match(text, /Source of truth: plugins\/(claude|codex) in jentrix-au\/jentrix/);
      assert.doesNotMatch(text, /Source of truth: cli\//);
    }
  });
});
