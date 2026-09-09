/** Session registration. */
import {
  type SessionCommandDeps,
  type SessionStartFlags,
  type SessionAttachFlags,
  type SessionAlignFlags,
  type SessionDoctorFlags,
} from "../session/deps";
import {
  runSessionStart,
  runSessionConnect,
  runSessionAttach,
} from "../session/connect";
import {
  addSessionConnectOptions,
  addSessionAlignOptions,
} from "./session-options";
import { runSessionAlign } from "../session/alignment";
import { runSessionDoctor } from "../session/doctor";
import { runSessionContact } from "../session/contact";
import { runSessionStatus } from "../session/status";
import { runSessionEnd } from "../session/end";
import { Command, Option } from "commander";

export function registerSessionCommand(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  const session = program
    .command("session")
    .description(
      "Connect, align, inspect, and end coding sessions in the folder workspace.",
    );
  for (const provider of ["claude", "codex"] as const) {
    const launch = session
      .command(provider, { hidden: provider === "codex" })
      .description(
        provider === "claude"
          ? "Start a connected Claude Code session in the folder workspace."
          : "(unsupported) Start Codex normally, then use session connect --provider codex.",
      )
      .addOption(
        new Option(
          "--project <id-or-slug>",
          "removed project scope",
        ).hideHelp(),
      )
      .option(
        "--resume <jentrix-session-id>",
        "resume an eligible interrupted session",
      )
      .action(async (flags: SessionStartFlags) =>
        onExit(await runSessionStart(provider, flags, deps)),
      );
    if (provider === "codex")
      launch.helpOption(false).allowUnknownOption().allowExcessArguments();
  }
  addSessionConnectOptions(
    session
      .command("connect")
      .description(
        "Connect the CURRENT provider session (id from trusted lifecycle context) to a Jentrix session in the folder's workspace — identity only; `session align` anchors work.",
      ),
  ).action(async (flags: SessionAttachFlags) =>
    onExit(await runSessionConnect(flags, deps)),
  );
  addSessionConnectOptions(
    session
      .command("attach", { hidden: true })
      .description("(renamed) — use `jentrix session connect`"),
  ).action(async (flags: SessionAttachFlags) =>
    onExit(await runSessionAttach(flags, deps)),
  );
  addSessionAlignOptions(
    session
      .command("align")
      .description(
        "Anchor THIS session's next work + telemetry to a task (or session level) with an accountable owner — flag-driven, no wizard, no Project.",
      ),
  ).action(async (flags: SessionAlignFlags) =>
    onExit(await runSessionAlign(flags, deps)),
  );
  session
    .command("doctor")
    .description(
      "Preflight credentials, workspace pin, session host, spool, repository, folder binding, and provider capture — read-only.",
    )
    .addOption(
      new Option("--project <id-or-slug>", "removed project scope").hideHelp(),
    )
    .option(
      "--bundle [file]",
      "also write a REDACTED support bundle (versions, install source, marketplace ownership, hook-pin target, contract state, provider status, error categories) — never tokens, transcript content, hook bodies or file contents; you preview it and share it by hand",
    )
    .option("--json", "stable JSON output")
    .action(async (flags: SessionDoctorFlags) =>
      onExit(await runSessionDoctor(flags, deps)),
    );
  session
    .command("status [sessionId]")
    .description(
      "Show a session (or your active sessions), including capture health.",
    )
    .option("--json", "stable JSON output")
    .action(async (sessionId: string | undefined, flags: { json?: boolean }) =>
      onExit(await runSessionStatus(sessionId, flags, deps)),
    );
  // JEN-496 (D11) — "which of these files did this session open?", answered
  // from the local skeleton. Beside `status` because it is the same question
  // about the same session, asked of a different column of the record.
  session
    .command("contact [sessionId]")
    .description(
      "Answer which of the named files this session actually opened, from the local activity skeleton.",
    )
    .option(
      "--paths <a,b,c>",
      "the files to ask about (comma- or space-separated)",
    )
    .option("--json", "stable JSON output")
    .action(
      async (
        sessionId: string | undefined,
        flags: { paths?: string; json?: boolean },
      ) => onExit(await runSessionContact(sessionId, flags, deps)),
    );
  session
    .command("end [sessionId]")
    .description(
      "Close a session, verify capture, and store the RUN_SUMMARY. Pushes the attested delivery patch when HEAD moved, and enforces the evidence-floor checks E1–E4 (refusal names each unmet check and its fix).",
    )
    .option("--json", "stable JSON output")
    .option(
      "--acknowledge-evidence-gaps",
      "close even with unmet evidence-floor checks — each unmet check is stamped MISSING into the summary's Review readiness",
    )
    .action(
      async (
        sessionId: string | undefined,
        flags: { json?: boolean; acknowledgeEvidenceGaps?: boolean },
      ) => onExit(await runSessionEnd(sessionId, flags, deps)),
    );
  // Returned so `session snapshot` can be registered from main.ts — it lives
  // in its own module (it drives `push`), and registering it here would make
  // the session <-> snapshot import cycle real.
  return session;
}
