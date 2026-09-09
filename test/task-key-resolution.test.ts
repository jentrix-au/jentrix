/**
 * JEN-495 (hardening PRD S2, D4) — EVERY alias that takes `--task` resolves a
 * human key.
 *
 * `jentrix task get --task JEN-485` answered NOT_FOUND because the alias layer
 * passed the key through as a bare `taskId`, while `session align` had been
 * resolving keys correctly with `taskLookupArgs` all along (§4 G5). Both
 * JEN-484 runs lost a turn to it. The table below is driven off the REAL alias
 * map, so a new `--task`-taking alias is covered the day it is added.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ALIASES } from "../src/commands/aliases";
import { runToolCommand, type ToolCommandDeps } from "../src/commands/tool";
import { loadSurface } from "../src/surface";

const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);

/** Every aliased tool whose input schema has a `taskId` property. */
const TASK_TOOLS = manifest.tools
  .filter(
    (tool) =>
      ALIASES[tool.name] !== undefined &&
      typeof tool.inputSchema === "object" &&
      tool.inputSchema !== null &&
      "properties" in tool.inputSchema &&
      typeof (tool.inputSchema as { properties?: unknown }).properties ===
        "object" &&
      "taskId" in
        ((tool.inputSchema as { properties: Record<string, unknown> })
          .properties ?? {}),
  )
  .map((tool) => tool.name)
  .sort();

const WORKSPACE = "cmt2cuhyo000004l38ddsim1y";
const TASK_ID = "cmttgol7l000704l55duhuzv6";

interface Sent {
  name: string;
  args: Record<string, unknown>;
}

function fakeDeps(
  sent: Sent[],
  folderWorkspaceId: string | null,
): ToolCommandDeps {
  return {
    env: { STACKS_TOKEN: "tm_test_token_value", STACKS_MCP_URL: "https://x/y" },
    configFile: () => null,
    knownTools: new Set(manifest.tools.map((tool) => tool.name)),
    folderWorkspaceId: async () => folderWorkspaceId,
    connect: async () => ({
      // The MCP SDK's CallToolResult union is wider than this stub needs; the
      // cast is at the seam, not inside the assertions.
      caller: {
        callTool: async (input: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => {
          sent.push({ name: input.name, args: input.arguments ?? {} });
          // The resolver's own `get_task` and the real call share this stub.
          return {
            content: [],
            structuredContent: {
              id: TASK_ID,
              key: "JEN-486",
              workspaceId: WORKSPACE,
            },
          };
        },
      } as unknown as Awaited<ReturnType<ToolCommandDeps["connect"]>>["caller"],
      close: async () => undefined,
    }),
    readStdin: async () => "",
    readFile: () => "",
    writeOut: () => undefined,
    writeErr: () => undefined,
    sleep: async () => undefined,
    now: () => 0,
  };
}

describe("every --task alias resolves a human key (D4)", () => {
  it("the table is not empty (a manifest change must not silently empty it)", () => {
    assert.ok(TASK_TOOLS.length >= 8, `only ${TASK_TOOLS.length} task tools`);
  });

  for (const tool of TASK_TOOLS) {
    it(`${tool} — JEN-486 reaches the server as an id, never as a key`, async () => {
      const sent: Sent[] = [];
      const code = await runToolCommand(
        tool,
        {
          args: JSON.stringify({ taskId: "JEN-486" }),
          maxWait: "0",
          wait: false,
        },
        fakeDeps(sent, WORKSPACE),
      );
      assert.equal(code, 0, `${tool} exited ${code}`);
      const final = sent.at(-1)!;
      assert.equal(final.name, tool);
      if (tool === "get_task") {
        // The one tool whose schema takes the pair — no extra round trip.
        assert.equal(sent.length, 1);
        assert.equal(final.args.taskId, undefined);
        assert.equal(final.args.workspaceId, WORKSPACE);
        assert.equal(final.args.number, 486);
      } else {
        assert.equal(
          final.args.taskId,
          TASK_ID,
          `${tool} sent ${String(final.args.taskId)}`,
        );
      }
    });
  }

  it("an unbound folder refuses with TASK_WORKSPACE_REQUIRED naming the id form", async () => {
    const sent: Sent[] = [];
    const errors: string[] = [];
    const deps = fakeDeps(sent, null);
    const code = await runToolCommand(
      "get_task",
      {
        args: JSON.stringify({ taskId: "JEN-486" }),
        maxWait: "0",
        wait: false,
      },
      { ...deps, writeErr: (text) => errors.push(text) },
    );
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /TASK_WORKSPACE_REQUIRED/);
    assert.match(errors.join("\n"), /use the task id/);
    assert.deepEqual(sent, [], "nothing was sent");
  });

  it("a task ID is passed through untouched (no resolution round trip)", async () => {
    const sent: Sent[] = [];
    const code = await runToolCommand(
      "get_task",
      { args: JSON.stringify({ taskId: TASK_ID }), maxWait: "0", wait: false },
      fakeDeps(sent, WORKSPACE),
    );
    assert.equal(code, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.args.taskId, TASK_ID);
  });
});
