import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  appendHookEvent,
  hookEnv,
  readHookLines,
  type HookLine,
} from "../src/session-host/session-hook-log";

// ---------------------------------------------------------------------------
// JEN-305 — the ledger line IS the reproduction.
//
// A lifecycle hook that never resolves leaves nothing behind anywhere: Claude
// Code retains no hook stderr on macOS and the transcript records no failure.
// So the line records the environment the hook actually ran in, and its `path`
// field is what decides whether a bare `jentrix-session-host` could ever have
// resolved on that launch.
// ---------------------------------------------------------------------------

function fakeProc(over: Partial<Parameters<typeof hookEnv>[0]> = {}) {
  return {
    env: { PATH: "/usr/bin:/bin" } as Record<string, string | undefined>,
    execPath: "/opt/homebrew/bin/node",
    argv0: "node",
    argv: ["/opt/homebrew/bin/node", "/pkg/dist/session-host-main.js", "hook"],
    ...over,
  };
}

describe("hookEnv (JEN-305)", () => {
  it("records the PATH, the node, argv0, and WHICH copy answered", () => {
    assert.deepEqual(hookEnv(fakeProc()), {
      path: "/usr/bin:/bin",
      execPath: "/opt/homebrew/bin/node",
      argv0: "node",
      script: "/pkg/dist/session-host-main.js",
    });
  });

  it("caps a long PATH — a developer's runs to kilobytes, appended per event", () => {
    const long = "/x".repeat(8000);
    const env = hookEnv(fakeProc({ env: { PATH: long } }));
    assert.equal(env.path!.length, 4096);
    assert.ok(long.startsWith(env.path!));
  });

  it("survives an unset PATH, and reads Windows' Path", () => {
    assert.equal(hookEnv(fakeProc({ env: {} })).path, null);
    assert.equal(
      hookEnv(fakeProc({ env: { Path: "C:\\Windows" } })).path,
      "C:\\Windows",
    );
  });
});

describe("appendHookEvent (JEN-305)", () => {
  it("carries the environment beside the payload, and stays readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-hooklog-"));
    appendHookEvent(
      dir,
      "SessionStart",
      JSON.stringify({ session_id: "abc", cwd: "/repo" }),
      hookEnv(fakeProc()),
    );
    const { lines } = readHookLines(dir, 0);
    assert.equal(lines.length, 1);
    const line = lines[0]!;
    assert.equal(line.event, "SessionStart");
    assert.equal(line.payload.session_id, "abc");
    // The field the card's verdict is read off.
    assert.equal(line.env?.path, "/usr/bin:/bin");
    assert.equal(line.env?.execPath, "/opt/homebrew/bin/node");
    assert.equal(line.env?.script, "/pkg/dist/session-host-main.js");
  });

  it("still records the environment when the payload is not JSON at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-hooklog-"));
    appendHookEvent(dir, "SessionStart", "not json", hookEnv(fakeProc()));
    const line = readHookLines(dir, 0).lines[0]!;
    assert.equal((line.payload as unknown as { raw: string }).raw, "not json");
    assert.equal(line.env?.execPath, "/opt/homebrew/bin/node");
  });

  it("a line written before 0.6.7 has no env and still reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "jentrix-hooklog-"));
    // Exactly what ≤0.6.6 appended: no `env` key.
    const legacy = `${JSON.stringify({
      event: "SessionEnd",
      at: new Date().toISOString(),
      payload: { session_id: "old" },
    })}\n`;
    writeFileSync(join(dir, "hooks.ndjson"), legacy);
    const line: HookLine = readHookLines(dir, 0).lines[0]!;
    assert.equal(line.event, "SessionEnd");
    assert.equal(line.env, undefined);
  });
});
