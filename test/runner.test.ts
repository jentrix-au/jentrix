import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import {
  registerRunnerCommand,
  resolveClaudeExecutable,
} from "../src/commands/runner";

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

// Client-runtime v2 Phase D: `jentrix runner …` is a hidden one-window
// delegate to the `jentrix-runner` bin — orchestration lives in the runner
// package (agents/lib/runner-setup-client.ts) and is tested there.
function delegate(overrides: {
  resolveRunner?: () => Promise<string | null>;
  runRunner?: (file: string, args: string[]) => Promise<number>;
}) {
  const err: string[] = [];
  const calls: Array<{ file: string; args: string[] }> = [];
  let exit: number | undefined;
  const program = new Command().exitOverride();
  registerRunnerCommand(
    program,
    {
      resolveRunner:
        overrides.resolveRunner ?? (async () => "/tools/jentrix-runner"),
      runRunner:
        overrides.runRunner ??
        (async (file, args) => {
          calls.push({ file, args });
          return 0;
        }),
      writeErr: (text) => err.push(text),
    },
    (code) => {
      exit = code;
    },
  );
  return {
    err,
    calls,
    exit: () => exit,
    run: (argv: string[]) =>
      program.parseAsync(["node", "jentrix", "runner", ...argv]),
  };
}

test("delegate forwards argv verbatim to jentrix-runner with a one-window notice", async () => {
  const d = delegate({});
  await d.run(["setup", "--workspace", "ws_1", "--runtime", "claude", "--yes"]);
  assert.equal(d.exit(), 0);
  assert.deepEqual(d.calls, [
    {
      file: "/tools/jentrix-runner",
      args: ["setup", "--workspace", "ws_1", "--runtime", "claude", "--yes"],
    },
  ]);
  assert.match(d.err.join("\n"), /moved to the `jentrix-runner` bin/);
  assert.match(d.err.join("\n"), /one release window/);
});

test("delegate propagates the runner exit code", async () => {
  const d = delegate({ runRunner: async () => 7 });
  await d.run(["doctor", "--json"]);
  assert.equal(d.exit(), 7);
});

test("missing runner bin → RUNNER_NOT_INSTALLED naming @jentrix/runner only", async () => {
  const d = delegate({ resolveRunner: async () => null });
  await d.run(["up"]);
  assert.equal(d.exit(), 2);
  assert.match(d.err[0]!, /RUNNER_NOT_INSTALLED/);
  assert.match(d.err[0]!, /npm install -g @jentrix\/runner/);
  // Phase D item 4: no equal-semver lockstep demand.
  assert.doesNotMatch(d.err[0]!, /@jentrix\/cli@/);
});

test("the runner command is hidden from generated help", async () => {
  const program = new Command().exitOverride();
  registerRunnerCommand(
    program,
    {
      resolveRunner: async () => null,
      runRunner: async () => 0,
      writeErr: () => undefined,
    },
    () => undefined,
  );
  assert.ok(!program.helpInformation().includes("runner"));
});
