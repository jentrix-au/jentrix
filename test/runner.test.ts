import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerRunnerCommand } from "../src/commands/runner";
import { resolveClaudeExecutable } from "../src/process";

// STA-133 — the native Claude Code installer drops the binary in ~/.local/bin
// and appends PATH in the shell profile; a terminal opened BEFORE the install
// never sees that entry. Resolution therefore falls back to the fixed drop,
// so setup/plugin-install proceed with an absolute path instead of reporting
// a working install as missing.
test("claude resolution falls back to ~/.local/bin when PATH misses it", async () => {
  const home = await mkdtemp(join(tmpdir(), "stacks-home-"));
  assert.equal(await resolveClaudeExecutable({ PATH: "" }, home), null);
  const drop = join(home, ".local", "bin");
  await mkdir(drop, { recursive: true });
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  await writeFile(join(drop, name), "#!/bin/sh\n", { mode: 0o755 });
  const found = await resolveClaudeExecutable({ PATH: "" }, home);
  assert.ok(found, "the fixed drop location was probed");
  assert.ok(found!.endsWith(name));
  // PATH still wins when it resolves — the fallback never shadows it.
  const pathDir = await mkdtemp(join(tmpdir(), "stacks-path-"));
  await writeFile(join(pathDir, name), "#!/bin/sh\n", { mode: 0o755 });
  const onPath = await resolveClaudeExecutable({ PATH: pathDir }, home);
  assert.ok(onPath);
  assert.notEqual(onPath, found);
});

test("retired runner command is inert for every old invocation, with a migration refusal", async () => {
  for (const args of [
    ["setup", "--yes"],
    ["up"],
    ["doctor", "--json"],
    ["--help"],
  ]) {
    const err: string[] = [];
    let exit: number | undefined;
    const program = new Command().exitOverride();
    registerRunnerCommand(
      program,
      { writeErr: (text) => err.push(text) },
      (code) => {
        exit = code;
      },
    );
    assert.ok(!program.helpInformation().includes("runner"));
    await program.parseAsync(["runner", ...args], { from: "user" });
    assert.equal(exit, 2);
    assert.match(err.join("\n"), /OPS_RUNNER_REMOVED/);
    assert.doesNotMatch(err.join("\n"), /npm install|@jentrix\/runner/);
  }
});
