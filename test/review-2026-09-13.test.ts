import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildVerificationReceipt, classifyGateCommand, runPush, type PushDeps } from "../src/commands/push.js";
import { defaultGitRunner, scopedDirtyDigest, type GitRunner } from "../src/repo.js";
import { mapCodexHook } from "../src/session-host/session-codex-hooks.js";
import { parseSemanticHeader } from "../src/session-host/semantic-header.js";
import { SessionBridge } from "../src/session-host/session-bridge.js";
import { createSessionRedactor } from "../src/session-host/session-redact.js";
import { SessionSpool } from "../src/session-host/session-spool.js";

// The 2026-09-13 review's reproductions (reports/plugin-m1-review-2026-09-13/
// review-probes.ts), kept as regression tests: each ran the REAL shell / git /
// bridge and passed as a defect; each must now be refused or converge.

// A nested `node --test` inherits the runner's NODE_TEST_CONTEXT and reports
// through the runner's protocol instead of TAP; strip it so the child behaves
// like the shell command an agent would run.
const cleanEnv = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
})();
const sh = (command: string, cwd?: string) => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", cwd, env: cleanEnv });
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("2026-09-13 review — F01: glued operators and help-only runs", () => {
  it("a failing test hidden behind `||true` / `|cat`, and `--help`, exit 0 for real and are refused as gates", () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-f01-"));
    const fail = join(dir, "fail.test.mjs");
    writeFileSync(fail, "import test from 'node:test';test('intentional failing fixture',()=>{throw new Error('fixture failure')});\n");
    assert.notEqual(spawnSync(process.execPath, ["--test", fail], { encoding: "utf8", env: cleanEnv }).status, 0);
    for (const command of [`node --test ${q(fail)} ||true`, `node --test ${q(fail)}|cat`, "node --test --help"]) {
      const ran = sh(command);
      assert.equal(ran.status, 0, `${command} really exits 0`);
      const verdict = classifyGateCommand(command);
      assert.equal(verdict.allowlisted, false, command);
      assert.deepEqual(verdict.families, []);
      const header = parseSemanticHeader(
        buildVerificationReceipt({
          command,
          exitCode: ran.status ?? 1,
          output: ran.stdout + ran.stderr,
          cwd: dir,
          repo: { ownerName: "fixture/project", root: dir, revision: "fixture-head", dirtyDigest: "fixture-digest" },
          startedAt: "2026-09-13T00:00:00Z",
          endedAt: "2026-09-13T00:00:01Z",
        }),
      );
      assert.equal(header?.gateAllowlisted, false);
      assert.deepEqual(header?.gateFamilies, []);
      assert.match(String(header?.gateReason), /hides|prints and exits/);
    }
    // The original inline-Node reproductions stay refused (positive control).
    assert.equal(classifyGateCommand("node -e \"console.log('test')\"").allowlisted, false);
    assert.equal(classifyGateCommand("node -e \"process.exit(1)\" test || node -e \"process.exit(0)\"").allowlisted, false);
  });
});

describe("2026-09-13 review — F02a: a command that runs in checkout B cannot be certified for A", () => {
  it("`cd B && node --test …` pushed from A is attested but NOT a gate, and the receipt names A's root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-f02a-"));
    const cwdA = join(dir, "project-a");
    const cwdB = join(dir, "project-b");
    mkdirSync(cwdA);
    mkdirSync(cwdB);
    writeFileSync(join(cwdB, "pass.test.mjs"), "import test from 'node:test';test('ONLY_PROJECT_B',()=>{});\n");
    const calls: Array<Record<string, unknown>> = [];
    const errs: string[] = [];
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${cwdA}\n` };
      if (args[0] === "remote") return { code: 0, stdout: "git@github.com:fixture/project-a.git\n" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "fixture-head-A\n" };
      return { code: 0, stdout: "" };
    };
    const command = `cd ${q(cwdB)} && node --test pass.test.mjs`;
    const deps = {
      env: { CODEX_THREAD_ID: "fixture-thread" },
      cwd: () => cwdA,
      configPath: join(dir, "config.json"),
      resolveTarget: () => ({ token: "tm_fixture_token_abcdefghijklmnop", url: "http://localhost:3000/api/mcp" }),
      ensureInstallationId: () => "fixture-install",
      connect: async () => {
        throw new Error("no external MCP");
      },
      git: fakeGit,
      writeOut: () => {},
      writeErr: (t: string) => errs.push(t),
      isInteractive: false,
      readLine: async () => "",
      runSessionHost: async () => 0,
      spawnSessionHostDetached: () => -1,
      spoolRoot: join(dir, "push-spool"),
      resolveSessionHost: () => null,
      readStdin: async () => "",
      runCommand: async (c: string) => {
        const r = sh(c, cwdA);
        return { code: r.status ?? 1, output: r.stdout + r.stderr };
      },
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ artifactId: "fixture-log" }), { status: 200 });
      }) as typeof fetch,
    } as unknown as PushDeps;
    assert.equal(await runPush("log", undefined, { session: "fixture-session", fromCmd: command }, deps), 0);
    const log = String(calls[0]!.body);
    assert.ok(log.includes("ONLY_PROJECT_B"), "the test really ran in B");
    const header = parseSemanticHeader(log)!;
    assert.equal(header.cwd, cwdA);
    assert.equal(header.repoRoot, cwdA, "the receipt names the checkout root its digest describes");
    assert.equal(header.gateAllowlisted, false, "a directory-changing line is not a gate");
    assert.match(String(header.gateReason), /changes the execution directory/);
    assert.match(errs.join("\n"), /changes the execution directory/);
  });
});

describe("2026-09-13 review — F02b: the tree digest is exact or unknown", () => {
  it("changing every byte of an 8 MiB+1 untracked file changes the digest; over-limit trees are unknown (null)", async () => {
    const root = mkdtempSync(join(tmpdir(), "jentrix-f02b-"));
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    writeFileSync(join(root, "seed.txt"), "seed\n");
    spawnSync("git", ["-C", root, "add", "seed.txt"]);
    assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "seed"]).status, 0);
    const large = join(root, "fixture.bin");
    writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    const a = await scopedDirtyDigest(defaultGitRunner, root);
    writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1, 66));
    const b = await scopedDirtyDigest(defaultGitRunner, root);
    assert.ok(a && b);
    assert.notEqual(a, b, "same size, different bytes → different digests");
    writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    assert.equal(await scopedDirtyDigest(defaultGitRunner, root), a, "deterministic");
    // Limits turn the tree into UNKNOWN, never into an approximation.
    assert.equal(await scopedDirtyDigest(defaultGitRunner, root, { limits: { untrackedBytes: 1024 } }), null);
    assert.equal(await scopedDirtyDigest(defaultGitRunner, root, { limits: { untrackedFiles: 0 } }), null);
    assert.equal(await scopedDirtyDigest(defaultGitRunner, root, { readFile: () => null }), null, "an unreadable untracked file is unknown");
    const noDiff: GitRunner = async (args, cwd, opts) => (args[0] === "diff" ? { code: 128, stdout: "" } : defaultGitRunner(args, cwd, opts));
    assert.equal(await scopedDirtyDigest(noDiff, root), null, "a diff the runner could not produce is unknown");
    // A tracked modification changes the digest too (the diff is hashed whole).
    writeFileSync(join(root, "seed.txt"), "seed changed\n");
    assert.notEqual(await scopedDirtyDigest(defaultGitRunner, root), a);
  });
});

describe("2026-09-13 review — F03: a replacement-output retry re-sends the SAME bytes", () => {
  it("A acked, B replaces A, B's ack is lost, a new bridge retries B: same attempt id, same `supersedes`, identical payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-f03-"));
    const spoolRoot = join(dir, "spool");
    let networkFails = false;
    const uploads: Array<{ body: string }> = [];
    const makeBridge = () =>
      new SessionBridge({
        jentrixBaseUrl: "https://jentrix.test",
        bearer: "tm_fixture_token",
        sessionId: "fixture-session",
        provider: "codex",
        spool: new SessionSpool(spoolRoot, "fixture-session"),
        redactor: createSessionRedactor({ env: {}, homedir: "/home/fixture" }),
        traceCapture: false,
        callTool: async () => ({}),
        fetchImpl: (async (_u: unknown, init?: RequestInit) => {
          uploads.push(JSON.parse(String(init?.body)) as { body: string });
          if (networkFails) throw new Error("simulated lost acknowledgement");
          return new Response(JSON.stringify({ artifactId: `artifact-${uploads.length}` }), { status: 200 });
        }) as typeof fetch,
      });
    const b = makeBridge();
    for (const e of mapCodexHook("Stop", { last_assistant_message: "Output A", turn_id: "turn-A" }).events) b.record(e);
    const a = await b.pushFinalResponse();
    assert.equal(a.delivery, "acked");
    for (const e of mapCodexHook("Stop", { last_assistant_message: "Output B changed", turn_id: "turn-B" }).events) b.record(e);
    networkFails = true;
    const failed = await b.pushFinalResponse();
    assert.equal(failed.delivery, "failed");
    const before = uploads.at(-1)!.body;
    assert.equal(parseSemanticHeader(before)!.supersedes, a.artifactId);
    networkFails = false;
    const retried = await makeBridge().pushFinalResponse();
    const after = uploads.at(-1)!.body;
    assert.equal(retried.delivery, "acked");
    assert.equal(retried.attemptId, failed.attemptId, "the same attempt converges");
    assert.equal(retried.supersedes, a.artifactId, "the predecessor survives the restart");
    assert.equal(sha(after), sha(before), "byte-identical payload — the server's content dedupe lands it once");
    assert.equal(parseSemanticHeader(after)!.supersedes, a.artifactId);
    assert.ok(after.includes("Output B changed"));
    const record = JSON.parse(readFileSync(join(spoolRoot, "fixture-session", "final-output.json"), "utf8")) as { body?: string; supersedes: string | null; delivery: string };
    assert.equal(record.delivery, "acked");
    assert.equal(record.supersedes, a.artifactId);
    assert.equal(record.body, before, "the record holds the exact payload");
  });
});
