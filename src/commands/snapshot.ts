/**
 * `jentrix session snapshot` — the compaction hook's handler (2026-08-11 gap
 * report P3).
 *
 * Compaction truncates the model's CONTEXT, not the log: a real compacted
 * transcript dropped 419,184 tokens from context and zero records from disk.
 * So at `PreCompact` every byte about to leave the model's head is still
 * readable — this command copies the un-preserved range into a typed Jentrix
 * artifact before it stops mattering to the running session.
 *
 * It PRESERVES; it does not distil. A Claude Code hook is a command line with
 * a small JSON payload on stdin and NO model turn: it can move bytes and
 * cannot decide what mattered. `/jentrix-checkpoint` is the distillation half,
 * and the two compose — the skill summarizes, this guarantees the raw
 * material still exists when the summary turns out to have missed something.
 *
 * Two failure rules, because this runs inside the operator's `/compact`:
 * it never blocks (every failure is exit 0 with a line on stderr), and it
 * never guesses a session (a wrong binding writes another session's history
 * into this one's record, which is worse than preserving nothing).
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import { inspectRepository } from "../repo";
import { readAlignmentMarker } from "../session/state";
import { runPush, type PushDeps } from "./push";
import {
  readLiveHostMarker,
  type LocalHostMarker,
} from "../session/host-control";

/** Most a single snapshot uploads; the rest waits for the next boundary. */
const MAX_SLICE_BYTES = 1_000_000;

export interface SnapshotFlags {
  event?: string;
  json?: boolean;
}

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  trigger?: string;
}

interface Resolved {
  sessionId: string;
  /** How it was found — recorded in the artifact so provenance is legible. */
  how: string;
}

/**
 * Is this session's operator consented to transcript content leaving the
 * machine? The alignment snapshot is a SERVER-CONFIRMED consent record and
 * `capture: "off"` is disclosed as "typed artifacts only, no transcript" — so
 * a compaction snapshot that uploaded the transcript anyway would violate the
 * record the operator approved. Wrapping the bytes in a typed artifact does
 * not change what the bytes are.
 *
 * The LIVE host's stamp wins over the alignment marker, same rule as AGE-956:
 * the marker says what was agreed, the host says what is actually running, and
 * the honest answer is whichever collects LESS. Unknown reads as OFF —
 * uploading a transcript on a guess is the failure that cannot be undone.
 */
export function captureConsented(
  host: LocalHostMarker | null,
  marker: { capture?: unknown } | null,
): boolean {
  if (host && typeof host.captureTrace === "boolean") return host.captureTrace;
  return marker?.capture === "on";
}

/**
 * Resolve the STACKS session for a hook payload, most provable first.
 *
 * The cwd rung is last on purpose. A hook's cwd is the SESSION's directory,
 * which is not necessarily the aligned checkout — in the reported run they
 * were `~/task-manager` and `~/test-1`, so a cwd-first handler would be a
 * no-op in exactly the sessions that need it. The transcript path, by
 * contrast, is stamped by the host that watches it: an exact match is proof.
 */
export function resolveSnapshotSession(
  payload: HookPayload,
  spoolRoot: string,
  configPath: string,
  repoRoot: string | null,
  readHost: (sessionId: string) => LocalHostMarker | null,
  listSessions: () => string[],
): Resolved | null {
  const transcript = payload.transcript_path;
  if (transcript) {
    for (const sessionId of listSessions()) {
      if (readHost(sessionId)?.transcriptPath === transcript) {
        return {
          sessionId,
          how: `live session host watching ${transcript}`,
        };
      }
    }
  }
  if (repoRoot) {
    // Keyed by the provider session the hook payload NAMES — a checkout can
    // hold several aligned sessions at once, and the marker's own resolution
    // refuses to guess between them.
    const marker = readAlignmentMarker(
      configPath,
      repoRoot,
      payload.session_id ?? null,
    );
    if (marker) {
      return {
        sessionId: marker.sessionId,
        how: payload.session_id
          ? `alignment marker for provider session ${payload.session_id} in ${repoRoot}`
          : `alignment marker for ${repoRoot}`,
      };
    }
  }
  // Deliberately no "newest alignment on this machine" rung: with several
  // checkouts aligned at once that is a coin flip, and mis-filing one
  // session's history under another is worse than preserving nothing.
  void spoolRoot;
  return null;
}

/** Byte offset already preserved for this session, and where to record it. */
function offsetPath(spoolRoot: string, sessionId: string): string {
  return join(spoolRoot, sessionId, "snapshot.json");
}

function readOffset(spoolRoot: string, sessionId: string): number {
  try {
    const parsed = JSON.parse(
      readFileSync(offsetPath(spoolRoot, sessionId), "utf8"),
    ) as { offset?: unknown; artifactId?: unknown };
    return typeof parsed.offset === "number" ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

export async function runSessionSnapshot(
  flags: SnapshotFlags,
  deps: PushDeps,
): Promise<number> {
  // The failure rule up top — never non-zero inside the operator's /compact —
  // has to hold for UNEXPECTED throws too, or they escape to main.ts's
  // generic catch and exit 1 (learned from the 974k-token session of
  // 2026-08-15, where any hook noise reads as "the hook broke my compact").
  try {
    return await snapshotUnguarded(flags, deps);
  } catch (e) {
    deps.writeErr(
      `jentrix session snapshot: unexpected failure — nothing preserved (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
    return 0;
  }
}

async function snapshotUnguarded(
  flags: SnapshotFlags,
  deps: PushDeps,
): Promise<number> {
  let payload: HookPayload;
  try {
    payload = JSON.parse(
      await (deps.readStdin ?? readAllStdin)(),
    ) as HookPayload;
  } catch {
    deps.writeErr(
      "jentrix session snapshot: no hook payload on stdin — this command is driven by a Claude Code compaction hook",
    );
    return 0;
  }
  const event = flags.event ?? payload.hook_event_name ?? "PreCompact";
  const transcript = payload.transcript_path;
  if (!transcript || !existsSync(transcript)) {
    deps.writeErr(
      `jentrix session snapshot (${event}): the hook payload names no readable transcript — nothing preserved`,
    );
    return 0;
  }
  let repoRoot: string | null = null;
  try {
    repoRoot =
      (await inspectRepository(payload.cwd ?? deps.cwd(), deps.git))?.root ??
      null;
  } catch {
    repoRoot = null;
  }
  const resolved = resolveSnapshotSession(
    payload,
    deps.spoolRoot,
    deps.configPath,
    repoRoot,
    (sessionId) => readLiveHostMarker(deps, sessionId),
    () => {
      try {
        return readdirSync(deps.spoolRoot);
      } catch {
        return [];
      }
    },
  );
  if (!resolved) {
    deps.writeErr(
      `jentrix session snapshot (${event}): no aligned Jentrix session could be PROVEN for this transcript — nothing preserved (run /jentrix-align in this session, or push a checkpoint by hand)`,
    );
    return 0;
  }

  const size = statSync(transcript).size;

  // The consent gate. Capture-off sessions get the BOUNDARY recorded and no
  // content: the fact that context was compacted here is the session's own
  // lifecycle metadata (the same category as the RUN_SUMMARY, and exactly what
  // "typed artifacts only" covers), while the transcript itself stays on the
  // operator's disk where compaction leaves it intact.
  //
  // This is a deliberate narrowing of the 2026-08-11 gap report's P3, which
  // proposed pushing the slice unconditionally. That proposal did not account
  // for the capture-off promise in docs/mvp-surface.md, and the promise wins:
  // "don't lose it" is still satisfied locally (compaction truncates the
  // model's context, never the file), and an operator who wants the bytes
  // ingested has an existing, disclosed way to say so — `jentrix align
  // --capture`.
  if (
    !captureConsented(
      readLiveHostMarker(deps, resolved.sessionId),
      repoRoot
        ? readAlignmentMarker(
            deps.configPath,
            repoRoot,
            payload.session_id ?? null,
          )
        : null,
    )
  ) {
    const body = [
      `# Context compaction boundary (${event})`,
      "",
      "The model's context was compacted here. The transcript was **not preserved**",
      'to Jentrix: capture is off for this session (`capture: "off"` in the alignment',
      "snapshot means typed artifacts only, no transcript), and a compaction snapshot",
      "does not get to widen that consent.",
      "",
      "The bytes are NOT lost — compaction truncates the model's context, not the log,",
      "so the full transcript is still on the machine that ran the session.",
      "",
      "To carry the meaning forward, run **/jentrix-checkpoint** (a model turn that",
      "distils decisions, open questions and next steps — the half a hook cannot do).",
      "To have transcripts ingested at all, align with `jentrix session align --task <id-or-key> --capture`.",
      "",
      `- provider session: ${payload.session_id ?? "unknown"}`,
      `- transcript (local only): ${transcript}`,
      `- transcript size at the boundary: ${size} bytes`,
      `- session resolved via: ${resolved.how}`,
      payload.trigger ? `- compaction trigger: ${payload.trigger}` : null,
    ]
      .filter((line) => line !== null)
      .join("\n");
    // JEN-298: a compaction boundary is a RECORD of what happened (LOG), not
    // an output. Pushed as `report` it classified as output and satisfied the
    // review-readiness "≥1 output or gap" check on its own — one /compact made
    // a session that produced nothing read review-ready, twice (PreCompact and
    // PostCompact each record one).
    await runPush(
      "log",
      undefined,
      {
        session: resolved.sessionId,
        title: `Context compaction boundary (${event}) — transcript not preserved (capture off)`,
        json: flags.json,
      },
      { ...deps, readStdin: async () => body },
    );
    // No offset is advanced: nothing was preserved, so there is nothing to
    // resume from, and every later boundary is its own record.
    return 0;
  }

  const from = readOffset(deps.spoolRoot, resolved.sessionId);
  if (size <= from) {
    deps.writeErr(
      `jentrix session snapshot (${event}): nothing new since the last snapshot (${from} bytes already preserved)`,
    );
    return 0;
  }
  // Preserve the OLDEST un-preserved bytes first: compaction drops the oldest
  // in-context material, so that is what is about to become unreachable. A
  // cap here is a deferral, not a loss — the offset only advances over what
  // actually shipped, so the next boundary continues from the same place.
  //
  // Read ONLY that range. A near-window session's transcript runs to tens of
  // MB (79MB observed) — a whole-file read is wasted memory and Node refuses
  // strings past ~512MB outright. Byte reads at byte offsets also keep the
  // offset arithmetic honest: string .slice counts UTF-16 code units, which
  // drift from byte offsets on any multibyte content. A multibyte character
  // straddling a boundary renders as a replacement char at the seam; the
  // byte offset stays exact, so nothing is lost across boundaries.
  const sliceLength = Math.min(size - from, MAX_SLICE_BYTES);
  const buffer = Buffer.alloc(sliceLength);
  const fd = openSync(transcript, "r");
  let bytesRead: number;
  try {
    bytesRead = readSync(fd, buffer, 0, sliceLength, from);
  } finally {
    closeSync(fd);
  }
  const slice = buffer.subarray(0, bytesRead).toString("utf8");
  const truncated = size > from + MAX_SLICE_BYTES;
  const header = [
    `# Pre-compaction transcript snapshot (${event})`,
    "",
    `Preserved automatically by the Jentrix plugin's ${event} hook. This is the RAW`,
    "transcript range that was about to leave the model's context — preservation,",
    "not distillation: a hook has no model turn and cannot decide what mattered.",
    "Run /jentrix-checkpoint for the distilled state-of-play.",
    "",
    `- provider session: ${payload.session_id ?? "unknown"}`,
    `- transcript: ${transcript}`,
    `- session resolved via: ${resolved.how}`,
    `- byte range: ${from}–${from + bytesRead} of ${size}`,
    truncated
      ? `- TRUNCATED at ${MAX_SLICE_BYTES} bytes; the remainder is preserved at the next boundary`
      : "- complete range",
    payload.trigger ? `- compaction trigger: ${payload.trigger}` : null,
    "",
    "---",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  // JEN-298: preserved transcript bytes are a record too (LOG) — the same
  // category as the TRACE parts they stand in for, never an output.
  const code = await runPush(
    "log",
    undefined,
    {
      session: resolved.sessionId,
      title: `Pre-compaction snapshot — bytes ${from}–${from + bytesRead}`,
      json: flags.json,
    },
    { ...deps, readStdin: async () => `${header}${slice}` },
  );
  if (code === 0) {
    try {
      writeFileSync(
        offsetPath(deps.spoolRoot, resolved.sessionId),
        JSON.stringify({
          offset: from + bytesRead,
          at: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    } catch {
      // A lost offset re-preserves a range next time: duplicate, never a gap.
    }
  }
  // Never non-zero: a failed snapshot must not break the operator's compact.
  return 0;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function registerSnapshotCommand(
  sessionCommand: Command,
  deps: PushDeps,
  onExit: (code: number) => void,
): void {
  sessionCommand
    .command("snapshot")
    .description(
      "Preserve the un-snapshotted transcript range as a typed artifact (driven by the plugin's PreCompact hook; reads the hook payload on stdin). Preservation only — /jentrix-checkpoint distils.",
    )
    .option("--event <name>", "hook event name (default: from the payload)")
    .option("--json", "stable JSON output")
    .action(async (flags: SnapshotFlags) =>
      onExit(await runSessionSnapshot(flags, deps)),
    );
}
