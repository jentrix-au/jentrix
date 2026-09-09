import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import { Command } from "commander";

import { ALIASES, FLAG_RENAMES } from "../src/commands/aliases";
import {
  autoMountPath,
  buildProgram,
  mountCommandTree,
  planCommandTree,
  type AliasConfig,
  type TreeRuntime,
} from "../src/commands/build";
import { registerTaskContextCommands } from "../src/commands/task-context";
import type { ToolCommandDeps } from "../src/commands/tool";
import {
  loadSurface,
  type SurfaceManifest,
  type SurfaceTool,
} from "../src/surface";

const manifest = loadSurface(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);
const realConfig: AliasConfig = { aliases: ALIASES, flagRenames: FLAG_RENAMES };

function makeTool(
  overrides: Partial<SurfaceTool> & { name: string },
): SurfaceTool {
  return {
    description: `Synthetic ${overrides.name}.`,
    toolClass: "write",
    inputSchema: { type: "object", properties: {} },
    annotations: {},
    ...overrides,
  };
}

function makeManifest(tools: SurfaceTool[]): SurfaceManifest {
  return { generatedForToolCount: tools.length, tools };
}

const EMPTY_CONFIG: AliasConfig = { aliases: {}, flagRenames: {} };

/** A runtime whose action handlers must never run in these tests. */
const inertRuntime: TreeRuntime = {
  deps: {} as ToolCommandDeps,
  onExit: () => {
    throw new Error("onExit must not be called from help rendering");
  },
};

describe("planCommandTree — real surface + real aliases", () => {
  const plan = planCommandTree(manifest, realConfig);

  it("produces ZERO warnings over the real surface (drift fails CI here)", () => {
    assert.deepEqual(plan.warnings, []);
  });

  it("every manifest tool is reachable exactly once", () => {
    const mounted = plan.mounts.map((m) => m.tool.name).sort();
    const expected = manifest.tools.map((t) => t.name).sort();
    assert.deepEqual(mounted, expected);
    assert.equal(plan.mounts.length, manifest.tools.length);
  });

  it("no two mounts share a full command path", () => {
    const paths = plan.mounts.map((m) => m.path.join(" "));
    assert.equal(new Set(paths).size, paths.length);
  });

  it("aliased tools mount at their curated paths", () => {
    const pathOf = (name: string) =>
      plan.mounts.find((m) => m.tool.name === name)?.path.join(" ");
    for (const [tool, alias] of Object.entries(ALIASES)) {
      assert.equal(pathOf(tool), alias, `alias not honored for ${tool}`);
      assert.equal(
        plan.mounts.find((m) => m.tool.name === tool)?.mountedVia,
        "alias",
      );
    }
  });

  it("auto-mounts fold the verb behind the noun (the stage example)", () => {
    const mount = plan.mounts.find(
      (m) => m.tool.name === "list_agent_sessions",
    );
    assert.deepEqual(mount?.path, ["agent", "list-sessions"]);
    assert.equal(mount?.mountedVia, "auto");
  });

  it("plural and singular tool names merge into one group", () => {
    const groupOf = (name: string) =>
      plan.mounts.find((m) => m.tool.name === name)?.path[0];
    assert.equal(groupOf("list_agent_sessions"), "agent");
    assert.equal(groupOf("get_agent_session"), "agent");
    assert.equal(groupOf("list_projects"), "project");
    assert.equal(groupOf("get_project"), "project");
    assert.equal(groupOf("list_artifacts"), "artifact");
    assert.equal(groupOf("get_artifact"), "artifact");
  });

  it("no auto-mounted group shadows the reserved top-level commands", () => {
    for (const mount of plan.mounts) {
      assert.notEqual(mount.path[0], "tool");
      assert.notEqual(mount.path[0], "help");
    }
  });

  describe("cross-cutting flags are schema-detected (full-surface sweep)", () => {
    it("--idempotency-key appears exactly on tools whose schema has idempotencyKey", () => {
      for (const mount of plan.mounts) {
        const properties = mount.tool.inputSchema.properties as
          Record<string, unknown> | undefined;
        const wants =
          properties !== undefined && "idempotencyKey" in properties;
        const has = mount.descriptors.some(
          (d) =>
            d.name === "idempotency-key" && d.property === "idempotencyKey",
        );
        assert.equal(
          has,
          wants,
          `${mount.tool.name}: --idempotency-key presence (${has}) != schema (${wants})`,
        );
      }
    });

    it("--if-unmodified-since appears exactly on tools whose schema has expectedUpdatedAt", () => {
      for (const mount of plan.mounts) {
        const properties = mount.tool.inputSchema.properties as
          Record<string, unknown> | undefined;
        const wants =
          properties !== undefined && "expectedUpdatedAt" in properties;
        const has = mount.descriptors.some(
          (d) =>
            d.name === "if-unmodified-since" &&
            d.property === "expectedUpdatedAt",
        );
        assert.equal(
          has,
          wants,
          `${mount.tool.name}: --if-unmodified-since presence (${has}) != schema (${wants})`,
        );
        // The old kebab name must be gone when renamed.
        assert.ok(
          !mount.descriptors.some((d) => d.name === "expected-updated-at"),
          `${mount.tool.name}: --expected-updated-at survived the rename`,
        );
      }
    });

    it("spot-checks the stage's named tools", () => {
      const flagsOf = (name: string) =>
        planCommandTree(manifest, realConfig)
          .mounts.find((m) => m.tool.name === name)!
          .descriptors.map((d) => d.name);
      // create_task: idempotencyKey yes, expectedUpdatedAt no.
      const createTask = flagsOf("create_task");
      assert.ok(createTask.includes("idempotency-key"));
      assert.ok(!createTask.includes("if-unmodified-since"));
      // bulk_create_tasks: idempotencyKey yes.
      const bulk = flagsOf("bulk_create_tasks");
      assert.ok(bulk.includes("idempotency-key"));
      assert.ok(!bulk.includes("if-unmodified-since"));
      // update_task / move_task: expectedUpdatedAt yes, idempotencyKey no.
      for (const name of ["update_task", "move_task"]) {
        const flags = flagsOf(name);
        assert.ok(flags.includes("if-unmodified-since"), name);
        assert.ok(!flags.includes("idempotency-key"), name);
      }
      // A read tool has NEITHER.
      const listTasks = flagsOf("list_tasks");
      assert.ok(!listTasks.includes("idempotency-key"));
      assert.ok(!listTasks.includes("if-unmodified-since"));
    });

    it("--if-unmodified-since keeps the <iso> placeholder and string passthrough", () => {
      const mount = plan.mounts.find((m) => m.tool.name === "update_task")!;
      const descriptor = mount.descriptors.find(
        (d) => d.property === "expectedUpdatedAt",
      )!;
      assert.equal(descriptor.flag, "--if-unmodified-since <iso>");
      // Plain string property: no coercion — the exact string reaches args.
      assert.equal(descriptor.coerce, undefined);
    });
  });

  describe("workspace/board/task ergonomic renames", () => {
    it("workspaceId → --workspace, boardId → --board, taskId → --task", () => {
      const descriptorOf = (tool: string, property: string) =>
        plan.mounts
          .find((m) => m.tool.name === tool)!
          .descriptors.find((d) => d.property === property);
      assert.equal(
        descriptorOf("search_tasks", "workspaceId")?.name,
        "workspace",
      );
      assert.equal(descriptorOf("list_tasks", "boardId")?.name, "board");
      assert.equal(descriptorOf("update_task", "taskId")?.name, "task");
      assert.equal(descriptorOf("get_task", "taskId")?.name, "task");
    });

    it("required workspace/board flags become defaultable (commander-optional)", () => {
      const searchTasks = plan.mounts.find(
        (m) => m.tool.name === "search_tasks",
      )!;
      const ws = searchTasks.descriptors.find(
        (d) => d.property === "workspaceId",
      )!;
      assert.equal(ws.required, false, "commander must not pre-empt defaults");
      assert.equal(ws.propertyRequired, true);
      assert.deepEqual(searchTasks.defaultable, [
        {
          property: "workspaceId",
          optionKey: "workspace",
          flagName: "workspace",
          configKey: "workspace",
        },
      ]);
      const snapshot = plan.mounts.find(
        (m) => m.tool.name === "get_board_snapshot",
      )!;
      assert.deepEqual(
        snapshot.defaultable.map((d) => [d.property, d.configKey]),
        [["boardId", "board"]],
      );
    });

    it("no descriptor is commander-mandatory; required flags say so in help", () => {
      // Requiredness is enforced post-merge (runGeneratedCommand) so --args
      // and config defaults can satisfy required properties.
      for (const mount of plan.mounts) {
        for (const d of mount.descriptors) {
          assert.equal(
            d.required,
            false,
            `${mount.tool.name} --${d.name} must not be commander-mandatory`,
          );
        }
      }
      const createTask = plan.mounts.find(
        (m) => m.tool.name === "create_task",
      )!;
      const columnId = createTask.descriptors.find(
        (d) => d.property === "columnId",
      )!;
      assert.match(columnId.helpText, /\(required\)/);
    });

    it("OPTIONAL workspace/board properties are never defaultable", () => {
      // Injecting into optional filters would silently change semantics
      // (list_activity boardId, get_task workspaceId).
      for (const name of ["list_activity", "get_task", "list_tasks"]) {
        const mount = plan.mounts.find((m) => m.tool.name === name)!;
        assert.deepEqual(mount.defaultable, [], name);
      }
    });
  });

  it("the aliased url properties got their curated names (no --url shadowing)", () => {
    const nameOf = (tool: string) =>
      plan.mounts
        .find((m) => m.tool.name === tool)!
        .descriptors.find((d) => d.property === "url")?.name;
    assert.equal(nameOf("attach_artifact"), "artifact-url");
  });
});

describe("planCommandTree — determinism", () => {
  it("manifest order does not matter (tools are processed sorted by name)", () => {
    const reversed = makeManifest([...manifest.tools].reverse());
    const a = planCommandTree(manifest, realConfig);
    const b = planCommandTree(reversed, realConfig);
    assert.deepEqual(
      a.mounts.map((m) => [m.tool.name, ...m.path]),
      b.mounts.map((m) => [m.tool.name, ...m.path]),
    );
    assert.deepEqual(a.warnings, b.warnings);
  });

  it("planning twice yields identical plans", () => {
    const a = planCommandTree(manifest, realConfig);
    const b = planCommandTree(manifest, realConfig);
    assert.deepEqual(
      a.mounts.map((m) => ({
        tool: m.tool.name,
        path: m.path,
        flags: m.descriptors.map((d) => d.flag),
      })),
      b.mounts.map((m) => ({
        tool: m.tool.name,
        path: m.path,
        flags: m.descriptors.map((d) => d.flag),
      })),
    );
  });
});

describe("planCommandTree — every tool mounts even with an empty alias table", () => {
  it("empty aliases: all tools reachable exactly once, all paths unique", () => {
    const plan = planCommandTree(manifest, EMPTY_CONFIG);
    assert.equal(plan.mounts.length, manifest.tools.length);
    const paths = plan.mounts.map((m) => m.path.join(" "));
    assert.equal(new Set(paths).size, paths.length);
    for (const mount of plan.mounts) assert.equal(mount.mountedVia, "auto");
  });
});

describe("cross-cutting flag detection flips with the schema (synthetic manifest)", () => {
  const withKey = makeTool({
    name: "create_widget",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: ["title"],
    },
  });
  const withoutKey = makeTool({
    name: "create_gadget",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
  });
  const withFreshness = makeTool({
    name: "update_widget",
    inputSchema: {
      type: "object",
      properties: {
        widgetId: { type: "string" },
        expectedUpdatedAt: { type: "string" },
      },
      required: ["widgetId"],
    },
  });

  it("idempotencyKey present → --idempotency-key mounted; absent → not", () => {
    const plan = planCommandTree(
      makeManifest([withKey, withoutKey]),
      EMPTY_CONFIG,
    );
    const flagsOf = (name: string) =>
      plan.mounts
        .find((m) => m.tool.name === name)!
        .descriptors.map((d) => d.name);
    assert.ok(flagsOf("create_widget").includes("idempotency-key"));
    assert.ok(!flagsOf("create_gadget").includes("idempotency-key"));
  });

  it("expectedUpdatedAt present → --if-unmodified-since mounted; absent → not", () => {
    const plan = planCommandTree(
      makeManifest([withFreshness, withoutKey]),
      EMPTY_CONFIG,
    );
    const flagsOf = (name: string) =>
      plan.mounts
        .find((m) => m.tool.name === name)!
        .descriptors.map((d) => d.name);
    assert.ok(flagsOf("update_widget").includes("if-unmodified-since"));
    assert.ok(!flagsOf("create_gadget").includes("if-unmodified-since"));
  });
});

describe("collision handling — deterministic suffixes, surfaced as warnings", () => {
  it("full-path collision: later tool (name order) gets a -2 suffix + warning", () => {
    const tools = [
      makeTool({ name: "fetch_thing" }),
      makeTool({ name: "get_thing" }),
    ];
    const plan = planCommandTree(makeManifest(tools), {
      aliases: { fetch_thing: "thing get" },
      flagRenames: {},
    });
    const pathOf = (name: string) =>
      plan.mounts.find((m) => m.tool.name === name)!.path.join(" ");
    assert.equal(pathOf("fetch_thing"), "thing get");
    assert.equal(pathOf("get_thing"), "thing get-2");
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /get_thing/);
    assert.match(plan.warnings[0], /renamed to "thing get-2"/);
  });

  it("a derived group named like a reserved command is suffixed", () => {
    // list_tools → verb "list", noun "tools" → singular "tool" (reserved).
    const plan = planCommandTree(
      makeManifest([makeTool({ name: "list_tools" })]),
      EMPTY_CONFIG,
    );
    assert.deepEqual(plan.mounts[0].path, ["tool-2", "list"]);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /reserved/);
  });

  it('a leaf named "help" is suffixed (groups get an implicit help subcommand)', () => {
    const plan = planCommandTree(
      makeManifest([makeTool({ name: "widget_help" })]),
      EMPTY_CONFIG,
    );
    assert.deepEqual(plan.mounts[0].path, ["widget", "help-2"]);
    assert.equal(plan.warnings.length, 1);
  });

  it("a schema property colliding with a cross-cutting flag is suffixed + warned", () => {
    const tool = makeTool({
      name: "register_hook",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    });
    const plan = planCommandTree(makeManifest([tool]), EMPTY_CONFIG);
    const descriptor = plan.mounts[0].descriptors.find(
      (d) => d.property === "url",
    )!;
    assert.equal(descriptor.name, "url-2");
    assert.equal(descriptor.optionKey, "url2");
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /--url collides/);
  });

  it("...unless a per-tool rename in aliases.ts resolves it (no warning)", () => {
    const tool = makeTool({
      name: "register_hook",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    });
    const plan = planCommandTree(makeManifest([tool]), {
      aliases: {},
      flagRenames: { register_hook: { url: "hook-url" } },
    });
    const descriptor = plan.mounts[0].descriptors.find(
      (d) => d.property === "url",
    )!;
    assert.equal(descriptor.name, "hook-url");
    assert.equal(descriptor.flag, "--hook-url <value>");
    assert.deepEqual(plan.warnings, []);
  });

  it("renames follow nullable pairs: value AND --clear-* are re-labeled", () => {
    const tool = makeTool({
      name: "update_widget",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
    });
    const plan = planCommandTree(makeManifest([tool]), EMPTY_CONFIG);
    const names = plan.mounts[0].descriptors.map((d) => d.name);
    assert.deepEqual(names, ["task", "clear-task"]);
    // Cross-references in help prose follow the rename too.
    const clear = plan.mounts[0].descriptors.find((d) => d.role === "clear")!;
    assert.match(clear.helpText, /--task\b/);
    assert.doesNotMatch(clear.helpText, /--task-id/);
    const value = plan.mounts[0].descriptors.find((d) => d.role === "value")!;
    assert.match(value.helpText, /--clear-task\b/);
    assert.deepEqual(plan.warnings, []);
  });

  it("renames skip JSON-mode groups with a warning", () => {
    const tool = makeTool({
      name: "update_widget",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "object" },
        },
      },
    });
    const plan = planCommandTree(makeManifest([tool]), EMPTY_CONFIG);
    const names = plan.mounts[0].descriptors.map((d) => d.name);
    assert.deepEqual(names, ["task-id-json", "task-id-file"]);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /JSON-mode flag group/);
  });

  it("a boolean whose --no-* pair is already claimed is suffixed, never fatal [C2.2-R1-1]", () => {
    // Property order matters: `noFoo` claims --no-foo first, then boolean
    // `foo` must not try to mount its implicit --no-foo over it.
    const tool = makeTool({
      name: "toggle_widget",
      inputSchema: {
        type: "object",
        properties: {
          noFoo: { type: "string" },
          foo: { type: "boolean" },
        },
      },
    });
    const plan = planCommandTree(makeManifest([tool]), EMPTY_CONFIG);
    const boolean = plan.mounts[0].descriptors.find(
      (d) => d.property === "foo",
    )!;
    assert.equal(
      boolean.name,
      "foo-2",
      "boolean must dodge the taken --no-foo",
    );
    assert.ok(plan.warnings.length >= 2, "collision + no- prefix warnings");
    // The decisive check: mounting must not throw inside commander.
    assert.doesNotThrow(() =>
      buildProgram(makeManifest([tool]), EMPTY_CONFIG, inertRuntime),
    );
  });

  it('a value flag literally named "no-*" is warned (commander mis-keys it)', () => {
    const tool = makeTool({
      name: "get_widget",
      inputSchema: {
        type: "object",
        properties: { noCache: { type: "string" } },
      },
    });
    const plan = planCommandTree(makeManifest([tool]), EMPTY_CONFIG);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /reserves for boolean negation/);
  });

  it("alias data errors degrade to auto-mount with a warning", () => {
    const plan = planCommandTree(
      makeManifest([makeTool({ name: "get_thing" })]),
      {
        aliases: { get_thing: "Thing Get Extra", missing_tool: "x y" },
        flagRenames: { other_missing: { a: "b" } },
      },
    );
    assert.deepEqual(plan.mounts[0].path, ["thing", "get"]);
    assert.equal(plan.warnings.length, 3);
    assert.match(plan.warnings.join("\n"), /not two kebab-case segments/);
    assert.match(plan.warnings.join("\n"), /missing_tool/);
    assert.match(plan.warnings.join("\n"), /other_missing/);
  });
});

describe("autoMountPath — derivation rules", () => {
  it("verb folds behind the noun; remaining words join the leaf", () => {
    assert.deepEqual(autoMountPath("list_harness_stages"), [
      "harness",
      "list-stages",
    ]);
    assert.deepEqual(autoMountPath("get_ci_run"), ["ci", "get-run"]);
    assert.deepEqual(autoMountPath("move_task"), ["task", "move"]);
  });

  it("unknown first word becomes the group (bulk_* stays together)", () => {
    assert.deepEqual(autoMountPath("bulk_create_tasks"), [
      "bulk",
      "create-tasks",
    ]);
    assert.deepEqual(autoMountPath("bulk_move_tasks"), ["bulk", "move-tasks"]);
  });

  it("group words are singularized so list/get variants merge", () => {
    assert.deepEqual(autoMountPath("list_agents"), ["agent", "list"]);
    assert.deepEqual(autoMountPath("get_agent"), ["agent", "get"]);
    assert.deepEqual(autoMountPath("list_policies"), ["policy", "list"]);
    assert.deepEqual(autoMountPath("list_harnesses"), ["harness", "list"]);
  });

  it("degenerate names still mount somewhere deterministic", () => {
    assert.deepEqual(autoMountPath("ping"), ["ping", "ping"]);
    assert.deepEqual(autoMountPath("weird_name_with_many_words"), [
      "weird",
      "name-with-many-words",
    ]);
  });
});

describe("help output — frozen snapshots (stage C2.2 test 2)", () => {
  const update = process.env.STACKS_CLI_UPDATE_GOLDEN === "1";
  const program = buildProgram(manifest, realConfig, inertRuntime);

  function helpOf(path: string[]): string {
    let command = program;
    for (const segment of path) {
      const next = command.commands.find((c) => c.name() === segment);
      assert.ok(next, `command "${path.join(" ")}" not found`);
      command = next;
    }
    return command.helpInformation();
  }

  const SNAPSHOTS: Array<{ file: string; path: string[] }> = [
    { file: "help-root.txt", path: [] },
    { file: "help-task.txt", path: ["task"] },
    { file: "help-agent.txt", path: ["agent"] },
    { file: "help-task-update.txt", path: ["task", "update"] },
  ];

  for (const { file, path } of SNAPSHOTS) {
    it(`matches golden ${file}`, () => {
      const actual = helpOf(path);
      const goldenUrl = new URL(`./golden/${file}`, import.meta.url);
      if (update) {
        writeFileSync(goldenUrl, actual);
        return;
      }
      assert.ok(
        existsSync(goldenUrl),
        `golden file test/golden/${file} missing — create it with STACKS_CLI_UPDATE_GOLDEN=1 pnpm test`,
      );
      assert.equal(
        actual,
        readFileSync(goldenUrl, "utf8"),
        `help output drifted from test/golden/${file} — if intentional, ` +
          "regenerate with STACKS_CLI_UPDATE_GOLDEN=1 pnpm test and review the diff",
      );
    });
  }

  // JEN-495 (D3/D4) — the hand-written compositions ride the SESSION program,
  // not the generated tree, so they get their own frozen help beside it.
  it("matches goldens for the hand-written task commands", () => {
    const handWritten = new Command().name("jentrix");
    registerTaskContextCommands(handWritten, {} as never, inertRuntime.onExit);
    for (const [file, path] of [
      ["help-task-context.txt", ["task", "context"]],
      ["help-subtask-list.txt", ["subtask", "list"]],
    ] as const) {
      let command: Command = handWritten;
      for (const segment of path) {
        const next = command.commands.find((c) => c.name() === segment);
        assert.ok(next, `command "${path.join(" ")}" not found`);
        command = next;
      }
      const goldenUrl = new URL(`./golden/${file}`, import.meta.url);
      if (update) {
        writeFileSync(goldenUrl, command.helpInformation());
        continue;
      }
      assert.equal(
        command.helpInformation(),
        readFileSync(goldenUrl, "utf8"),
        `help drifted from test/golden/${file} — regenerate with pnpm gen:help-goldens`,
      );
    }
  });

  it("every manifest tool appears exactly once in the mounted tree", () => {
    // Walk the commander tree: leaves are commands with an action handler;
    // count them and match against the manifest.
    let leaves = 0;
    for (const group of program.commands) {
      for (const leaf of group.commands) {
        if (leaf.name() === "help") continue; // commander's implicit help
        leaves += 1;
      }
    }
    assert.equal(leaves, manifest.tools.length);
  });

  it("the root help lists every group", () => {
    const help = helpOf([]);
    const plan = planCommandTree(manifest, realConfig);
    const groups = new Set(plan.mounts.map((m) => m.path[0]));
    for (const group of groups) {
      assert.match(
        help,
        new RegExp(`^  ${group}\\b`, "m"),
        `group "${group}" missing from root help`,
      );
    }
  });
});

describe("mountCommandTree — hand-registered group reuse", () => {
  it("mounts generated leaves INTO an existing group instead of a shadowing duplicate", async () => {
    // `artifact` is both hand-registered (the upload-grant `upload` leaf in
    // main.ts) and a generated group (attach/get/list). Commander dispatches
    // to the FIRST command matching a name, so a duplicate group makes every
    // leaf of whichever registered second unreachable.
    const program = new Command("stacks");
    const hand = program.command("artifact").description("hand group");
    hand.command("upload <file>").action(() => undefined);
    const plan = planCommandTree(
      makeManifest([makeTool({ name: "list_artifacts", toolClass: "read" })]),
      EMPTY_CONFIG,
    );
    mountCommandTree(program, plan, inertRuntime);
    const groups = program.commands.filter((c) => c.name() === "artifact");
    assert.equal(groups.length, 1, "ONE artifact group — never a duplicate");
    const leaves = groups[0]!.commands.map((c) => c.name()).sort();
    assert.deepEqual(leaves, ["list", "upload"]);
  });
});
