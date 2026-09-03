/**
 * `jentrix logout` — drop the stored credentials (stage C4.2).
 *
 * Removes the `token` + `oauth` fields from ~/.config/stacks/config.json,
 * preserving everything else (url, defaults). There is NO server-side token
 * revocation: the P2.7 AS exposes no revocation endpoint, and the stage
 * explicitly forbids adding one — so logout is purely local. The stored access
 * token expires on its own (1h TTL); to hard-kill a session before then, delete
 * the token row in the Jentrix tokens UI.
 *
 * A `--token`/env-provided token is NOT touched (logout only clears what login
 * wrote to the config file). No token value is ever printed.
 */

import { Command } from "commander";

import { ConfigError, clearOAuthSession } from "../config";
import { EXIT_CODES } from "../errors";

export interface LogoutDeps {
  /** The config-file path login persisted into. */
  configPath: string;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/**
 * Run one `jentrix logout`. Returns the process exit code. A missing/empty
 * config is not an error (already signed out). A malformed config file is
 * exit 2 (surfaced from `ConfigError`), never a stack trace.
 */
export function runLogoutCommand(deps: LogoutDeps): number {
  let result: { hadToken: boolean };
  try {
    result = clearOAuthSession(deps.configPath);
  } catch (e) {
    if (e instanceof ConfigError) {
      deps.writeErr(`error: ${e.message}`);
      return e.exitCode;
    }
    const detail = e instanceof Error ? e.message : String(e);
    deps.writeErr(`error: could not update the config file: ${detail}`);
    return EXIT_CODES.INTERNAL;
  }
  if (result.hadToken) {
    deps.writeOut(
      `Signed out — cleared the stored token from ${deps.configPath}. ` +
        "The server-side token expires on its own; revoke it in the tokens UI " +
        "to kill it immediately.",
    );
  } else {
    deps.writeOut("Already signed out (no stored token).");
  }
  return EXIT_CODES.OK;
}

/** Mount the `logout` command. */
export function registerLogoutCommand(
  program: Command,
  deps: LogoutDeps,
  onExit: (code: number) => void,
): Command {
  return program
    .command("logout")
    .description(
      "Clear the OAuth token stored by `jentrix login` (local only).",
    )
    .action(() => {
      onExit(runLogoutCommand(deps));
    });
}
