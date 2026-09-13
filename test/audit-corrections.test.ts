/**
 * JEN-535 (S2a) — unit checks for the audit corrections R01–R08 that the
 * conformance suite (test/plugin-sync-conformance.test.ts) does not already
 * pin end-to-end: the CLI flags (`push report --final`, `--checkpoint`), the
 * hook-side checkpoint REQUEST, `session end --preserve-uncommitted`, the
 * receipt's gate classification, the bounded opening prompt and the doctor's
 * installed-vs-loaded revision check.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVerificationReceipt,
  classifyGateCommand,
  packageScriptResolver,
  runPush,
  type PushDeps,
} from "../src/commands/push";
import {
  CHECKPOINT_BOUNDARIES,
  checkpointRequestPath,
  readCheckpointRequest,
  writeCheckpointRequest,
} from "../src/session/checkpoint";
import { runSessionSnapshot } from "../src/commands/snapshot";
import { behaviourRevisionCheck } from "../src/commands/doctor-client";
import { boundedOpeningPrompt, MAX_OPENING_PROMPT_BYTES } from "../src/session-host/session-host";
import { parseSemanticHeader, headerString } from "../src/session-host/semantic-header";
import { buildUncommittedPatchBody, runSessionEnd } from "../src/session/end";
import { writeAlignmentMarker } from "../src/session/state";
import type { SessionCommandDeps } from "../src/session/deps";
import type { SessionToolCaller } from "../src/tool-client";

function pushDeps(overrides: Partial<PushDeps> = {}): PushDeps & {
  out: string[];
  err: string[];
  bodies: Array<{ kind: string; title: string; body: string }>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const bodies: Array<{ kind: string; title: string; body: string }> = [];
  const dir = mkdtempSync(join(tmpdir(), "jentrix-r0x-"));
  const base: PushDeps = {
    env: { CODEX_THREAD_ID: "thread-1" },
    cwd: () => dir,
    configPath: join(dir, "config.json"),
    resolveTarget: () => ({ token: "tm_test_token_abcdefghijklmnop", url: "http://localhost:3000/api/mcp" }),
    ensureInstallationId: () => "install-1",
    connect: async () => {
      throw new Error("no MCP");
    },
    git: async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${dir}\n` };
      if (args[0] === "remote") return { code: 0, stdout: "git@github.com:acme/app.git\n" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n" };
      return { code: 0, stdout: "" };
    },
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    isInteractive: false,
    readLine: async () => "",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => -1,
    spoolRoot: join(dir, "spool"),
    resolveSessionHost: () => null,
    readStdin: async () => "the body",
    fetchImpl: (async (_url: URL | string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { kind: string; title: string; body: string });
      return new Response(JSON.stringify({ artifactId: "art_9", type: "REPORT", deduped: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
    ...overrides,
  };
  return Object.assign(base, { out, err, bodies });
}

function align(d: PushDeps, sessionId = "ses_r"): void {
  writeAlignmentMarker(
    d.configPath,
    d.cwd(),
    { sessionId, workspaceId: "ws", projectId: "proj_1", taskId: "task_1", capture: "off", alignedAt: new Date().toISOString() },
    "thread-1",
  );
}

describe("R01 — jentrix push report --final", () => {
  it("writes a final-output header with state: final and says so", async () => {
    const d = pushDeps();
    align(d);
    assert.equal(await runPush("report", undefined, { title: "Final", final: true }, d), 0);
    const header = parseSemanticHeader(d.bodies[0]!.body);
    assert.equal(headerString(header, "kind"), "final-output");
    assert.equal(headerString(header, "state"), "final");
    assert.equal(headerString(header, "producer"), "agent");
    assert.equal(headerString(header, "sessionId"), "ses_r");
    assert.match(d.out.join("\n"), /explicit FINAL output/);
  });

  it("refuses --final on any kind but report", async () => {
    const d = pushDeps();
    align(d);
    assert.notEqual(await runPush("learning", undefined, { final: true }, d), 0);
    assert.match(d.err.join("\n"), /--final/);
    assert.equal(d.bodies.length, 0);
  });
});

describe("R02 — semantic checkpoints", () => {
  it("--checkpoint <boundary> writes the checkpoint header and clears the hook's request", async () => {
    const d = pushDeps();
    align(d);
    writeCheckpointRequest(d.spoolRoot, "ses_r", { boundary: "compaction", requestedAt: "2026-09-12T00:00:00.000Z", reason: "compacted" });
    assert.ok(existsSync(checkpointRequestPath(d.spoolRoot, "ses_r")));
    const code = await runPush(
      "report",
      undefined,
      { title: "Checkpoint — x", checkpoint: "compaction", intent: "ship S2a", next: "run gates" },
      d,
    );
    assert.equal(code, 0);
    const header = parseSemanticHeader(d.bodies[0]!.body);
    assert.equal(headerString(header, "kind"), "checkpoint");
    assert.equal(headerString(header, "boundary"), "compaction");
    assert.equal(headerString(header, "currentIntent"), "ship S2a");
    assert.equal(headerString(header, "nextAction"), "run gates");
    assert.equal(existsSync(checkpointRequestPath(d.spoolRoot, "ses_r")), false, "the request is answered");
    const ledger = JSON.parse(readFileSync(join(d.spoolRoot, "ses_r", "checkpoint.json"), "utf8")) as { artifactId: string };
    assert.equal(ledger.artifactId, "art_9");
  });

  it("refuses an unknown boundary, --intent without --checkpoint, and --final with --checkpoint", async () => {
    const d = pushDeps();
    align(d);
    assert.notEqual(await runPush("report", undefined, { checkpoint: "whenever" }, d), 0);
    assert.match(d.err.at(-1)!, new RegExp(CHECKPOINT_BOUNDARIES.join(" \\| ").replaceAll("|", "\\|")));
    assert.notEqual(await runPush("report", undefined, { intent: "x" }, d), 0);
    assert.notEqual(await runPush("report", undefined, { checkpoint: "manual", final: true }, d), 0);
    assert.notEqual(await runPush("gap", undefined, { checkpoint: "manual" }, d), 0);
    assert.equal(d.bodies.length, 0);
  });

  it("a PreCompact hook REQUESTS a checkpoint (never manufactures one) and repeats the request until answered", async () => {
    const spool = mkdtempSync(join(tmpdir(), "jentrix-r02-"));
    mkdirSync(join(spool, "ses_c"), { recursive: true });
    const transcript = join(spool, "t.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", sessionId: "p1" })}\n`);
    writeFileSync(
      join(spool, "ses_c", "host.json"),
      JSON.stringify({ pid: process.pid, provider: "claude", mode: "watch", captureTrace: false, transcriptPath: transcript }),
    );
    const out: string[] = [];
    const pushed: string[] = [];
    const d: PushDeps = {
      ...pushDeps({ spoolRoot: spool, writeOut: (t) => out.push(t) }),
      readStdin: async () =>
        JSON.stringify({ session_id: "p1", transcript_path: transcript, cwd: "/elsewhere", hook_event_name: "PreCompact", trigger: "manual" }),
      fetchImpl: (async (_u: string, init: { body: string }) => {
        pushed.push((JSON.parse(init.body) as { kind: string }).kind);
        return { ok: true, status: 200, json: async () => ({ artifactId: "art_b", type: "LOG" }) };
      }) as unknown as typeof fetch,
    };
    assert.equal(await runSessionSnapshot({ event: "PreCompact" }, d), 0);
    const request = readCheckpointRequest(spool, "ses_c");
    assert.equal(request?.boundary, "compaction");
    assert.match(request!.reason, /no semantic checkpoint has been written/);
    assert.match(out.join("\n"), /push report --checkpoint compaction/);
    assert.deepEqual(pushed, ["log"], "the boundary record is still the only push — no fabricated checkpoint");
    // A second compaction keeps the FIRST request time (the oldest unanswered boundary).
    await runSessionSnapshot({ event: "PreCompact" }, d);
    assert.equal(readCheckpointRequest(spool, "ses_c")?.requestedAt, request!.requestedAt);
  });
});

describe("R03 — the verification receipt's gate classification", () => {
  it("F01: a gate binds to a definition — a package script (name → family, body recorded), a runner, or a reviewed wrapper; words and composition bind nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-gates-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", "typecheck:mvp": "tsc -p tsconfig.mvp.json --noEmit", fake: "node -e \"console.log('test')\"" } }));
    mkdirSync(join(dir, "packages", "deep"), { recursive: true });
    const resolveScript = packageScriptResolver(join(dir, "packages", "deep"));
    const test = classifyGateCommand("pnpm test", { resolveScript });
    assert.equal(test.allowlisted, true);
    assert.deepEqual(test.families, ["test"]);
    assert.deepEqual(test.scripts, [{ manager: "pnpm", name: "test", body: "vitest run" }], "the nearest package.json above cwd resolves the script");
    assert.equal(classifyGateCommand("CI=true pnpm typecheck:mvp", { resolveScript }).allowlisted, true);
    assert.match(classifyGateCommand("cd /x && CI=true pnpm typecheck:mvp", { resolveScript }).reason!, /changes the execution directory/, "F02a: a directory change is never a gate");
    assert.equal(classifyGateCommand("pnpm test | tail -40", { resolveScript }).allowlisted, false, "a pipe hides the gate's exit code");
    assert.match(classifyGateCommand("pnpm test || true", { resolveScript }).reason!, /hides or replaces/);
    assert.equal(classifyGateCommand("node -e \"console.log('test')\"", { resolveScript }).allowlisted, false, "the review's reproduction");
    assert.match(classifyGateCommand("pnpm fake", { resolveScript }).reason!, /names no gate family/);
    assert.equal(classifyGateCommand("echo tests green", { resolveScript }).allowlisted, false);
    assert.equal(classifyGateCommand("true", { resolveScript }).allowlisted, false);
    // No package.json anywhere above: a script by name is refused — the
    // command could not have run one there either.
    const nowhere = mkdtempSync(join(tmpdir(), "jentrix-nopkg-"));
    assert.match(classifyGateCommand("pnpm test", { resolveScript: packageScriptResolver(nowhere) }).reason!, /declares no script/);
  });

  it("a reviewed wrapper from .jentrix/gates.json counts, an unknown wrapper does not", () => {
    const reviewed = [{ id: "mvp-gates", command: "./scripts/gates.sh", families: ["typecheck", "test"] as const }];
    // Exact match only: the reviewed line is what was reviewed; a flag that
    // changes what the wrapper runs is a different command.
    const hit = classifyGateCommand("./scripts/gates.sh", { reviewed: reviewed as never });
    assert.equal(hit.allowlisted, true);
    assert.equal(hit.gateId, "mvp-gates");
    assert.equal(hit.source, "reviewed");
    assert.deepEqual(hit.families, ["typecheck", "test"]);
    assert.equal(classifyGateCommand("./scripts/gates.sh --skip-tests", { reviewed: reviewed as never }).allowlisted, false);
    assert.equal(classifyGateCommand("./scripts/other.sh", { reviewed: reviewed as never }).allowlisted, false);
  });

  it("the receipt carries the legacy opener, the exit code line, and a parseable header", () => {
    const body = buildVerificationReceipt({
      command: "pnpm test",
      exitCode: 0,
      output: "ok\n",
      cwd: "/repo",
      repo: { ownerName: "acme/app", revision: "deadbeef", dirtyDigest: "d1" },
      startedAt: "2026-09-12T00:00:00.000Z",
      endedAt: "2026-09-12T00:00:01.000Z",
    });
    assert.match(body, /^\$ pnpm test\nexit code: 0\n/);
    const header = parseSemanticHeader(body);
    assert.equal(headerString(header, "kind"), "verification-receipt");
    assert.equal(headerString(header, "outcome"), "success");
    assert.equal(headerString(header, "revision"), "deadbeef");
    assert.equal(headerString(header, "dirtyDigest"), "d1");
    // F01: with no resolver the CLI binds no script — the receipt SAYS why.
    assert.equal(header?.gateAllowlisted, false);
    assert.match(String(header?.gateReason), /declares no script/);
    const bound = parseSemanticHeader(
      buildVerificationReceipt({
        command: "pnpm test",
        exitCode: 0,
        output: "ok\n",
        cwd: "/repo",
        repo: null,
        startedAt: "2026-09-12T00:00:00.000Z",
        endedAt: "2026-09-12T00:00:01.000Z",
        resolveScript: () => ({ body: "vitest run" }),
      }),
    );
    assert.equal(bound?.gateAllowlisted, true);
    assert.equal(bound?.gateSource, "script");
    assert.deepEqual(bound?.gateFamilies, ["test"]);
    const scripts = bound?.gateScripts as Array<Record<string, unknown>>;
    assert.equal(scripts[0]!.name, "test");
    assert.equal(scripts[0]!.body, "vitest run");
    assert.equal(scripts[0]!.digest, createHash("sha256").update("vitest run", "utf8").digest("hex"));
    const expected = buildVerificationReceipt({
      command: "pnpm test",
      exitCode: 1,
      output: "1 failing\n",
      cwd: "/repo",
      repo: null,
      startedAt: "2026-09-12T00:00:00.000Z",
      endedAt: "2026-09-12T00:00:01.000Z",
      expectedFailure: true,
    });
    assert.equal(headerString(parseSemanticHeader(expected), "outcome"), "expected-failure");
  });
});

describe("R04 — session end --preserve-uncommitted", () => {
  const fakeGit = (dir: string) => async (args: string[]) => {
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return { code: 0, stdout: `${dir}\n` };
    if (key === "remote get-url origin") return { code: 0, stdout: "git@github.com:acme/app.git\n" };
    if (key === "symbolic-ref --short -q HEAD") return { code: 0, stdout: "main\n" };
    if (key === "rev-parse HEAD") return { code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" };
    if (key.startsWith("status --porcelain")) return { code: 0, stdout: " M src/a.ts\n?? notes.md\n" };
    if (key === "diff HEAD --patch --stat") return { code: 0, stdout: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" };
    if (key === "diff HEAD") return { code: 0, stdout: "-old\n+new\n" };
    if (key.startsWith("diff --no-index")) return { code: 1, stdout: "diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+hello\n" };
    return { code: 1, stdout: "" };
  };

  it("builds an attested patch of tracked AND untracked changes under an uncommitted-patch header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-r04-"));
    const built = await buildUncommittedPatchBody(fakeGit(dir), dir, "aaaaaaaaaa", "tree-digest-1");
    assert.ok(built);
    const header = parseSemanticHeader(built.body);
    assert.equal(headerString(header, "kind"), "uncommitted-patch");
    assert.equal(headerString(header, "treeDigest"), "tree-digest-1");
    assert.equal(built.files, 2);
    assert.match(built.body, /\+new/);
    assert.match(built.body, /\+hello/, "the untracked file's content rides in the patch");
    assert.equal(built.truncated, false);
  });

  it("session end pushes it as an attested DIFF and sends endTreeDigest on complete; without the flag it SAYS the tree is unpreserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-r04e-"));
    writeFileSync(join(dir, "notes.md"), "hello\n");
    const completes: Array<Record<string, unknown>> = [];
    const pushes: Array<{ kind: string; title: string; body: string; attested: boolean }> = [];
    const session = { id: "ses_e", status: "ACTIVE", captureStatus: "OFF_BY_DESIGN", captureComplete: false, alignment: { capture: "off" }, updatedAt: "2026-09-12T00:00:00.000Z", repoOwnerName: "acme/app", startHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", usage: null };
    const caller: SessionToolCaller = {
      async callTool({ name, arguments: args }) {
        if (name === "get_agent_session") return { structuredContent: session };
        if (name === "complete_agent_session") {
          completes.push(args as Record<string, unknown>);
          return { structuredContent: { id: "ses_e", status: "COMPLETED", captureComplete: false, captureStatus: "OFF_BY_DESIGN", summaryArtifactId: "art_s" } };
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    const make = (preserveUncommitted: boolean) => {
      const out: string[] = [];
      const err: string[] = [];
      const spool = mkdtempSync(join(tmpdir(), "jentrix-r04s-"));
      const d: SessionCommandDeps = {
        env: {},
        cwd: () => dir,
        configPath: join(spool, "config.json"),
        resolveTarget: () => ({ token: "tm_x", url: "https://s.example/api/mcp" }),
        ensureInstallationId: () => "i",
        connect: async () => ({ caller, close: async () => undefined }),
        git: fakeGit(dir),
        writeOut: (t) => out.push(t),
        writeErr: (t) => err.push(t),
        isInteractive: false,
        readLine: async () => "",
        resolveSessionHost: () => "/tools/host.js",
        runSessionHost: async () => 0,
        spawnSessionHostDetached: () => 1,
        spoolRoot: spool,
        fetchImpl: (async (_u: string, init: { body: string }) => {
          pushes.push(JSON.parse(init.body) as (typeof pushes)[number]);
          return { ok: true, status: 200, json: async () => ({ artifactId: "art_patch" }) };
        }) as unknown as typeof fetch,
      };
      return { d, out, err, flags: { preserveUncommitted } };
    };
    const plain = make(false);
    assert.equal(await runSessionEnd("ses_e", plain.flags, plain.d), 0);
    assert.match(plain.out.join("\n"), /NOT preserved.*--preserve-uncommitted/);
    assert.equal(pushes.length, 0);
    assert.equal(typeof completes[0]!.endTreeDigest, "string", "the tree digest travels even when the patch does not");
    assert.equal("uncommittedPatchArtifactId" in completes[0]!, false);

    const kept = make(true);
    assert.equal(await runSessionEnd("ses_e", kept.flags, kept.d), 0);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]!.kind, "diff");
    assert.equal(pushes[0]!.attested, true);
    assert.match(pushes[0]!.title, /^Attested uncommitted patch at aaaaaaaaaa \(2 paths\)/);
    assert.equal(completes[1]!.uncommittedPatchArtifactId, "art_patch");
    assert.match(kept.out.join("\n"), /Attested uncommitted patch pushed → artifact art_patch/);
  });
});

describe("R07 — the bounded opening prompt declares its cut", () => {
  it("keeps a small prompt verbatim and names both sizes past the cap", () => {
    assert.deepEqual(boundedOpeningPrompt("hello"), { body: "hello", truncated: false, originalBytes: 5, retainedBytes: 5 });
    const big = "x".repeat(MAX_OPENING_PROMPT_BYTES + 100);
    const bounded = boundedOpeningPrompt(big);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.originalBytes, MAX_OPENING_PROMPT_BYTES + 100);
    assert.match(bounded.body, new RegExp(`\\[truncated: opening prompt was ${MAX_OPENING_PROMPT_BYTES + 100} bytes; \\d+ retained by the 64 KiB cap`));
    assert.ok(Buffer.byteLength(bounded.body, "utf8") <= MAX_OPENING_PROMPT_BYTES + 200);
  });
});

describe("G06 — doctor's installed-vs-loaded behaviour revision", () => {
  it("is ok when CLI, installed and loaded agree; warns MIXED with the scoped fix otherwise; warns unstamped", () => {
    const ok = behaviourRevisionCheck("claude", { cli: "2026.09.12-1", installed: "2026.09.12-1", loaded: "2026.09.12-1", loadedKnown: true });
    assert.equal(ok.status, "ok");
    const mixed = behaviourRevisionCheck("codex", { cli: "2026.09.12-1", installed: "2026.09.12-1", loaded: "2026.09.01-3", loadedKnown: true });
    assert.equal(mixed.status, "warn");
    assert.match(mixed.detail, /MIXED/);
    assert.match(mixed.fix ?? "", /jentrix plugin install codex/);
    const unstamped = behaviourRevisionCheck("claude", { cli: "2026.09.12-1", installed: null, loaded: null, loadedKnown: false });
    assert.equal(unstamped.status, "warn");
  });
});
