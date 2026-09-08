/** Session options. */
import { Command, Option } from "commander";

export function addSessionConnectOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        "--provider <provider>",
        "provider of the running session",
      ).choices(["claude", "codex"]),
    )
    .option("--provider-session <id>", "current provider session/thread id")
    .addOption(
      // §15.3: the legacy compatibility shape — parsed, never advertised.
      new Option("--project <id-or-slug>", "removed project scope").hideHelp(),
    )
    .option(
      "--transcript-path <path>",
      "trusted transcript path from the lifecycle hook",
    )
    .option(
      "--import-history",
      "import prior VISIBLE provider history via a supported surface",
    )
    .option(
      "--watch",
      "keep capturing beside the running provider until it ends",
    )
    .option("--capture", "TRACE capture on for this session")
    .option("--no-capture", "TRACE capture off")
    .option("--skeleton", "activity skeleton on")
    .option("--no-skeleton", "activity skeleton off");
}

export function addSessionAlignOptions(command: Command): Command {
  return command
    .option("--task <id-or-key>", "the aligned work item (task id or key)")
    .option("--session-level", 'no task — "session-level work"')
    .option("--owner <user-id>", "accountable human owner (default: you)")
    .option("--agent <label>", "producer label for this session")
    .option("--agent-emoji <emoji>", "emoji shown before the producer label")
    .option("--capture", "TRACE capture on for this session")
    .option("--no-capture", "TRACE capture off")
    .option("--skeleton", "activity skeleton on")
    .option("--no-skeleton", "activity skeleton off")
    .option("--budget <tokens>", "per-session token budget", (v) => Number(v))
    .option("--no-budget", "disarm the token budget")
    .addOption(
      new Option(
        "--provider <provider>",
        "provider of the running session (default: detected from hooks)",
      ).choices(["claude", "codex"]),
    )
    .addOption(
      new Option(
        "--provider-session <id>",
        "current provider session/thread id (trusted lifecycle context)",
      ).hideHelp(),
    )
    .addOption(
      new Option(
        "--transcript-path <path>",
        "trusted transcript path from the lifecycle hook",
      ).hideHelp(),
    )
    .option("--json", "stable JSON output");
}
