import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTaskContext } from "../src/commands/task-context";
import { EXIT_CODES } from "../src/errors";
import type { SessionCommandDeps } from "../src/session/deps";
import type { SessionToolCaller } from "../src/tool-client";

// Semantic recall (cli 0.10.0, AC5.3): `task context` reads
// `find_related_artifacts` by task in the same round as the card's own
// artifacts and comments, prints the block after the card's own artifacts,
// and says "no related evidence" on a fresh card. A failed read is NAMED,
// never rendered as "none".

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

function deps(
  caller: SessionToolCaller,
): SessionCommandDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    env: {},
    cwd: () => "/work/api",
    configPath: "/tmp/config.json",
    resolveTarget: () => ({
      token: "tm_x",
      url: "https://stacks.example/api/mcp",
      tokenSource: "file",
    }),
    ensureInstallationId: () => "install-uuid-1",
    connect: async () => ({ caller, close: async () => undefined }),
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    isInteractive: false,
    readLine: async () => "y",
    resolveSessionHost: () => "/tools/session-host-main.js",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => 4242,
    spoolRoot: mkdtempSync(join(tmpdir(), "jspool-")),
  };
}

const TASK = {
  id: "task_42",
  key: "ACM-42",
  workspaceId: "ws_1",
  title: "Trim the export archive",
  boardName: "Work",
  columnName: "In progress",
  priority: "MEDIUM",
  description: "Build the export zip with node:zlib alone.",
  labels: [],
  subtasks: [],
  links: { incoming: [], outgoing: [] },
};

const HIT = {
  id: "art_7",
  title: "Learning: zip export needs no archiver",
  type: "LEARNING",
  createdAt: "2026-09-10T10:00:00.000Z",
  taskId: "task_3",
  taskKey: "ACM-11",
  sessionId: "ses_0",
  similarity: 0.8412,
  snippet:
    "Building the export zip with node:zlib alone keeps the archive under the body cap.",
  truncated: false,
};

test("task context reads find_related_artifacts by task in the same round and prints the block after the card's own artifacts", async () => {
  const caller = fakeCaller({
    get_task: () => TASK,
    list_artifacts: () => ({
      artifacts: [{ id: "art_1", type: "PLAN", title: "Plan for the trim" }],
      totalCount: 1,
      nextCursor: null,
    }),
    list_comments: () => ({ comments: [] }),
    find_related_artifacts: (args) => {
      assert.deepEqual(args, { taskId: "task_42" });
      return { artifacts: [HIT] };
    },
  });
  const d = deps(caller);
  assert.equal(await runTaskContext({ task: "task_42" }, d), EXIT_CODES.OK);
  const out = d.out.join("\n");
  const own = out.indexOf("artifacts (latest per type, 1):");
  const related = out.indexOf("Related evidence (1):");
  assert.ok(own >= 0 && related > own, out);
  assert.match(
    out,
    /LEARNING {7}art_7 {2}Learning: zip export needs no archiver {2}· {2}84% {2}· {2}on ACM-11/,
  );
  assert.match(out, /^ {4}Building the export zip with node:zlib alone/m);
  // One round: the three side reads were issued together after get_task.
  assert.deepEqual(
    caller.calls.map((c) => c.name),
    ["get_task", "list_artifacts", "list_comments", "find_related_artifacts"],
  );

  const jd = deps(caller);
  assert.equal(
    await runTaskContext({ task: "task_42", json: true }, jd),
    EXIT_CODES.OK,
  );
  const bundle = JSON.parse(jd.out.join("\n")) as Record<string, unknown>;
  assert.deepEqual(bundle.related, [HIT]);
});

test("a fresh card says 'no related evidence' in its one line; the notice rides beside an empty block", async () => {
  const fresh = fakeCaller({
    get_task: () => TASK,
    list_artifacts: () => ({ artifacts: [], totalCount: 0, nextCursor: null }),
    list_comments: () => ({ comments: [] }),
    find_related_artifacts: () => ({
      artifacts: [],
      notice: "This task has no embedding yet — retry shortly.",
    }),
  });
  const d = deps(fresh);
  assert.equal(await runTaskContext({ task: "task_42" }, d), EXIT_CODES.OK);
  assert.match(
    d.out.join("\n"),
    /no links · no artifacts · no comments · no related evidence$/,
  );
  const jd = deps(fresh);
  await runTaskContext({ task: "task_42", json: true }, jd);
  const bundle = JSON.parse(jd.out.join("\n")) as Record<string, unknown>;
  assert.deepEqual(bundle.related, []);
  assert.equal(
    bundle.relatedNotice,
    "This task has no embedding yet — retry shortly.",
  );

  // With the card's own artifacts present, the empty block prints its reason.
  const withOwn = fakeCaller({
    get_task: () => TASK,
    list_artifacts: () => ({
      artifacts: [{ id: "art_1", type: "PLAN", title: "Plan" }],
      totalCount: 1,
      nextCursor: null,
    }),
    list_comments: () => ({ comments: [] }),
    find_related_artifacts: () => ({
      artifacts: [],
      notice:
        "Semantic search is not configured (no embeddings provider key) — use search_artifacts for keyword search.",
    }),
  });
  const od = deps(withOwn);
  await runTaskContext({ task: "task_42" }, od);
  assert.match(
    od.out.join("\n"),
    /Related evidence: none — Semantic search is not configured/,
  );
});

test("a failed related read is named under 'not read', never rendered as none (older server)", async () => {
  const caller = fakeCaller({
    get_task: () => TASK,
    list_artifacts: () => ({ artifacts: [], totalCount: 0, nextCursor: null }),
    list_comments: () => ({ comments: [] }),
    find_related_artifacts: () => {
      throw new Error("Tool find_related_artifacts not found");
    },
  });
  const d = deps(caller);
  assert.equal(await runTaskContext({ task: "task_42" }, d), EXIT_CODES.OK);
  const out = d.out.join("\n");
  assert.doesNotMatch(out, /no related evidence/);
  assert.doesNotMatch(out, /Related evidence:/);
  assert.match(
    out,
    /not read: find_related_artifacts: Tool find_related_artifacts not found/,
  );
  const jd = deps(caller);
  await runTaskContext({ task: "task_42", json: true }, jd);
  const bundle = JSON.parse(jd.out.join("\n")) as Record<string, unknown>;
  assert.equal(bundle.related, null);
});
