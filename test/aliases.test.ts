import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ALIASES, FLAG_RENAMES } from "../src/commands/aliases";
import { loadSurface } from "../src/surface";

/**
 * Alias-table honesty (stage C2.2 test 1): every alias references a real
 * manifest tool, no two aliases collide, renames reference real schema
 * properties. Combined with the app repo's surface-sync test, a renamed
 * server tool fails CI in BOTH packages instead of silently dropping a
 * command.
 */
const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);
const toolByName = new Map(manifest.tools.map((tool) => [tool.name, tool]));

const PATH_SEGMENT = /^[a-z][a-z0-9-]*$/;

/** Flag names the tree builder reserves for cross-cutting flags (build.ts). */
const RESERVED_FLAG_NAMES = new Set([
  "help",
  "args",
  "json",
  "url",
  "token",
  "wait",
  "no-wait",
  "max-wait",
]);

describe("aliases — table integrity against the real surface.json", () => {
  it("every alias references a real manifest tool", () => {
    const unknown = Object.keys(ALIASES).filter(
      (name) => !toolByName.has(name),
    );
    assert.deepEqual(
      unknown,
      [],
      `aliases reference tools missing from surface.json: ${unknown.join(", ")} — ` +
        "the server tool was renamed/removed; update cli/src/commands/aliases.ts",
    );
  });

  it("every alias path is exactly two kebab-case segments", () => {
    for (const [tool, path] of Object.entries(ALIASES)) {
      const segments = path.split(" ");
      assert.equal(
        segments.length,
        2,
        `${tool}: "${path}" must be "noun verb"`,
      );
      for (const segment of segments) {
        assert.match(
          segment,
          PATH_SEGMENT,
          `${tool}: segment "${segment}" is not kebab-case`,
        );
      }
    }
  });

  it("no two aliases collide on the same command path", () => {
    const seen = new Map<string, string>();
    for (const [tool, path] of Object.entries(ALIASES)) {
      const owner = seen.get(path);
      assert.equal(
        owner,
        undefined,
        `alias path "${path}" claimed by both ${owner} and ${tool}`,
      );
      seen.set(path, tool);
    }
  });

  it("no alias shadows the reserved top-level commands", () => {
    for (const [tool, path] of Object.entries(ALIASES)) {
      const group = path.split(" ")[0];
      assert.ok(
        group !== "tool" && group !== "help",
        `${tool}: alias "${path}" shadows the reserved "${group}" command`,
      );
    }
  });

  it("covers the stage-mandated high-traffic surface", () => {
    // The C2.2 minimum, product-manifest edition (v2 D8): task, board,
    // column, label, comment, subtask, member, workspace list, activity,
    // link. (Contacts left the surface with the product flip.)
    const required: Record<string, string> = {
      list_tasks: "task list",
      get_task: "task get",
      create_task: "task create",
      update_task: "task update",
      move_task: "task move",
      archive_task: "task archive",
      search_tasks: "task search",
      list_boards: "board list",
      create_board: "board create",
      rename_board: "board rename",
      unarchive_boards: "board unarchive",
      get_board_snapshot: "board snapshot",
      list_columns: "column list",
      manage_columns: "column manage",
      list_labels: "label list",
      manage_labels: "label manage",
      list_comments: "comment list",
      create_comment: "comment create",
      update_comment: "comment update",
      delete_comment: "comment delete",
      create_subtask: "subtask create",
      toggle_subtask: "subtask toggle",
      delete_subtask: "subtask delete",
      list_members: "member list",
      list_workspaces: "workspace list",
      list_activity: "activity list",
      add_task_link: "link add",
      remove_task_link: "link remove",
      list_task_links: "link list",
    };
    for (const [tool, path] of Object.entries(required)) {
      assert.equal(ALIASES[tool], path, `required alias drifted for ${tool}`);
    }
  });
});

describe("aliases — flag renames reference real schema properties", () => {
  it("every rename targets a real tool and a real top-level property", () => {
    for (const [toolName, renames] of Object.entries(FLAG_RENAMES)) {
      const tool = toolByName.get(toolName);
      assert.ok(tool, `FLAG_RENAMES references unknown tool "${toolName}"`);
      const properties = tool.inputSchema.properties;
      assert.ok(
        typeof properties === "object" && properties !== null,
        `${toolName}: inputSchema has no properties object`,
      );
      for (const property of Object.keys(renames)) {
        assert.ok(
          property in (properties as Record<string, unknown>),
          `${toolName}: rename targets unknown property "${property}"`,
        );
      }
    }
  });

  it("rename targets are kebab-case, unique per tool, and not reserved", () => {
    for (const [toolName, renames] of Object.entries(FLAG_RENAMES)) {
      const targets = Object.values(renames);
      assert.equal(
        new Set(targets).size,
        targets.length,
        `${toolName}: duplicate rename targets`,
      );
      for (const target of targets) {
        assert.match(
          target,
          PATH_SEGMENT,
          `${toolName}: rename target "${target}" is not kebab-case`,
        );
        assert.ok(
          !RESERVED_FLAG_NAMES.has(target),
          `${toolName}: rename target "${target}" collides with a cross-cutting flag`,
        );
      }
    }
  });
});
