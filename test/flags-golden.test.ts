import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildToolFlags,
  type FlagDescriptor,
  type ToolFlags,
} from "../src/commands/flags";
import { loadSurface } from "../src/surface";

/**
 * Golden descriptor sets over the REAL checked-in surface.json (stage C2.1
 * test 2): the named hard-shape tools are snapshot in test/golden/. A server
 * schema change that alters the mapping — including a `.describe()` help-text
 * regression — fails HERE, not at runtime. Regenerate deliberately with:
 *
 *   STACKS_CLI_UPDATE_GOLDEN=1 pnpm test
 *
 * and review the diff like any contract change.
 */
const GOLDEN_TOOLS = [
  "bulk_create_tasks", // array-of-objects → json/file pair
  "bulk_update_tasks", // array-of-objects + per-item nullables
  "create_agent_session", // optional/nullable mix on a session tool
  "update_task", // nullable clears
  "list_tasks", // enums + optionals
  "move_task", // expectedUpdatedAt present
] as const;

const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);
const update = process.env.STACKS_CLI_UPDATE_GOLDEN === "1";

/** Everything except the coercion fn (functions don't serialize). */
function serializeDescriptor(d: FlagDescriptor) {
  return {
    property: d.property,
    role: d.role,
    name: d.name,
    flag: d.flag,
    optionKey: d.optionKey,
    required: d.required,
    propertyRequired: d.propertyRequired,
    description: d.description,
    helpText: d.helpText,
    choices: d.choices ?? null,
    repeatable: d.repeatable,
    takesValue: d.takesValue,
    negatable: d.negatable,
    jsonTop: d.jsonTop ?? null,
    hasCoerce: typeof d.coerce === "function",
  };
}

function serialize(result: ToolFlags) {
  return {
    tool: result.toolName,
    warnings: result.warnings,
    descriptors: result.descriptors.map(serializeDescriptor),
  };
}

describe("flags — golden descriptor sets over the real surface.json", () => {
  for (const name of GOLDEN_TOOLS) {
    it(`matches the golden mapping for ${name}`, () => {
      const tool = manifest.tools.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} missing from surface.json`);
      const actual = serialize(buildToolFlags(tool));
      const goldenUrl = new URL(`./golden/flags-${name}.json`, import.meta.url);
      if (update) {
        writeFileSync(goldenUrl, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }
      assert.ok(
        existsSync(goldenUrl),
        `golden file test/golden/flags-${name}.json missing — create it with STACKS_CLI_UPDATE_GOLDEN=1 pnpm test`,
      );
      const golden = JSON.parse(readFileSync(goldenUrl, "utf8")) as unknown;
      assert.deepEqual(
        actual,
        golden,
        `descriptor mapping for ${name} drifted from test/golden/flags-${name}.json — ` +
          `if the surface change is intentional, regenerate with STACKS_CLI_UPDATE_GOLDEN=1 pnpm test and review the diff`,
      );
    });
  }

  it("goldens capture help text, so .describe() regressions fail at regen time", () => {
    for (const name of GOLDEN_TOOLS) {
      const goldenUrl = new URL(`./golden/flags-${name}.json`, import.meta.url);
      if (!existsSync(goldenUrl)) continue; // the per-tool test already failed
      const golden = JSON.parse(readFileSync(goldenUrl, "utf8")) as {
        descriptors: Array<Record<string, unknown>>;
      };
      assert.ok(golden.descriptors.length > 0, `${name}: golden is empty`);
      for (const d of golden.descriptors) {
        assert.ok(
          typeof d.description === "string" && typeof d.helpText === "string",
          `${name}: golden descriptor ${String(d.flag)} lost its help-text fields`,
        );
      }
      // at least one descriptor per golden tool carries real schema prose
      assert.ok(
        golden.descriptors.some(
          (d) => typeof d.description === "string" && d.description.length > 0,
        ),
        `${name}: no descriptor carries a schema description`,
      );
    }
  });

  it("spot-checks the update_task nullable-clear pair against the live mapping", () => {
    // Belt-and-braces beyond the snapshot: the canonical "pass null to
    // clear" flow keeps its paired flags with the exact contract shape.
    const tool = manifest.tools.find((t) => t.name === "update_task");
    assert.ok(tool);
    const { descriptors } = buildToolFlags(tool);
    const dueAt = descriptors.filter((d) => d.property === "dueAt");
    assert.deepEqual(
      dueAt.map((d) => [d.role, d.flag]),
      [
        ["value", "--due-at <value>"],
        ["clear", "--clear-due-at"],
      ],
    );
    const priority = descriptors.find((d) => d.property === "priority");
    assert.deepEqual(priority?.choices, ["LOW", "MEDIUM", "HIGH", "URGENT"]);
    const expected = descriptors.find(
      (d) => d.property === "expectedUpdatedAt",
    );
    assert.equal(expected?.flag, "--expected-updated-at <value>");
  });
});
