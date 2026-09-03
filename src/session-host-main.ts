/**
 * `jentrix-session-host` — the MVP connected-session host, shipped INSIDE
 * `@jentrix/cli` (client-runtime v2 D10/§18: a standalone build entry and
 * second bin, deliberately not a third package). Two subcommands:
 *
 *   run  (--plan-file <path> | --plan-stdin)   — the capture host
 *   hook (--provider claude|codex | --dir DIR) --event NAME
 *        — the lifecycle-hook forwarder every plugin hook invokes
 *
 * `session-run` / `session-hook` are accepted as internal aliases (§17.2:
 * the public binary boundary is what changed; the runner's D16 delegate
 * execs this bin with its old verbs verbatim).
 *
 * The HOOK path is ZERO-NETWORK by construction: it lazy-imports only the
 * ledger appender — never the host module, whose closure holds the MCP
 * client and both transcript mappers. The host resolves its credential per
 * D18 (configPath → STACKS_TOKEN env → legacy in-plan bearer), and the plan
 * file is unlinked on read.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const SESSION_HOST_PROTOCOL_VERSION = 1;

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * STA-131 — the default hook-context dir per provider, resolved in code. A
 * `$HOME` literal on hook argv never expands on Windows (no POSIX shell), so
 * the plugins pass `--provider` and the path is built here, cross-platform.
 */
export function sessionHookDir(
  provider: string | null,
  home: string = homedir(),
): string | null {
  return provider === "claude" || provider === "codex"
    ? join(home, ".config", "stacks", `${provider}-sessions`)
    : null;
}

async function readStdinCapped(cap = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > cap) {
      throw new Error("session-host input exceeded its size limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function sessionHostMain(args: string[]): Promise<number> {
  const command = args[0];

  if (
    (command === "run" || command === "session-run") &&
    (args.includes("--plan-stdin") || args.includes("--plan-file"))
  ) {
    // The plan arrives over stdin or a 0600 file unlinked on read — never
    // argv. Per D18 it carries NO bearer; see `bearerSourceOf` in the host.
    //
    // JEN-306: the host talks MCP + REST over the global `fetch`, which
    // ignores HTTPS_PROXY without a dispatcher. Imported HERE, inside the run
    // arm, so the zero-network hook arm below never loads undici.
    const [{ runSessionHost }, { installProxyDispatcher }] = await Promise.all([
      import("./session-host/session-host.js"),
      import("./proxy.js"),
    ]);
    installProxyDispatcher();
    let raw: string;
    const planFile = valueAfter(args, "--plan-file");
    if (planFile) {
      const { readFileSync, unlinkSync } = await import("node:fs");
      raw = readFileSync(planFile, "utf8");
      try {
        unlinkSync(planFile);
      } catch {
        // best-effort — the file is 0600 inside the 0700 spool dir
      }
    } else {
      raw = await readStdinCapped();
    }
    const plan = JSON.parse(raw) as {
      protocolVersion?: number;
      provider?: string;
    };
    if (plan.protocolVersion !== SESSION_HOST_PROTOCOL_VERSION) {
      throw new Error(
        "SESSION_HOST_VERSION_MISMATCH: session plan protocol mismatch — reinstall @jentrix/cli so the CLI and its bundled host match",
      );
    }
    if (plan.provider !== "claude" && plan.provider !== "codex") {
      throw new Error("SESSION_PLAN_INVALID: unknown session provider");
    }
    return runSessionHost(
      plan as import("./session-host/session-host.js").SessionRunPlan,
    );
  }

  // §17.2: the hook forwarder every declared lifecycle event invokes. Argv
  // holds only the provider (or an explicit dir) and event name; the payload
  // rides stdin. ZERO-NETWORK: only the ledger appender loads — the host
  // module (MCP client + transcript mappers) must never enter this path.
  if (command === "hook" || command === "session-hook") {
    // JEN-305: a hook must NEVER fail the session it is observing. Claude Code
    // runs this in front of the operator at SessionStart, and a non-zero exit
    // buys them a warning about a bookkeeping append. So every failure inside
    // this arm — a bad --provider, an unwritable ledger, oversized stdin — is
    // reported on stderr and the verb still exits 0. What it CAN write, it
    // writes first: the line records the environment (D3 move 1) even when the
    // payload is unreadable, because a line that exists at all is the evidence
    // the missing-hook card turns on.
    try {
      const { appendHookEvent } =
        await import("./session-host/session-hook-log.js");
      const dir =
        valueAfter(args, "--dir") ??
        sessionHookDir(valueAfter(args, "--provider") ?? null);
      const event = valueAfter(args, "--event") ?? "unknown";
      if (!dir) {
        throw new Error(
          "SESSION_HOOK_INVALID: hook needs --provider claude|codex or --dir",
        );
      }
      appendHookEvent(dir, event, await readStdinCapped());
    } catch (error: unknown) {
      process.stderr.write(
        `jentrix-session-host hook: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return 0;
  }

  if (command === "version") {
    const { CLI_VERSION } = await import("./client.js");
    process.stdout.write(
      `${JSON.stringify({ protocolVersion: SESSION_HOST_PROTOCOL_VERSION, version: CLI_VERSION })}\n`,
    );
    return 0;
  }

  process.stderr.write(
    "usage: jentrix-session-host run (--plan-file PATH | --plan-stdin) | hook (--provider claude|codex | --dir DIR) --event NAME | version\n",
  );
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /session-host-main\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  sessionHostMain(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
