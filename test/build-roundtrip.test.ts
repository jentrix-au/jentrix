import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { ToolCaller } from "../src/call";
import { ALIASES, FLAG_RENAMES } from "../src/commands/aliases";
import { buildProgram, type AliasConfig } from "../src/commands/build";
import type { ToolCommandDeps } from "../src/commands/tool";
import type { JentrixConfigFile } from "../src/config";
import { stableStringify } from "../src/render";
import { loadSurface } from "../src/surface";

/**
 * Parse round-trips over the REAL schemas (stage C2.2 tests 3+4): argv in,
 * exact tool-call arguments out, through the full commander parse →
 * descriptor inverse → runToolCommand path, with every process edge stubbed.
 *
 * Precedence contract under test (documented in build.ts):
 *   explicit flag > --args JSON key > config default (required ws/board).
 */
const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);
const realConfig: AliasConfig = { aliases: ALIASES, flagRenames: FLAG_RENAMES };

function okResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

interface Recorded {
  calls: { name: string; arguments?: Record<string, unknown> }[];
  out: string[];
  err: string[];
}

interface RunOptions {
  config?: JentrixConfigFile | null;
  result?: unknown;
  stdin?: string;
  files?: Record<string, string>;
}

/** Parse argv against the generated tree with all edges stubbed. */
async function run(
  argv: string[],
  options: RunOptions = {},
): Promise<{ code: number | undefined; rec: Recorded; parseError?: unknown }> {
  const rec: Recorded = { calls: [], out: [], err: [] };
  const caller: ToolCaller = {
    callTool: (async (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      rec.calls.push(params);
      return options.result ?? okResult({ ok: true });
    }) as ToolCaller["callTool"],
  };
  const deps: ToolCommandDeps = {
    env: { STACKS_TOKEN: "tm_test_token" },
    configFile: () => options.config ?? null,
    knownTools: new Set(manifest.tools.map((tool) => tool.name)),
    connect: async () => ({ caller, close: async () => undefined }),
    readStdin: async () => options.stdin ?? "",
    readFile: (path) => {
      const content = options.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeOut: (text) => rec.out.push(text),
    writeErr: (text) => rec.err.push(text),
    sleep: async () => undefined,
    now: () => 0,
  };
  let code: number | undefined;
  const program = buildProgram(manifest, realConfig, {
    deps,
    onExit: (c) => {
      code = c;
    },
  });
  program.configureOutput({ writeErr: () => undefined });
  try {
    await program.parseAsync(["node", "stacks", ...argv]);
  } catch (parseError) {
    return { code, rec, parseError };
  }
  return { code, rec };
}

describe("round-trips — flag→args fidelity against the real schemas", () => {
  it("task create --column-id c1 --title T --idempotency-key k → create_task args", async () => {
    const { code, rec } = await run([
      "task",
      "create",
      "--column-id",
      "c1",
      "--title",
      "T",
      "--idempotency-key",
      "k",
    ]);
    assert.equal(code, 0);
    assert.deepEqual(rec.calls, [
      {
        name: "create_task",
        arguments: { columnId: "c1", title: "T", idempotencyKey: "k" },
      },
    ]);
  });

  it("task update --task t1 --clear-due-at --if-unmodified-since <iso> → nulls + exact string", async () => {
    // Offset form on purpose: new Date(iso).toISOString() would rewrite it
    // to ...08:20:30.456Z, so this assert alone falsifies any Date
    // round-trip in the pipeline [C2.2-R1-3].
    const iso = "2026-07-06T10:20:30.456+02:00";
    const { code, rec } = await run([
      "task",
      "update",
      "--task",
      "t1",
      "--clear-due-at",
      "--if-unmodified-since",
      iso,
    ]);
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0], {
      name: "update_task",
      arguments: { taskId: "t1", dueAt: null, expectedUpdatedAt: iso },
    });
    // SVR focus: the value is the EXACT string — no Date round-trip.
    assert.equal(rec.calls[0]?.arguments?.expectedUpdatedAt, iso);
  });

  it("task list --board b1 --json → list_tasks args + raw JSON stdout", async () => {
    const payload = { tasks: [{ id: "t1", key: "STK-1" }], totalCount: 1 };
    const { code, rec } = await run(
      ["task", "list", "--board", "b1", "--json"],
      { result: okResult(payload) },
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0], {
      name: "list_tasks",
      arguments: { boardId: "b1" },
    });
    assert.deepEqual(rec.out, [stableStringify(payload)]);
  });

  it("board unarchive accumulates repeatable --board-ids flags", async () => {
    const payload = { unarchived: 2 };
    const { code, rec } = await run(
      [
        "board",
        "unarchive",
        "--workspace",
        "cmws1000000000000000001",
        "--board-ids",
        "board_1",
        "--board-ids",
        "board_2",
        "--json",
      ],
      { result: okResult(payload) },
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0], {
      name: "unarchive_boards",
      arguments: {
        workspaceId: "cmws1000000000000000001",
        boardIds: ["board_1", "board_2"],
      },
    });
    assert.deepEqual(rec.out, [stableStringify(payload)]);
  });

  it("enum flags coerce and repeatable arrays accumulate", async () => {
    const { code, rec } = await run([
      "task",
      "create",
      "--column-id",
      "c1",
      "--title",
      "T",
      "--priority",
      "HIGH",
    ]);
    assert.equal(code, 0);
    assert.equal(rec.calls[0]?.arguments?.priority, "HIGH");
  });

  it("boolean flags: absent → omitted; --include-archived → true; --no-include-archived → false", async () => {
    const absent = await run(["task", "list", "--board", "b1"]);
    assert.ok(
      !("includeArchived" in (absent.rec.calls[0]?.arguments ?? {})),
      "absent boolean must not be sent",
    );
    const positive = await run([
      "task",
      "list",
      "--board",
      "b1",
      "--include-archived",
    ]);
    assert.equal(positive.rec.calls[0]?.arguments?.includeArchived, true);
    const negative = await run([
      "task",
      "list",
      "--board",
      "b1",
      "--no-include-archived",
    ]);
    assert.equal(negative.rec.calls[0]?.arguments?.includeArchived, false);
  });

  it("auto-mounted commands round-trip too (bulk create-tasks, --tasks-file -)", async () => {
    const { code, rec } = await run(
      ["bulk", "create-tasks", "--column-id", "c1", "--tasks-file", "-"],
      { stdin: '[{"title":"A"},{"title":"B"}]' },
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0], {
      name: "bulk_create_tasks",
      arguments: { columnId: "c1", tasks: [{ title: "A" }, { title: "B" }] },
    });
  });

  it("missing required flag → exit 2 naming the flag, nothing sent", async () => {
    // Requiredness is enforced post-merge (never commander-mandatory), so
    // --args and config defaults can satisfy required properties.
    const { code, rec } = await run(["task", "create", "--title", "T"]);
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /missing required flag --column-id/);
  });

  it("bad enum value → commander invalid-argument usage error (exit-2 class)", async () => {
    const { rec, parseError } = await run([
      "task",
      "create",
      "--column-id",
      "c1",
      "--title",
      "T",
      "--priority",
      "BOGUS",
    ]);
    assert.ok(parseError, "expected a commander usage error");
    assert.equal(
      (parseError as { code?: string }).code,
      "commander.invalidArgument",
    );
    assert.equal(rec.calls.length, 0);
  });

  it("mutual exclusion --due-at vs --clear-due-at → exit 2, nothing sent", async () => {
    const { code, rec } = await run([
      "task",
      "update",
      "--task",
      "t1",
      "--due-at",
      "2026-08-01T00:00:00.000Z",
      "--clear-due-at",
    ]);
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /only one of/);
  });

  it("error envelopes map through the frozen exit codes (FORBIDDEN → 3)", async () => {
    const { code } = await run(
      ["task", "create", "--column-id", "c1", "--title", "T"],
      {
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: { code: "FORBIDDEN", message: "read-only token" },
              }),
            },
          ],
        },
      },
    );
    assert.equal(code, 3);
  });
});

describe("round-trips — --args merge precedence (stage C2.2 test 4)", () => {
  it("explicit flags WIN over --args keys; --args fills the rest", async () => {
    const { code, rec } = await run([
      "task",
      "create",
      "--title",
      "FromFlag",
      "--args",
      '{"title":"FromArgs","priority":"LOW","columnId":"c1"}',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0]?.arguments, {
      columnId: "c1", // only in --args → survives
      priority: "LOW", // only in --args → survives
      title: "FromFlag", // in both → flag wins
    });
  });

  it("the reverse direction: keys only in --args pass through verbatim", async () => {
    const { code, rec } = await run([
      "task",
      "create",
      "--args",
      '{"columnId":"c1","title":"OnlyArgs","description":"d"}',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0]?.arguments, {
      columnId: "c1",
      description: "d",
      title: "OnlyArgs",
    });
  });

  it("--args satisfies a required property (flags absent, no usage error)", async () => {
    // columnId is required; supplied via --args only.
    const { code, rec } = await run([
      "task",
      "create",
      "--title",
      "T",
      "--args",
      '{"columnId":"c1"}',
    ]);
    assert.equal(code, 0);
    assert.equal(rec.calls[0]?.arguments?.columnId, "c1");
  });

  it("flag null (--clear-due-at) beats an --args value for the same property", async () => {
    const { rec } = await run([
      "task",
      "update",
      "--task",
      "t1",
      "--clear-due-at",
      "--args",
      '{"dueAt":"2026-08-01T00:00:00.000Z"}',
    ]);
    assert.equal(rec.calls[0]?.arguments?.dueAt, null);
  });

  it("invalid --args JSON → exit 2, nothing sent", async () => {
    const { code, rec } = await run([
      "task",
      "create",
      "--column-id",
      "c1",
      "--title",
      "T",
      "--args",
      "{not json",
    ]);
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /not valid JSON/);
  });
});

describe("round-trips — config defaults for required workspace/board", () => {
  const config: JentrixConfigFile = {
    defaults: { workspace: "cmwsdef00000000000000000", board: "b-def" },
  };

  it("member list ← defaults.workspace when no flag given", async () => {
    const { code, rec } = await run(["member", "list"], { config });
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0], {
      name: "list_members",
      arguments: { workspaceId: "cmwsdef00000000000000000" },
    });
  });

  it("board snapshot ← defaults.board when no flag given", async () => {
    const { code, rec } = await run(["board", "snapshot"], { config });
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0], {
      name: "get_board_snapshot",
      arguments: { boardId: "b-def" },
    });
  });

  it("explicit --workspace beats the config default", async () => {
    const { rec } = await run(
      ["member", "list", "--workspace", "cmws9000000000000000000"],
      {
        config,
      },
    );
    assert.equal(
      rec.calls[0]?.arguments?.workspaceId,
      "cmws9000000000000000000",
    );
  });

  it("--args workspaceId beats the config default (no injection)", async () => {
    const { rec } = await run(
      ["member", "list", "--args", '{"workspaceId":"cmws7000000000000000000"}'],
      { config },
    );
    assert.equal(
      rec.calls[0]?.arguments?.workspaceId,
      "cmws7000000000000000000",
    );
  });

  it("no default + no flag → exit 2 naming the missing flag, nothing sent", async () => {
    const { code, rec } = await run(["member", "list"]);
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /--workspace/);
  });

  it("OPTIONAL workspaceId is never injected (get_task semantics preserved)", async () => {
    const { rec } = await run(["task", "get", "--task", "t1"], { config });
    assert.deepEqual(rec.calls[0], {
      name: "get_task",
      arguments: { taskId: "t1" },
    });
  });

  it("OPTIONAL boardId is never injected (list_activity filters untouched)", async () => {
    const { rec } = await run(["activity", "list", "--task", "t1"], {
      config,
    });
    assert.deepEqual(rec.calls[0], {
      name: "list_activity",
      arguments: { taskId: "t1" },
    });
  });

  it("non-string default → notice + treated as absent", async () => {
    const { code, rec } = await run(["member", "list"], {
      config: { defaults: { workspace: 42 as unknown as string } },
    });
    assert.equal(code, 2);
    assert.match(rec.err.join("\n"), /defaults\.workspace is not a string/);
    assert.match(rec.err.join("\n"), /--workspace/);
  });
});
