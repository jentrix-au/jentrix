/** Session status. */
import { type SessionCommandDeps } from "./deps";
import {
  readAlignmentMarker,
  localConnectionKey,
  findAlignmentMarkerForSession,
  readAlignmentMarkerFile,
} from "./state";
import {
  readCurrentProviderHookContext,
  telemetrySourceForSessionRow,
  telemetrySourceLines,
} from "./provider-context";
import { inspectRepository } from "../repo";
import { type SessionToolCaller, callStructured as call } from "../tool-client";
import { withCaller, isRecord, reportError } from "./runtime";
import { hasLocalCaptureFootprint, localCaptureLines } from "./host-control";

/**
 * JEN-296: THIS provider session's aligned Jentrix session for the checkout —
 * the same resolution `push` and `end` use (trusted hook context → alignment
 * marker), so a bare `status` answers the question the plugin commands ask.
 * Null when unknown; an ambiguous provider context is not a status failure.
 */
export async function ownAlignedSessionId(
  deps: SessionCommandDeps,
): Promise<string | null> {
  try {
    const inspection = await inspectRepository(deps.cwd(), deps.git);
    if (!inspection) return null;
    return (
      readAlignmentMarker(
        deps.configPath,
        inspection.root,
        readCurrentProviderHookContext(deps)?.sessionId ?? null,
      )?.sessionId ?? null
    );
  } catch {
    return null;
  }
}

/**
 * JEN-296: the one line /jentrix-plan, /jentrix-end, /jentrix-review and
 * /jentrix-checkpoint read — the aligned task, its board and column (the
 * snapshot names the task; the board lives on the task row, and the plan
 * command needs the board id to read the real columns), owner and producer.
 */
async function alignmentLine(
  caller: SessionToolCaller,
  alignment: {
    task?: { id: string; key: string; title: string } | null;
    owner?: { name?: string | null; email?: string } | null;
    agent?: { label?: string | null } | null;
  } | null,
): Promise<string> {
  if (!alignment) {
    return "Aligned: — (not aligned — /jentrix-align, or `jentrix session align --task <id-or-key>`)";
  }
  const who = `owner ${alignment.owner?.name ?? alignment.owner?.email ?? "?"}${
    alignment.agent?.label ? ` · agent ${alignment.agent.label}` : ""
  }`;
  if (!alignment.task) return `Aligned: session-level work (no task) · ${who}`;
  let board = "";
  try {
    const task = await call(caller, "get_task", { taskId: alignment.task.id });
    board = `${
      task.boardName || task.boardId
        ? ` · board ${String(task.boardName ?? "?")} (${String(task.boardId ?? "?")})`
        : ""
    }${task.columnName ? ` · column ${String(task.columnName)}` : ""}`;
  } catch {
    // The task line stands on its own; the board is a convenience.
  }
  return `Aligned: ${alignment.task.key} ${alignment.task.title}${board} · ${who}`;
}

export async function runSessionStatus(
  sessionId: string | undefined,
  flags: { json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    // JEN-296: bare `status` shows THIS session's aligned session; the
    // machine-wide listing is the fallback when no such alignment exists.
    if (!sessionId) sessionId = (await ownAlignedSessionId(deps)) ?? undefined;
    return await withCaller(deps, async (caller) => {
      if (!sessionId) {
        const workspaces = await call(caller, "list_workspaces", {});
        const rows: Record<string, unknown>[] = [];
        for (const ws of (workspaces.workspaces as Array<{
          id: string;
          slug?: string;
        }>) ?? []) {
          const sessions = await call(caller, "list_agent_sessions", {
            workspaceId: ws.id,
            status: "ACTIVE",
          });
          rows.push(
            ...((sessions.sessions as Record<string, unknown>[]) ?? []).map(
              (row) => ({ ...row, workspaceSlug: ws.slug ?? ws.id }),
            ),
          );
        }
        deps.writeOut(
          flags.json
            ? JSON.stringify({ sessions: rows })
            : rows.length
              ? rows
                  .map((row) => {
                    // captureComplete=false is NORMAL while a session is open
                    // (capture finalizes at close) — only a terminal row with
                    // incomplete capture is debt worth flagging here.
                    const open =
                      row.status === "STARTING" || row.status === "ACTIVE";
                    const captureNote =
                      row.captureComplete === false && !open
                        ? " · capture debt"
                        : "";
                    // v2 sessions carry no Project — name the workspace.
                    const scope = row.projectName
                      ? String(row.projectName)
                      : `workspace ${String(row.workspaceSlug)}`;
                    return `${String(row.id)} · ${String(row.provider)} · ${scope} · ${String(row.status)}${captureNote}`;
                  })
                  .join("\n")
              : "No active connected sessions.",
        );
        return 0;
      }
      const session = await call(caller, "get_agent_session", { sessionId });
      const alignedLine = await alignmentLine(
        caller,
        (session.alignment as Parameters<typeof alignmentLine>[1]) ?? null,
      );
      // Open sessions have captureComplete=false BY DESIGN (capture finalizes
      // at close) — render that as "recording", never as a warning. Only a
      // terminal session with incomplete capture is genuine debt.
      const open = session.status === "STARTING" || session.status === "ACTIVE";
      // F-3/AGE-931: when THIS machine's operator+installation bound the
      // session (connection key matches) and the spool holds nothing at all,
      // "recording" would be a lie the operator discovers only at `end`.
      const operatorId =
        isRecord(session.operator) && typeof session.operator.id === "string"
          ? session.operator.id
          : null;
      const boundHere =
        operatorId !== null &&
        session.providerConnectionId ===
          localConnectionKey(operatorId, deps.ensureInstallationId());
      const deadLocal =
        open && boundHere && !hasLocalCaptureFootprint(deps, sessionId);
      const captureOff =
        (session.alignment as { capture?: string } | null)?.capture === "off";
      const capture = captureOff
        ? "off (MVP alignment — typed artifacts only)"
        : session.captureComplete
          ? "complete"
          : deadLocal
            ? "bound server-side; local capture NOT RUNNING"
            : open
              ? "recording (finalizes when the session ends)"
              : `INCOMPLETE${session.captureError ? ` — ${String(session.captureError)}` : ""}`;
      // Capture settings (D6/S4) — WHERE each effective knob came from. The
      // alignment snapshot stores VALUES only (D5), so the provenance lives in
      // the local marker the resolving align wrote. A session aligned on
      // another machine, or before this round, simply has none: the value is
      // still stated, the source is not invented.
      const inspection = await inspectRepository(deps.cwd(), deps.git);
      const alignMarker = inspection
        ? findAlignmentMarkerForSession(
            readAlignmentMarkerFile(deps.configPath, inspection.root),
            sessionId,
          )
        : null;
      const captureProvenance = alignMarker?.captureSource
        ? ` · resolved from ${alignMarker.captureSource}`
        : "";
      const skeletonProvenance = alignMarker?.skeletonSource
        ? ` · resolved from ${alignMarker.skeletonSource}`
        : "";
      const local = deadLocal
        ? [
            "Local capture: NOT RUNNING — this machine bound the session but no capture host ever started here (no host marker, no spool parts).",
            `  Fix: \`jentrix session end ${sessionId}\` closes it honestly (the capture gap is recorded), or reattach with a transcript path to start capture.`,
          ]
        : localCaptureLines(deps, sessionId, String(session.status));
      // F1c/F3: telemetry is the axis the MVP kept when it dropped
      // transcripts, so `status` states it — a session whose host has been
      // running for 20 minutes with nothing attributed is repairable NOW and
      // unrepairable after the close.
      const provider = session.provider === "codex" ? "codex" : "claude";
      const telemetry = telemetryVerdict(
        String(session.id),
        session.usage,
        hasLocalCaptureFootprint(deps, sessionId),
        provider,
      );
      // W2/C2.1 — WHERE the telemetry comes from, decided from the hook
      // ledger's record for this session. `COMPLETE` above is a verdict on
      // token receipts; this is the verdict on everything else, and the two
      // are printed together so neither can be read as the other.
      const source = telemetrySourceForSessionRow(
        deps,
        provider,
        typeof session.providerSessionId === "string"
          ? session.providerSessionId
          : null,
      );
      deps.writeOut(
        flags.json
          ? JSON.stringify(session)
          : [
              `Session ${String(session.id)} · ${String(session.provider)} · ${String(session.status)}`,
              // v2 sessions carry no Project (Project is a task label).
              session.projectId
                ? `Project: ${String(session.projectName)} (${String(session.projectId)})`
                : `Workspace: ${String(session.workspaceId)}`,
              `Repository: ${String(session.repoOwnerName)}`,
              alignedLine,
              `Capture: ${capture}${captureProvenance}`,
              // Evidence floor (D3): the skeleton mode the alignment declared.
              `Skeleton: ${
                (session.alignment as { skeleton?: string } | null)
                  ?.skeleton === "off"
                  ? "off (no activity counts, no timing, no files-touched)"
                  : "on (content-free activity counts/timing)"
              }${skeletonProvenance}`,
              ...local,
              telemetry.line,
              ...telemetrySourceLines(source),
              `Summary artifact: ${session.summaryArtifactId ? String(session.summaryArtifactId) : "—"}`,
            ].join("\n"),
      );
      // An OPEN session with no telemetry yet is not news — receipts arrive
      // per turn. Warn only once it is terminal, or once a host has been
      // running long enough that silence is a finding rather than a gap.
      if (telemetry.warning && !open) deps.writeErr(telemetry.warning);
      return 0;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

/**
 * Sessions this MACHINE bound to this CHECKOUT that are still open — the
 * server-derived counterpart of the local alignment marker (AGE-963). A row
 * qualifies only when its repo matches AND its providerConnectionId is this
 * installation's own connection key, so another operator's session on the
 * same repo never resolves here.
 */
export async function activeSessionsBoundHere(
  caller: SessionToolCaller,
  deps: SessionCommandDeps,
  repoOwnerName: string,
): Promise<
  Array<{
    id: string;
    projectId: string | null;
    providerSessionId: string | null;
  }>
> {
  const installationId = deps.ensureInstallationId();
  const found: Array<{
    id: string;
    projectId: string | null;
    providerSessionId: string | null;
  }> = [];
  const workspaces = await call(caller, "list_workspaces", {});
  for (const ws of (workspaces.workspaces as Array<{ id: string }>) ?? []) {
    for (const status of ["ACTIVE", "STARTING"]) {
      const page = await call(caller, "list_agent_sessions", {
        workspaceId: ws.id,
        status,
      });
      for (const row of (page.sessions as Array<Record<string, unknown>>) ??
        []) {
        const operatorId =
          isRecord(row.operator) && typeof row.operator.id === "string"
            ? row.operator.id
            : null;
        if (
          row.repoOwnerName === repoOwnerName &&
          operatorId !== null &&
          row.providerConnectionId ===
            localConnectionKey(operatorId, installationId)
        ) {
          // WHICH provider thread holds it decides everything downstream, and
          // list output omits the thread reference by design (PRD §10.3) — so
          // the detail read is the only way to tell "this session's binding"
          // from "some other session in the same folder". The candidate set is
          // already narrowed to this repo + this installation, so it is a
          // handful of reads, not a scan.
          let providerSessionId: string | null = null;
          try {
            const detail = await call(caller, "get_agent_session", {
              sessionId: String(row.id),
            });
            providerSessionId =
              typeof detail.providerSessionId === "string"
                ? detail.providerSessionId
                : null;
          } catch {
            // Unreadable detail leaves the thread unknown — never a match.
          }
          found.push({
            id: String(row.id),
            projectId: row.projectId ? String(row.projectId) : null,
            providerSessionId,
          });
        }
      }
    }
  }
  return found;
}

/**
 * JEN-494 AC1.7 — the aggregation rule, named ONCE on the line that reports
 * the figures it produced. Before this, a reader had no way to tell a total
 * that counts every transcript record (§4 G1: 1.4–4.4× too high) from one
 * that counts API messages, because both printed the same sentence.
 */
const RECEIPT_RULE = " · receipts: one per API message (last record wins)";

export interface TelemetryVerdict {
  state: "recorded" | "unavailable" | "unattributed" | "no-host";
  /** What WAS recorded, one line — never estimated (F4: the closing fact). */
  line: string;
  /** The loud caveat, or null when telemetry landed. */
  warning: string | null;
}

/**
 * PURE telemetry-attribution verdict (F1c/F3). The MVP turned TRACE capture
 * off and kept TELEMETRY — and telemetry is the part that silently isn't
 * there: `captureStatus: OFF_BY_DESIGN` + exit 0 reads identically whether
 * the four token kinds are null by design or because the host watched
 * another session's transcript. The capture axis has `captureStatus`, exit 8
 * and "SESSION BOUND BUT NOT RECORDING"; this is the same honesty on the
 * telemetry axis.
 *
 * Deliberately carries NO exit code. Exit 8 means capture debt and only that
 * (AGE-965); a capture-off session with unattributed telemetry has no capture
 * debt, and overloading the code would make it mean two things. A wrong
 * binding is also frequently repairable in the NEXT session, which is what a
 * warning is for and an exit code is not.
 */
export function telemetryVerdict(
  sessionId: string,
  usage: unknown,
  hostRan: boolean,
  provider: "claude" | "codex" = "claude",
): TelemetryVerdict {
  const u = isRecord(usage) ? usage : {};
  const num = (key: string) =>
    typeof u[key] === "number" ? (u[key] as number) : null;
  const tokens = {
    in: num("inputTokens"),
    out: num("outputTokens"),
    cacheRead: num("cacheReadTokens"),
    cacheWrite: num("cacheCreationTokens"),
  };
  // D7: the 1-hour subset, named when the receipts carried the split.
  const cacheWrite1h = num("cacheCreation1hTokens");
  const ttlPart = cacheWrite1h === null ? "" : ` (1h ${cacheWrite1h})`;
  const wall = num("wallDurationMs");
  const coverage = typeof u.coverage === "string" ? u.coverage : "UNAVAILABLE";
  const wallPart = wall === null ? "" : ` · wall ${wall}ms`;
  // W2/C2.2: this `coverage` is the server's verdict on TOKEN RECEIPTS and
  // nothing else. Printed bare, an operator reads COMPLETE as "the session
  // was fully captured" — the exact conflation JEN-163 recorded — so the
  // word never appears here without the noun it is true of.
  const coveragePart = ` (token-receipt coverage ${coverage})`;
  if (Object.values(tokens).some((value) => value !== null)) {
    return {
      state: "recorded",
      line: `Telemetry: in ${tokens.in} · out ${tokens.out} · cacheRead ${tokens.cacheRead} · cacheWrite ${tokens.cacheWrite}${ttlPart}${wallPart}${coveragePart}${RECEIPT_RULE}`,
      warning: null,
    };
  }
  if (provider === "codex" && hostRan) {
    return {
      state: "unavailable",
      line: `Telemetry: token usage unavailable — no Codex rollout receipt was observed${wallPart}${coveragePart}`,
      warning: null,
    };
  }
  const line = `Telemetry: no token telemetry was recorded${wallPart}${coveragePart}`;
  return hostRan
    ? {
        state: "unattributed",
        line,
        warning: [
          `NO TOKEN TELEMETRY: a session host ran for ${sessionId} and matched no provider usage receipts — all four token counts are null.`,
          "This is normally a transcript binding: the host reports `transcriptSeen: true` for ANY transcript, so watching another session's file looks healthy and attributes nothing.",
          "Check next time: `jentrix session status` prints the telemetry source while the session is open; align from inside the provider session (the plugin's hooks record the transcript), or pass `jentrix session align --task <id-or-key> --provider-session <id> --transcript-path <file>` when they name the wrong session.",
        ].join("\n"),
      }
    : {
        state: "no-host",
        line,
        warning: `NO TOKEN TELEMETRY: no local session host ever ran for ${sessionId}, so nothing could collect provider usage receipts. Align from inside the provider session (the plugin's hooks record the transcript), or pass --transcript-path.`,
      };
}
