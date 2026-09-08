import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import { registerSessionCommand } from "../src/commands/session";
import { type SessionCommandDeps } from "../src/session/deps";
import { registerTaskProjectCommand } from "../src/commands/task-project";
import { writeFolderBinding } from "../src/binding";
import { resolveTask, resolveTaskId } from "../src/task-resolution";
import { runSessionHost } from "../src/session-host/session-host";
import {
  callStructured,
  ToolCallError,
  structuredToolResult,
} from "../src/tool-client";

const adopted = JSON.parse(
  readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
);
const taskSchema = adopted.tools.find(
  (t: { name: string }) => t.name === "get_task",
).inputSchema;
function validateTaskArgs(args: Record<string, unknown>): void {
  assert.ok(
    Object.keys(args).every((k) => k in taskSchema.properties),
    "get_task received an unadopted argument",
  );
  assert.equal(
    typeof args.taskId === "string",
    !(typeof args.workspaceId === "string" && typeof args.number === "number"),
  );
  assert.equal(args.response_format, "concise");
}
function world(
  options: {
    bound?: boolean;
    task?: Record<string, unknown>;
    taskError?: unknown;
    projectError?: unknown;
    projects?: unknown;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "jentrix-defects-"));
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const out: string[] = [],
    err: string[] = [];
  let connects = 0;
  const caller = {
    async callTool(input: {
      name: string;
      arguments: Record<string, unknown>;
    }) {
      calls.push(input);
      if (input.name === "get_task") {
        validateTaskArgs(input.arguments);
        if (options.taskError) throw options.taskError;
        return {
          structuredContent: options.task ?? {
            id: "task_42",
            key: "JEN-42",
            workspaceId: "ws_1",
          },
        };
      }
      if (input.name === "get_project") {
        if (options.projectError) throw options.projectError;
        if (input.arguments.projectId === "launch")
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: { code: "NOT_FOUND", message: "No project id" },
                }),
              },
            ],
          };
        return {
          structuredContent: {
            project: { id: "project_1", name: "Launch", workspaceId: "ws_1" },
          },
        };
      }
      if (input.name === "list_projects")
        return {
          structuredContent: {
            projects: options.projects ?? [
              { id: "project_1", name: "Launch", slug: "launch" },
            ],
          },
        };
      if (["add_project_link", "remove_project_link"].includes(input.name))
        return { structuredContent: { ok: true } };
      throw new Error(`unexpected call ${input.name}`);
    },
  };
  const unused = () => {
    throw new Error("unexpected host or identity operation");
  };
  const deps: SessionCommandDeps = {
    env: {},
    cwd: () => root,
    configPath: join(root, "config.json"),
    spoolRoot: root,
    resolveTarget: () => ({
      token: "tm_synthetic",
      url: "https://example.test/api/mcp",
    }),
    ensureInstallationId: unused,
    connect: async () => {
      connects++;
      return { caller, close: async () => {} };
    },
    git: async (args) => {
      const values: Record<string, string> = {
        "rev-parse --show-toplevel": root,
        "remote get-url origin": "git@github.com:example/repo.git",
        "symbolic-ref --short -q HEAD": "main",
        "rev-parse HEAD": "abc",
        "status --porcelain": "",
      };
      return { code: 0, stdout: values[args.join(" ")] ?? "" };
    },
    writeOut: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    isInteractive: false,
    readLine: async () => {
      unused();
      return "";
    },
    resolveSessionHost: unused,
    runSessionHost: async () => {
      unused();
      return 0;
    },
    spawnSessionHostDetached: unused,
  };
  if (options.bound)
    writeFolderBinding(root, {
      version: 1,
      endpoint: "https://example.test/api/mcp",
      workspaceId: "ws_1",
      workspaceSlug: "jentrix",
      repoOwnerName: "example/repo",
      alignedAt: "2026-09-08T00:00:00.000Z",
    });
  return {
    root,
    caller,
    deps,
    calls,
    out,
    err,
    connects: () => connects,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const args of [
  [],
  ["--help"],
  ["--resume", "session_old"],
  ["--project", "old-label"],
]) {
  test(`public Codex launch refuses before config, MCP, local plan, or host: ${args.join(" ")}`, async () => {
    const w = world();
    try {
      let code: number | undefined;
      w.deps.resolveTarget = () => {
        throw new Error("config must not be read");
      };
      w.deps.git = async () => {
        throw new Error("checkout must not be inspected");
      };
      const program = new Command();
      const session = registerSessionCommand(program, w.deps, (n) => {
        code = n;
      });
      assert.doesNotMatch(session.helpInformation(), /codex \[options\]/);
      await program.parseAsync(["session", "codex", ...args], { from: "user" });
      assert.equal(code, 2);
      assert.equal(w.connects(), 0);
      assert.deepEqual(w.calls, []);
      assert.deepEqual(readdirSync(w.root), []);
      assert.match(
        w.err.join("\n"),
        /CODEX_LAUNCH_UNAVAILABLE.*session connect --provider codex/,
      );
    } finally {
      w.clean();
    }
  });
}
test("old Codex launch plans remain refused by the host before any I/O", async () => {
  const w = world();
  try {
    assert.equal(
      await runSessionHost(
        {
          protocolVersion: 1,
          provider: "codex",
          mode: "launch",
          sessionId: "old",
          repoRoot: w.root,
          spoolRoot: w.root,
          jentrixBaseUrl: "https://example.test",
          mcpUrl: "https://example.test/api/mcp",
          installationId: "synthetic",
        },
        {
          fetchImpl: async () => {
            throw new Error("unexpected fetch");
          },
        },
      ),
      2,
    );
    assert.deepEqual(readdirSync(w.root), []);
  } finally {
    w.clean();
  }
});
for (const action of ["add", "remove"] as const)
  for (const task of ["JEN-42", "jen-42", "task_42"]) {
    test(`public task project ${action} resolves ${task} using the adopted get_task shape`, async () => {
      const w = world({ bound: task !== "task_42" });
      try {
        if (task === "task_42")
          w.deps.git = async () => {
            throw new Error("IDs do not require a repository");
          };
        let code: number | undefined;
        const program = new Command();
        registerTaskProjectCommand(program, w.deps, (n) => {
          code = n;
        });
        await program.parseAsync(
          ["task", "project", action, "--task", task, "--project", "launch"],
          { from: "user" },
        );
        assert.equal(code, 0, w.err.join("\n"));
        assert.deepEqual(
          w.calls[0].arguments,
          task === "task_42"
            ? { taskId: task, response_format: "concise" }
            : { workspaceId: "ws_1", number: 42, response_format: "concise" },
        );
        assert.deepEqual(w.calls.at(-1), {
          name: `${action}_project_link`,
          arguments: {
            projectId: "project_1",
            targetType: "TASK",
            targetId: "task_42",
          },
        });
      } finally {
        w.clean();
      }
    });
  }
test("human keys without a binding never search available workspaces or connect", async () => {
  const w = world();
  try {
    let code: number | undefined;
    const program = new Command();
    registerTaskProjectCommand(program, w.deps, (n) => {
      code = n;
    });
    await program.parseAsync(
      ["task", "project", "add", "--task", "JEN-42", "--project", "launch"],
      { from: "user" },
    );
    assert.equal(code, 2);
    assert.equal(w.connects(), 0);
    assert.deepEqual(w.calls, []);
    assert.match(w.err.join("\n"), /FOLDER_NOT_ALIGNED/);
    await assert.rejects(
      resolveTask(w.caller, "JEN-42"),
      /TASK_WORKSPACE_REQUIRED/,
    );
  } finally {
    w.clean();
  }
});
for (const task of [
  { id: "task_42", key: "OTHER-42", workspaceId: "ws_1" },
  { id: "task_42", key: "JEN-42", workspaceId: "ws_other" },
]) {
  test(`shared resolver rejects a foreign identity: ${JSON.stringify(task)}`, async () => {
    const w = world({ task });
    try {
      await assert.rejects(
        resolveTask(w.caller, "JEN-42", "ws_1"),
        /TASK_KEY_MISMATCH/,
      );
      await assert.rejects(
        resolveTaskId(w.caller, "JEN-42", "ws_1"),
        /TASK_KEY_MISMATCH/,
      );
      assert.ok(w.calls.every((c) => c.name === "get_task"));
    } finally {
      w.clean();
    }
  });
}
for (const error of [
  new ToolCallError("task missing", "NOT_FOUND"),
  new ToolCallError("not authorized", "FORBIDDEN"),
  new Error("HTTP 401"),
  new Error("network down"),
]) {
  test(`task lookup preserves failure ${error.message}`, async () => {
    const w = world({ taskError: error });
    try {
      await assert.rejects(
        resolveTask(w.caller, "JEN-42", "ws_1"),
        (e) => e === error,
      );
      assert.equal(w.calls.length, 1);
    } finally {
      w.clean();
    }
  });
}
for (const error of [
  new ToolCallError("forbidden", "FORBIDDEN"),
  new Error("HTTP 401"),
  new Error("network down"),
]) {
  test(`project lookup never masks ${error.message} as a missing slug`, async () => {
    const w = world({ projectError: error });
    try {
      let code: number | undefined;
      const program = new Command();
      registerTaskProjectCommand(program, w.deps, (n) => {
        code = n;
      });
      await program.parseAsync(
        [
          "task",
          "project",
          "remove",
          "--task",
          "task_42",
          "--project",
          "launch",
        ],
        { from: "user" },
      );
      assert.notEqual(code, 0);
      assert.deepEqual(
        w.calls.map((c) => c.name),
        ["get_task", "get_project"],
      );
      assert.ok(w.err.join("\n").includes(error.message));
    } finally {
      w.clean();
    }
  });
}

for (const invocation of [
  ["claude"],
  ["connect", "--provider", "codex"],
  ["attach", "--provider", "claude"],
  ["doctor"],
]) {
  test(`project-scoped session migration refuses before any state or server access: ${invocation.join(" ")}`, async () => {
    const w = world();
    try {
      let code: number | undefined;
      w.deps.resolveTarget = () => {
        throw new Error("must not read credentials");
      };
      const program = new Command();
      registerSessionCommand(program, w.deps, (n) => {
        code = n;
      });
      await program.parseAsync(
        ["session", ...invocation, "--project", "legacy"],
        { from: "user" },
      );
      assert.equal(code, 2);
      assert.equal(w.connects(), 0);
      assert.deepEqual(w.calls, []);
      assert.deepEqual(readdirSync(w.root), []);
      assert.match(w.err.join("\n"), /SESSION_PROJECT_REMOVED.*folder align/);
    } finally {
      w.clean();
    }
  });
}
for (const action of ["add", "remove"]) {
  test(`public project ${action} distinguishes a malformed lookup result from a missing slug`, async () => {
    const w = world({ projects: [{ unexpected: "malformed" }] });
    try {
      let code: number | undefined;
      const program = new Command();
      registerTaskProjectCommand(program, w.deps, (n) => {
        code = n;
      });
      await program.parseAsync(
        ["task", "project", action, "--task", "task_42", "--project", "launch"],
        { from: "user" },
      );
      assert.equal(code, 1);
      assert.match(w.err.join("\n"), /invalid project list/);
      assert.equal(w.calls.at(-1)?.name, "list_projects");
    } finally {
      w.clean();
    }
  });
  test(`public project ${action} keeps NOT_FOUND and never links a missing task`, async () => {
    const w = world({
      bound: true,
      taskError: new ToolCallError("missing task", "NOT_FOUND"),
    });
    try {
      let code: number | undefined;
      const program = new Command();
      registerTaskProjectCommand(program, w.deps, (n) => {
        code = n;
      });
      await program.parseAsync(
        ["task", "project", action, "--task", "JEN-42", "--project", "launch"],
        { from: "user" },
      );
      assert.equal(code, 4);
      assert.deepEqual(
        w.calls.map((c) => c.name),
        ["get_task"],
      );
    } finally {
      w.clean();
    }
  });
  test(`public project ${action} reports an absent slug without a mutation`, async () => {
    const w = world({ projects: [] });
    try {
      let code: number | undefined;
      const program = new Command();
      registerTaskProjectCommand(program, w.deps, (n) => {
        code = n;
      });
      await program.parseAsync(
        ["task", "project", action, "--task", "task_42", "--project", "launch"],
        { from: "user" },
      );
      assert.equal(code, 4);
      assert.deepEqual(
        w.calls.map((c) => c.name),
        ["get_task", "get_project", "list_projects"],
      );
    } finally {
      w.clean();
    }
  });
}

test("structured call errors retain retry metadata, hints and stale entity output", async () => {
  const envelope = {
    error: {
      code: "CONFLICT",
      message: "stale entity",
      hint: "merge the current row",
      current: { id: "task_42", updatedAt: "synthetic" },
    },
  };
  const result = {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
  assert.throws(
    () => structuredToolResult(result),
    (error: unknown) => {
      assert.ok(error instanceof ToolCallError);
      assert.deepEqual(error.envelope, envelope);
      assert.equal(error.exitCode, 5);
      return true;
    },
  );
  const w = world({
    taskError: new ToolCallError(
      envelope.error.message,
      "CONFLICT",
      envelope as never,
    ),
  });
  try {
    let code: number | undefined;
    const program = new Command();
    registerTaskProjectCommand(program, w.deps, (n) => {
      code = n;
    });
    await program.parseAsync(
      ["task", "project", "add", "--task", "task_42", "--project", "launch"],
      { from: "user" },
    );
    assert.equal(code, 5);
    assert.deepEqual(JSON.parse(w.out.join("")), envelope.error.current);
    assert.match(w.err.join("\n"), /merge the current row/);
    const rateLimited = {
      error: { code: "RATE_LIMITED", message: "wait", retryAfterSeconds: 75 },
    };
    await assert.rejects(
      callStructured(
        {
          callTool: async () => ({
            isError: true,
            content: [{ type: "text", text: JSON.stringify(rateLimited) }],
          }),
        },
        "get_task",
        { taskId: "task_42" },
      ),
      (error: unknown) =>
        error instanceof ToolCallError &&
        error.envelope?.error.retryAfterSeconds === 75 &&
        error.exitCode === 6,
    );
  } finally {
    w.clean();
  }
});

for (const name of ["", "connect", "align"]) {
  test(`session ${name} help matches the generated supported-command golden`, () => {
    const program = new Command().name("jentrix");
    const session = registerSessionCommand(
      program,
      {} as SessionCommandDeps,
      () => {
        throw new Error("help must not execute a command");
      },
    );
    const selected = name
      ? session.commands.find((c) => c.name() === name)!
      : session;
    assert.equal(
      selected.helpInformation(),
      readFileSync(
        new URL(
          `./golden/help-session${name ? `-${name}` : ""}.txt`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  });
}
