/**
 * Runner toolchain glue. Since client-runtime v2 Phase D the doctor/setup/up
 * ORCHESTRATION lives in the runner package itself
 * (`agents/lib/runner-setup-client.ts` → the `jentrix-runner` bin);
 * `jentrix runner …` below is a HIDDEN one-window delegate (D16) that only
 * forwards argv. What stays here are the executable resolvers and subprocess
 * helpers the plugin/setup/session commands share.
 *
 * Semver decoupling (Phase D item 4): the delegate refuses nothing on
 * version — the runner speaks for itself; the old equal-semver lockstep
 * messages died with the moved orchestration.
 */
import { execFile, spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";

import { Command } from "commander";

import { execTarget } from "../exec-target";

const RUNNER_TIMEOUT_MS = 35_000;
const RUNNER_OUTPUT_CAP = 2 * 1024 * 1024;
const RUNNER_NOT_INSTALLED =
  "RUNNER_NOT_INSTALLED: run npm install -g @jentrix/runner, then retry " +
  "(worker operations live in the jentrix-runner bin).";

export interface RunnerInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

async function executable(path: string): Promise<string | null> {
  try {
    // STA-132 — Windows has no execute bit (npm ships .cmd shims), so X_OK
    // rejects valid installs there; existence is the honest probe.
    await fs.access(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

/** PATH scan for any of `names` (platform variants supplied by the caller). */
export async function resolveExecutableOnPath(
  names: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const found = await executable(resolve(dir, name));
      if (found) return found;
    }
  }
  return null;
}

/** Platform spellings of a bare binary name (`x` → `x.exe`/`x.cmd` on win). */
export function platformExecutableNames(name: string): string[] {
  return process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
}

/**
 * Runner bin names in preference order. `@jentrix/runner` installs
 * `jentrix-runner`; the pre-rename `@jentrix/stacks-runner` installed
 * `stacks-runner`, and the renamed package keeps that as an alias. Both are
 * probed so a CLI that has been upgraded still finds a runner that has not —
 * the two packages are version-pinned in lockstep but are separate installs,
 * so they upgrade at separate moments on a real machine.
 */
const RUNNER_BIN_NAMES = ["jentrix-runner", "stacks-runner"] as const;

export async function resolveRunnerExecutable(
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const override = env.STACKS_RUNNER_BIN;
  if (override) return isAbsolute(override) ? executable(override) : null;
  for (const name of RUNNER_BIN_NAMES) {
    const found = await resolveExecutableOnPath(
      platformExecutableNames(name),
      env,
    );
    if (found) return found;
  }
  return null;
}

/**
 * STA-133 — where the `claude` CLI lives: PATH first, then the native
 * installer's fixed drop (`~/.local/bin`), which a terminal opened BEFORE the
 * install misses — the PATH entry exists in the persisted profile but not in
 * that process. Finding the binary there lets `plugin install` proceed with
 * an absolute path instead of telling an operator with a working install to
 * go install Claude Code.
 */
export async function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): Promise<string | null> {
  const names = platformExecutableNames("claude");
  const onPath = await resolveExecutableOnPath(names, env);
  if (onPath) return onPath;
  for (const name of names) {
    const found = await executable(resolve(home, ".local", "bin", name));
    if (found) return found;
  }
  return null;
}

export function invokeRunnerProcess(
  file: string,
  args: string[],
  stdin?: string,
  timeoutMs: number = RUNNER_TIMEOUT_MS,
): Promise<RunnerInvocation> {
  if (!isAbsolute(file)) {
    return Promise.reject(new Error("runner executable path must be absolute"));
  }
  const target = execTarget(file, args);
  return new Promise((resolveInvocation, reject) => {
    const child = execFile(
      target.file,
      target.args,
      {
        timeout: timeoutMs,
        maxBuffer: RUNNER_OUTPUT_CAP,
        windowsHide: true,
        ...target.options,
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error("runner subprocess timed out"));
          return;
        }
        // `error.code` is a NUMBER for a process that ran and exited non-zero,
        // and an errno STRING (`"ENOENT"`, `"EINVAL"`) when the spawn itself
        // failed. Scoring the second as 0 is how a Windows `.cmd` refusal used
        // to read as a successful install that had run nothing; report it as a
        // failure with the errno, since there is no exit code to report.
        const raw = (error as { code?: unknown } | null)?.code;
        if (error && typeof raw === "string") {
          resolveInvocation({
            code: 1,
            stdout: String(stdout),
            stderr: `${String(stderr)}${raw}: ${error.message}`,
          });
          return;
        }
        resolveInvocation({
          code: typeof raw === "number" ? Number(raw) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export function runRunnerForeground(
  file: string,
  args: string[],
  env?: Record<string, string>,
): Promise<number> {
  if (!isAbsolute(file)) {
    return Promise.reject(new Error("runner executable path must be absolute"));
  }
  const target = execTarget(file, args);
  return new Promise((resolveRun, reject) => {
    const child = spawn(target.file, target.args, {
      stdio: "inherit",
      ...target.options,
      // D18: a non-config credential reaches the session host through the
      // child environment, never through the plan file.
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

/** Deps for the hidden delegate — resolution + foreground exec only. */
export interface RunnerDelegateDeps {
  resolveRunner(): Promise<string | null>;
  runRunner(file: string, args: string[]): Promise<number>;
  writeErr(text: string): void;
}

/**
 * `jentrix runner …` — hidden D16 delegate to the `jentrix-runner` bin for
 * one release window (Phase D §15.7); Phase E removes it. Argv passes
 * through verbatim (`passThroughOptions`, so `--json` and friends reach the
 * runner untouched).
 */
export function registerRunnerCommand(
  program: Command,
  deps: RunnerDelegateDeps,
  onExit: (code: number) => void,
): void {
  program
    .command("runner", { hidden: true })
    .description("(moved) delegate to the jentrix-runner bin")
    .argument("[args...]", "arguments forwarded to jentrix-runner")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_args: string[], _opts: unknown, command: Command) => {
      // `command.args` (not the variadic operand) — with allowUnknownOption,
      // flags like `--json` are not operands, and the runner must receive
      // argv verbatim.
      const args = command.args;
      const runner = await deps.resolveRunner();
      if (!runner) {
        deps.writeErr(RUNNER_NOT_INSTALLED);
        onExit(2);
        return;
      }
      deps.writeErr(
        "notice: `jentrix runner` moved to the `jentrix-runner` bin — this delegate lasts one release window.",
      );
      onExit(await deps.runRunner(runner, args));
    });
}
