/**
 * Client-runtime v2 §11 — folder alignment: the non-secret binding file, its
 * ignore precondition, the fail-closed drift codes, the folder commands, and
 * the narrow `session align` (level 2) riding the binding — including the D6
 * widened flush at the unaligned→first-task boundary, end to end.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertBindingCurrent,
  BindingError,
  bindingPathOf,
  clearFolderBinding,
  readFolderBinding,
  requireFolderBinding,
  writeFolderBinding,
  type FolderBinding,
} from "../src/binding";
import {
  runFolderAlign,
  runFolderClear,
  runFolderStatus,
} from "../src/commands/folder";
import { runSessionAlign } from "../src/session/alignment";
import { runSessionStatus } from "../src/session/status";
import { writeAlignmentMarker } from "../src/session/state";
import { ToolCallError } from "../src/tool-client";
import { runTaskProject } from "../src/commands/task-project";
import type { SessionCommandDeps } from "../src/session/deps";
import type { SessionToolCaller } from "../src/tool-client";

const BINDING: FolderBinding = {
  version: 1,
  endpoint: "https://stacks.example/api/mcp",
  workspaceId: "ws_1",
  workspaceSlug: "acme",
  repoOwnerName: "acme/api",
  alignedAt: "2026-08-29T00:00:00.000Z",
};

function root(): string {
  return mkdtempSync(join(tmpdir(), "jfolder-"));
}

function fakeCaller(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): SessionToolCaller & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return { structuredContent: handler(args) };
    },
  };
}

function gitAt(dir: string) {
  return async (args: string[]) => {
    const table: Record<string, { code: number; stdout: string }> = {
      "rev-parse --show-toplevel": { code: 0, stdout: `${dir}\n` },
      "remote get-url origin": {
        code: 0,
        stdout: "git@github.com:acme/api.git\n",
      },
      "symbolic-ref --short -q HEAD": { code: 0, stdout: "main\n" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
      "status --porcelain": { code: 0, stdout: "" },
    };
    return table[args.join(" ")] ?? { code: 1, stdout: "" };
  };
}

function deps(
  caller: SessionToolCaller,
  dir: string,
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    env: {},
    cwd: () => dir,
    configPath: "/tmp/config.json",
    resolveTarget: () => ({
      token: "tm_x",
      url: "https://stacks.example/api/mcp",
      tokenSource: "file",
    }),
    ensureInstallationId: () => "install-uuid-1",
    connect: async () => ({ caller, close: async () => undefined }),
    git: gitAt(dir),
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    isInteractive: false,
    readLine: async () => "y",
    resolveSessionHost: () => "/tools/session-host-main.js",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => 4242,
    spoolRoot: mkdtempSync(join(tmpdir(), "jspool-")),
    ...overrides,
  };
}

// --- binding file contract (§11.2) -----------------------------------------

test("write → read round-trips; unknown future fields are ignored", () => {
  const dir = root();
  writeFolderBinding(dir, BINDING);
  const raw = JSON.parse(readFileSync(bindingPathOf(dir), "utf8")) as Record<
    string,
    unknown
  >;
  raw.futureField = "ignored";
  writeFileSync(bindingPathOf(dir), JSON.stringify(raw));
  assert.deepEqual(readFolderBinding(dir), BINDING);
});

test("no token, no Project, no task ever lands in the binding", () => {
  const dir = root();
  writeFolderBinding(dir, BINDING);
  const bytes = readFileSync(bindingPathOf(dir), "utf8");
  assert.doesNotMatch(bytes, /token|bearer|projectId|taskId|Authorization/i);
});

test("an unknown MAJOR version refuses with a re-align instruction", () => {
  const dir = root();
  writeFolderBinding(dir, BINDING);
  writeFileSync(bindingPathOf(dir), JSON.stringify({ ...BINDING, version: 9 }));
  assert.throws(
    () => readFolderBinding(dir),
    /FOLDER_BINDING_VERSION.*folder align/s,
  );
});

test("§11.1: an operator's own ignore file that does not cover binding.json REFUSES with the exact entry", () => {
  const dir = root();
  mkdirSync(join(dir, ".stacks"), { recursive: true });
  writeFileSync(join(dir, ".stacks", ".gitignore"), "config.json\n");
  assert.throws(
    () => writeFolderBinding(dir, BINDING),
    (error: unknown) => {
      assert.ok(error instanceof BindingError);
      assert.match(error.message, /FOLDER_BINDING_NOT_IGNORED/);
      assert.match(error.message, /"binding\.json"/);
      return true;
    },
  );
  // Adding the exact named entry unblocks the write.
  writeFileSync(
    join(dir, ".stacks", ".gitignore"),
    "config.json\nbinding.json\n",
  );
  writeFolderBinding(dir, BINDING);
  assert.ok(existsSync(bindingPathOf(dir)));
});

test("§11.4 drift codes fail closed: FOLDER_ENDPOINT_MISMATCH and FOLDER_REPO_CHANGED", () => {
  assert.throws(
    () =>
      assertBindingCurrent(BINDING, {
        endpoint: "https://other.example/api/mcp",
        repoOwnerName: "acme/api",
      }),
    /FOLDER_ENDPOINT_MISMATCH/,
  );
  assert.throws(
    () =>
      assertBindingCurrent(BINDING, {
        endpoint: BINDING.endpoint,
        repoOwnerName: "acme/renamed",
      }),
    /FOLDER_REPO_CHANGED/,
  );
  // Same endpoint (trailing slash / case tolerated) + same repo: current.
  assertBindingCurrent(BINDING, {
    endpoint: "https://stacks.example/api/mcp/",
    repoOwnerName: "acme/api",
  });
});

test("requireFolderBinding names FOLDER_NOT_ALIGNED when absent", () => {
  assert.throws(
    () =>
      requireFolderBinding(root(), {
        endpoint: BINDING.endpoint,
        repoOwnerName: "acme/api",
      }),
    /FOLDER_NOT_ALIGNED.*jentrix folder align/s,
  );
});

// --- folder commands (§15.2) ------------------------------------------------

test("folder align lists workspaces, writes the binding, and prints the next step", async () => {
  const dir = root();
  const caller = fakeCaller({
    list_workspaces: () => ({
      workspaces: [
        { id: "ws_1", name: "Acme", slug: "acme" },
        { id: "ws_2", name: "Beta", slug: "beta" },
      ],
    }),
  });
  const d = deps(caller, dir);
  const code = await runFolderAlign({ workspace: "acme", json: true }, d);
  assert.equal(code, 0);
  const binding = readFolderBinding(dir);
  assert.equal(binding?.workspaceId, "ws_1");
  assert.equal(binding?.workspaceSlug, "acme");
  assert.equal(binding?.repoOwnerName, "acme/api");
});

test("folder status reports drift independently; clear removes ONLY the binding", async () => {
  const dir = root();
  writeFolderBinding(dir, { ...BINDING, repoOwnerName: "acme/old" });
  const d = deps(fakeCaller({}), dir);
  assert.equal(await runFolderStatus({}, d), 0);
  assert.match(d.out.join("\n"), /FOLDER_REPO_CHANGED/);

  // A sibling file in .stacks survives clear (D14).
  writeFileSync(join(dir, ".stacks", "config.json"), "{}");
  const d2 = deps(fakeCaller({}), dir, { isInteractive: false });
  assert.equal(await runFolderClear({ yes: true }, d2), 0);
  assert.equal(readFolderBinding(dir), null);
  assert.ok(existsSync(join(dir, ".stacks", "config.json")));
});

// --- session align (level 2, §15.3) — the D6 widen end to end ---------------

function alignWorld(dir: string, spool: string) {
  const aligns: Array<Record<string, unknown>> = [];
  const caller = fakeCaller({
    attach_agent_session: (args) => {
      assert.equal(args.workspaceId, "ws_1"); // v2 shape from the binding
      return {
        id: "ses_al",
        workspaceId: "ws_1",
        projectId: null,
        status: "ACTIVE",
        converged: true,
      };
    },
    get_agent_session: () => ({
      id: "ses_al",
      taskId: null, // UNALIGNED — the defect boundary
      updatedAt: "2026-08-29T01:00:00.000Z",
    }),
    get_task: (args) => {
      assert.equal(args.workspaceId, "ws_1");
      assert.equal(args.number, 42);
      return { id: "task_42", key: "ACM-42", workspaceId: "ws_1" };
    },
    align_agent_session: (args) => {
      aligns.push(args);
      return {
        alignment: {
          version: 2,
          alignedAt: "2026-08-29T01:00:01.000Z",
          workspace: { id: "ws_1", name: "Acme", slug: "acme" },
          task: { id: "task_42", key: "ACM-42", title: "Fix it" },
          owner: { id: "u1", name: null, email: "op@example.com" },
          agent: { provider: "claude" },
          repo: { ownerName: "acme/api", branch: "main" },
          capture: "off",
          skeleton: "on",
        },
        realigned: false,
        captureSources: { capture: "(built-in)", skeleton: "(built-in)" },
      };
    },
  });
  return { caller, aligns };
}

test("session align: the unaligned→first-task boundary FLUSHES (D6 — the wizard never did)", async () => {
  const dir = root();
  writeFolderBinding(dir, BINDING);
  const spool = mkdtempSync(join(tmpdir(), "jspool-"));
  // A LIVE host owns the session dir.
  mkdirSync(join(spool, "ses_al"), { recursive: true });
  writeFileSync(
    join(spool, "ses_al", "host.json"),
    JSON.stringify({
      pid: 4242,
      startedAt: "2026-08-29T00:59:00.000Z",
      provider: "claude",
      mode: "watch",
    }),
  );
  const { caller, aligns } = alignWorld(dir, spool);
  const flushPath = join(spool, "ses_al", "flush-request.json");
  const d = deps(caller, dir, {
    spoolRoot: spool,
    isPidAlive: () => true,
    sleep: async () => {
      // The "host": ack the flush by deleting the marker.
      if (existsSync(flushPath)) {
        const body = JSON.parse(readFileSync(flushPath, "utf8")) as Record<
          string,
          unknown
        >;
        assert.match(String(body.requestedAt), /T/);
        const { unlinkSync } = await import("node:fs");
        unlinkSync(flushPath);
      }
    },
  });
  const code = await runSessionAlign(
    {
      task: "ACM-42",
      provider: "claude",
      providerSession: "cc-align-1",
      transcriptPath: "/t/align.jsonl",
      json: true,
    },
    d,
  );
  assert.equal(code, 0);
  // JEN-457 follow-up: `--json` means stdout is a DOCUMENT, not a document with
  // prose above it. The flush disclosure used to print here unconditionally, so
  // `jq` and `JSON.parse` both died on the first line — and this assertion used
  // to read `d.out.at(-1)`, which is exactly how the defect stayed invisible to
  // its own test. Every line on stdout must parse.
  assert.equal(
    d.out.length,
    1,
    `--json wrote ${d.out.length} lines to stdout: ${JSON.stringify(d.out)}`,
  );
  const payload = JSON.parse(d.out[0]!) as Record<string, unknown>;
  // The fact the withheld sentence carried is still here, machine-readable.
  assert.equal(payload.boundary, "FLUSHED", "null→task flushed (the D6 widen)");
  assert.equal(aligns.length, 1);
  assert.equal(aligns[0]!.taskId, "task_42");
  assert.equal(
    (payload.alignment as { version?: number }).version,
    2,
    "the server snapshot is echoed verbatim",
  );
});

test("session align: a session ALREADY on the task reports NOT_REQUIRED — settings updates never flush", async () => {
  const dir = root();
  writeFolderBinding(dir, BINDING);
  const spool = mkdtempSync(join(tmpdir(), "jspool-"));
  mkdirSync(join(spool, "ses_al"), { recursive: true });
  writeFileSync(
    join(spool, "ses_al", "host.json"),
    JSON.stringify({
      pid: 4242,
      startedAt: "2026-08-29T00:59:00.000Z",
      provider: "claude",
      mode: "watch",
    }),
  );
  const { caller } = alignWorld(dir, spool);
  // The session is ALREADY aligned to task_42.
  const callerSame = fakeCaller({
    attach_agent_session: () => ({
      id: "ses_al",
      workspaceId: "ws_1",
      projectId: null,
      status: "ACTIVE",
      converged: true,
    }),
    get_agent_session: () => ({
      id: "ses_al",
      taskId: "task_42",
      updatedAt: "2026-08-29T01:00:00.000Z",
    }),
    get_task: () => ({ id: "task_42", key: "ACM-42", workspaceId: "ws_1" }),
    align_agent_session: () => ({
      alignment: {
        version: 2,
        alignedAt: "x",
        workspace: { id: "ws_1", name: "Acme", slug: "acme" },
        task: { id: "task_42", key: "ACM-42", title: "Fix it" },
        owner: { id: "u1", name: null, email: "op@example.com" },
        agent: { provider: "claude" },
        repo: { ownerName: "acme/api", branch: "main" },
        capture: "off",
        skeleton: "on",
      },
      realigned: true,
      captureSources: null,
    }),
  });
  const d = deps(callerSame, dir, {
    spoolRoot: spool,
    isPidAlive: () => true,
    sleep: async () => {
      assert.fail("no flush cycle may run on a same-task settings update");
    },
  });
  const code = await runSessionAlign(
    {
      task: "ACM-42",
      provider: "claude",
      providerSession: "cc-align-2",
      transcriptPath: "/t/align.jsonl",
      json: true,
    },
    d,
  );
  assert.equal(code, 0);
  const payload = JSON.parse(d.out.at(-1)!) as Record<string, unknown>;
  assert.equal(payload.boundary, "NOT_REQUIRED");
});

test("session align without --task/--session-level refuses — alignment anchors work, it never invents it", async () => {
  const d = deps(fakeCaller({}), root());
  const code = await runSessionAlign({}, d);
  assert.notEqual(code, 0);
  assert.match(d.err.join("\n"), /--task <id-or-key> or --session-level/);
});

// --- JEN-301: align says when NOTHING is recording, and names its source ----

test("session align with no transcript: BOUND BUT NOT RECORDING + telemetry source, not a bare 'Aligned'", async () => {
  const dir = root();
  writeFolderBinding(dir, BINDING);
  const home = mkdtempSync(join(tmpdir(), "jhome-")); // no hook ledger here
  const { caller } = alignWorld(dir, "");
  const spawned: string[] = [];
  const d = deps(caller, dir, {
    env: { HOME: home },
    spawnSessionHostDetached: (_runner, planPath) => {
      spawned.push(planPath);
      return 4242;
    },
  });
  const code = await runSessionAlign(
    // An explicit provider id whose hook record names no transcript — the
    // shape of a shell align, or of plugin hooks that never fired.
    { task: "ACM-42", provider: "claude", providerSession: "cc-no-transcript" },
    d,
  );
  assert.equal(code, 0);
  assert.equal(spawned.length, 0, "no transcript → no host");
  assert.match(d.out.join("\n"), /Aligned session ses_al → ACM-42 Fix it/);
  assert.match(
    d.err.join("\n"),
    /SESSION BOUND BUT NOT RECORDING: session ses_al/,
    "align used to print only 'Aligned …' over a session nothing observes",
  );
  assert.match(
    d.out.join("\n"),
    /Telemetry source: unavailable — no transcript is bound/,
  );

  // With a transcript the host starts, no warning, and the source is named
  // — the same fact `session status` and `session doctor` print (C2.4).
  const d2 = deps(caller, dir, {
    env: { HOME: home },
    spawnSessionHostDetached: (_runner, planPath) => {
      spawned.push(planPath);
      return 4243;
    },
  });
  assert.equal(
    await runSessionAlign(
      {
        task: "ACM-42",
        provider: "claude",
        providerSession: "cc-with-transcript",
        transcriptPath: "/t/align.jsonl",
        json: true,
      },
      d2,
    ),
    0,
  );
  assert.equal(spawned.length, 1);
  assert.doesNotMatch(d2.err.join("\n"), /NOT RECORDING/);
  assert.equal(
    d2.out.length,
    1,
    "starting a host must not prepend prose to JSON",
  );
  const payload = JSON.parse(d2.out.join("\n")) as {
    telemetrySource?: { source?: string };
  };
  assert.equal(payload.telemetrySource?.source, "rollout-fallback");
  // …and the plan carries the ledger the host filters (JEN-295).
  const plan = JSON.parse(readFileSync(spawned[0]!, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(
    plan.hookDir,
    join(home, ".config", "stacks", "claude-sessions"),
  );
});

// --- JEN-296: bare `session status` answers "what is THIS session aligned to?"

test("session status with no id resolves this provider session's alignment and prints the Aligned line", async () => {
  const dir = root();
  const configPath = join(mkdtempSync(join(tmpdir(), "jcfg-")), "config.json");
  writeAlignmentMarker(
    configPath,
    dir,
    {
      sessionId: "ses_mine",
      workspaceId: "ws_1",
      taskId: "task_42",
      capture: "off",
      alignedAt: "2026-09-02T00:00:00.000Z",
    },
    "cc-status-1",
  );
  const detail = {
    id: "ses_mine",
    provider: "claude",
    status: "ACTIVE",
    workspaceId: "ws_1",
    projectId: null,
    projectName: null,
    repoOwnerName: "acme/api",
    captureComplete: false,
    captureError: null,
    summaryArtifactId: null,
    alignment: {
      version: 2,
      alignedAt: "2026-09-02T00:00:00.000Z",
      workspace: { id: "ws_1", name: "Acme", slug: "acme" },
      task: { id: "task_42", key: "ACM-42", title: "Fix it" },
      owner: { id: "u1", name: "Op", email: "op@example.com" },
      agent: { provider: "claude", label: "triage-bot" },
      repo: { ownerName: "acme/api", branch: "main" },
      capture: "off",
      skeleton: "on",
    },
  };
  const caller = fakeCaller({
    get_agent_session: (args) => {
      assert.equal(args.sessionId, "ses_mine");
      return detail;
    },
    get_task: (args) => {
      assert.equal(args.taskId, "task_42");
      return {
        id: "task_42",
        key: "ACM-42",
        boardId: "board_1",
        boardName: "Sprint",
        columnName: "In progress",
      };
    },
    list_workspaces: () => {
      assert.fail("an aligned session must not fall back to the listing");
    },
  });
  // The trusted provider identity: Claude Code stamps it on the process.
  const d = deps(caller, dir, {
    configPath,
    env: { CLAUDE_CODE_SESSION_ID: "cc-status-1", HOME: "/nowhere" },
  });
  assert.equal(await runSessionStatus(undefined, {}, d), 0);
  const text = d.out.join("\n");
  assert.match(text, /^Session ses_mine · claude · ACTIVE/m);
  assert.match(
    text,
    /^Aligned: ACM-42 Fix it · board Sprint \(board_1\) · column In progress · owner Op · agent triage-bot$/m,
    text,
  );

  // A DIFFERENT provider session in the same checkout has no alignment of
  // its own — it gets the listing, never its neighbour's detail.
  const listing = fakeCaller({
    list_workspaces: () => ({
      workspaces: [{ id: "ws_1", slug: "acme" }],
    }),
    list_agent_sessions: () => ({
      sessions: [
        {
          id: "ses_mine",
          provider: "claude",
          projectName: null,
          status: "ACTIVE",
          captureComplete: false,
        },
      ],
    }),
  });
  const d2 = deps(listing, dir, {
    configPath,
    env: { CLAUDE_CODE_SESSION_ID: "cc-other", HOME: "/nowhere" },
  });
  assert.equal(await runSessionStatus(undefined, {}, d2), 0);
  // …and a v2 row names its workspace instead of printing `null`.
  assert.match(
    d2.out.join("\n"),
    /ses_mine · claude · workspace acme · ACTIVE/,
  );

  // An unaligned session's detail says so, in the same slot.
  const bare = fakeCaller({
    get_agent_session: () => ({ ...detail, alignment: null }),
  });
  const d3 = deps(bare, dir, { configPath });
  assert.equal(await runSessionStatus("ses_mine", {}, d3), 0);
  assert.match(d3.out.join("\n"), /^Aligned: — \(not aligned/m);
});

// --- task project labels (§15.4) --------------------------------------------

test("task project add resolves an ID + slug and links idempotently without folder binding", async () => {
  const linked: Array<Record<string, unknown>> = [];
  const caller = fakeCaller({
    get_task: (args) => {
      assert.equal(args.taskId, "task_9");
      return { id: "task_9", key: "ACM-9", workspaceId: "ws_1" };
    },
    get_project: () => {
      throw new ToolCallError("not an id", "NOT_FOUND");
    },
    list_projects: () => ({
      projects: [{ id: "prj_l", name: "Launch", slug: "launch" }],
    }),
    add_project_link: (args) => {
      linked.push(args);
      return { ok: true };
    },
  });
  const d = deps(caller, root());
  const code = await runTaskProject(
    "add",
    { task: "task_9", project: "launch" },
    d,
  );
  assert.equal(code, 0);
  assert.deepEqual(linked, [
    { projectId: "prj_l", targetType: "TASK", targetId: "task_9" },
  ]);
  assert.doesNotMatch(d.out.join("\n"), /governed-worker/);
});
