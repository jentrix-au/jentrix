/** Executable discovery and bounded subprocesses for setup, plugins and sessions. */
import { execFile, spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";

import { execTarget } from "./exec-target";

const PROCESS_TIMEOUT_MS = 35_000;
const PROCESS_OUTPUT_CAP = 2 * 1024 * 1024;
export interface ProcessInvocation {
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

export function invokeProcess(
  file: string,
  args: string[],
  stdin?: string,
  timeoutMs: number = PROCESS_TIMEOUT_MS,
): Promise<ProcessInvocation> {
  if (!isAbsolute(file)) {
    return Promise.reject(new Error("executable path must be absolute"));
  }
  const target = execTarget(file, args);
  return new Promise((resolveInvocation, reject) => {
    const child = execFile(
      target.file,
      target.args,
      {
        timeout: timeoutMs,
        maxBuffer: PROCESS_OUTPUT_CAP,
        windowsHide: true,
        ...target.options,
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error("subprocess timed out"));
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

export function runForeground(
  file: string,
  args: string[],
  env?: Record<string, string>,
): Promise<number> {
  if (!isAbsolute(file)) {
    return Promise.reject(new Error("executable path must be absolute"));
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
