import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readCodexHookContext,
  readCurrentProviderHookContext,
  UsageError,
} from "../src/commands/session";

function line(
  event: string,
  sessionId: string,
  cwd = "/repo",
  at = "2026-08-16T00:00:00.000Z",
  transcriptPath?: string,
): string {
  return JSON.stringify({
    event,
    at,
    payload: { session_id: sessionId, cwd, transcript_path: transcriptPath },
  });
}

describe("Codex trusted lifecycle context", () => {
  it("prefers equal process-owned thread/session ids", () => {
    const context = readCodexHookContext({
      env: {
        CODEX_THREAD_ID: "thread-1",
        CODEX_SESSION_ID: "thread-1",
      },
      cwd: () => "/repo",
    });
    assert.equal(context?.sessionId, "thread-1");
    assert.match(context!.basis, /CODEX_THREAD_ID/);
  });

  it("refuses conflicting process-owned ids", () => {
    assert.throws(
      () =>
        readCodexHookContext({
          env: { CODEX_THREAD_ID: "a", CODEX_SESSION_ID: "b" },
          cwd: () => "/repo",
        }),
      (error) =>
        error instanceof UsageError &&
        error.message.includes("PROVIDER_SESSION_CONFLICT"),
    );
  });

  it("accepts one live matching ledger session", () => {
    const context = readCodexHookContext(
      { env: { HOME: "/home/test" }, cwd: () => "/repo/subdir" },
      () => line("SessionStart", "thread-1"),
      () => Date.parse("2026-08-16T01:00:00.000Z"),
    );
    assert.equal(context?.sessionId, "thread-1");
    assert.match(context!.basis, /unambiguous SessionStart/);
  });

  it("uses the rollout path reported after SessionStart", () => {
    const context = readCodexHookContext(
      {
        env: { HOME: "/home/test", CODEX_THREAD_ID: "thread-1" },
        cwd: () => "/repo",
      },
      () =>
        `${line("SessionStart", "thread-1")}\n${line("UserPromptSubmit", "thread-1", "/repo", "2026-08-16T00:00:01.000Z", "/tmp/rollout.jsonl")}`,
    );
    assert.equal(context?.transcriptPath, "/tmp/rollout.jsonl");
  });

  it("resolves the exact local rollout when plugin hooks did not fire", () => {
    const home = mkdtempSync(join(tmpdir(), "jentrix-codex-home-"));
    const sessions = join(home, ".codex", "sessions", "2026", "08", "24");
    const rollout = join(
      sessions,
      "rollout-2026-08-24T17-43-47-thread-1.jsonl",
    );
    mkdirSync(sessions, { recursive: true });
    writeFileSync(rollout, "");

    const context = readCodexHookContext({
      env: { HOME: home, CODEX_SESSION_ID: "thread-1" },
      cwd: () => "/repo",
    });

    assert.equal(context?.transcriptPath, rollout);
    assert.match(context!.basis, /resolved from Codex sessions/);
  });

  it("ignores a stale ledger session", () => {
    const context = readCodexHookContext(
      { env: { HOME: "/home/test" }, cwd: () => "/repo" },
      () => line("SessionStart", "thread-old"),
      () => Date.parse("2026-08-17T00:00:01.000Z"),
    );
    assert.equal(context, null);
  });

  it("refuses concurrent matching ledger sessions", () => {
    assert.throws(
      () =>
        readCodexHookContext(
          { env: { HOME: "/home/test" }, cwd: () => "/repo" },
          () =>
            `${line("SessionStart", "thread-1")}\n${line("SessionStart", "thread-2")}`,
          () => Date.parse("2026-08-16T01:00:00.000Z"),
        ),
      (error) =>
        error instanceof UsageError &&
        error.message.includes("PROVIDER_SESSION_AMBIGUOUS"),
    );
  });

  it("selects Codex for implicit correlation", () => {
    const context = readCurrentProviderHookContext({
      env: { CODEX_THREAD_ID: "thread-1" },
      cwd: () => "/repo",
    });
    assert.equal(context?.provider, "codex");
    assert.equal(context?.sessionId, "thread-1");
  });
});
