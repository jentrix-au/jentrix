/**
 * `jentrix align` — D16 compatibility alias for `jentrix session align`
 * (client-runtime v2 §15.3).
 *
 * The eight-question alignment wizard that lived here (2,334 lines: catalog
 * assembly, Project/board/task provisioning, `.mcp.json` writing, host
 * supervision) is REMOVED, not wrapped: alignment is now two narrow levels —
 * `jentrix folder align` binds a checkout to a workspace once, and
 * `jentrix session align --task <id-or-key>` anchors the live session's work.
 * A Project is an optional task label (`jentrix task project add|remove`),
 * not part of session identity, so nothing here asks about one.
 *
 * The alias forwards the narrow flags with one rename notice and disappears
 * after the window.
 */

import { Command, Option } from "commander";

import { EXIT_CODES } from "../errors";
import {
  runSessionAlign,
  type SessionAlignFlags,
  type SessionCommandDeps,
} from "./session";

// The local alignment marker moved to ./session (AGE-958: `session end`
// self-resolves through it; defining it there keeps the import graph
// one-directional). Re-exported for existing callers.
export {
  alignmentMarkerPath,
  parseAlignmentMarkerFile,
  readAlignmentMarker,
  removeAlignmentMarkerEntry,
  resolveAlignmentMarker,
  upsertAlignmentMarker,
  writeAlignmentMarker,
  type AlignmentMarker,
  type AlignmentMarkerFile,
} from "./session";

interface AlignAliasFlags extends SessionAlignFlags {
  /** Legacy wizard flags — accepted for the window, adapted or refused. */
  project?: string;
  workspace?: string;
  yes?: boolean;
  questions?: boolean;
}

export async function runAlignAlias(
  flags: AlignAliasFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  deps.writeErr(
    "note: `jentrix align` is now `jentrix session align` (folder ↔ workspace binding is `jentrix folder align`) — this alias keeps working for one release window.",
  );
  if (flags.questions) {
    deps.writeErr(
      [
        "ALIGN_WIZARD_REMOVED: the interactive alignment wizard is gone — alignment is two narrow commands now:",
        "  jentrix folder align                      # once per checkout: bind to a workspace",
        "  jentrix session align --task <id-or-key>  # anchor this session's work (or --session-level)",
        "Project labels are managed separately: jentrix task project add|remove.",
      ].join("\n"),
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  if (flags.project || flags.workspace) {
    deps.writeErr(
      "note: --project/--workspace are no longer part of alignment — the folder binding names the workspace (jentrix folder align), and a Project is an optional task label (jentrix task project add).",
    );
  }
  return runSessionAlign(flags, deps);
}

export function registerAlignCommand(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  return program
    .command("align", { hidden: true })
    .description("(renamed) — use `jentrix session align`")
    .option("--task <id-or-key>", "the aligned work item (task id or key)")
    .option("--session-level", 'no task — "session-level work"')
    .option("--owner <user-id>", "accountable human owner")
    .option("--agent <label>", "producer label for this session")
    .option("--agent-emoji <emoji>", "emoji shown before the producer label")
    .option("--capture", "TRACE capture on for this session")
    .option("--no-capture", "TRACE capture off")
    .option("--skeleton", "activity skeleton on")
    .option("--no-skeleton", "activity skeleton off")
    .option("--budget <tokens>", "per-session token budget", (v) => Number(v))
    .option("--no-budget", "disarm the token budget")
    .option("--json", "stable JSON output")
    .addOption(
      new Option(
        "--provider <provider>",
        "provider of the running session",
      ).choices(["claude", "codex"]),
    )
    .addOption(new Option("--provider-session <id>", "").hideHelp())
    .addOption(new Option("--transcript-path <path>", "").hideHelp())
    .addOption(new Option("--project <id-or-slug>", "").hideHelp())
    .addOption(new Option("--workspace <id-or-slug>", "").hideHelp())
    .addOption(new Option("--yes", "").hideHelp())
    .addOption(new Option("--questions", "").hideHelp())
    .action(async (options: AlignAliasFlags) => {
      onExit(await runAlignAlias(options, deps));
    });
}
