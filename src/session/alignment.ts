/** Session alignment. */
import { type SessionAlignFlags, type SessionCommandDeps } from "./deps";
import {
  readClaudeHookContext,
  readCodexHookContext,
  readClaudeHookTranscript,
  readCodexRolloutPath,
  hooksDir,
  transcriptBelongsTo,
  telemetrySourceFor,
  telemetrySourceLines,
} from "./provider-context";
import {
  inspectCheckout,
  withCaller,
  stacksBaseUrlOf,
  reportError,
} from "./runtime";
import {
  readLiveHostMarker,
  isHostCapturing,
  requestUsageFlush,
  captureSubmission,
  skeletonSubmission,
  captureSourceLabel,
  hostAuthOf,
  launchHostDetached,
  warnAttachedWithoutCapture,
} from "./host-control";
import {
  relatedArtifactsOf,
  relatedNoticeOf,
  renderRelatedEvidence,
} from "./related-evidence";
import { writeAlignmentMarker } from "./state";
import { UsageError, callStructured } from "../tool-client";
import { requireFolderBinding } from "../binding";
import { randomUUID } from "node:crypto";
import { resolveTaskId } from "../task-resolution";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { EXIT_CODES } from "../errors";

/**
 * D6 (client-runtime v2 §12.5) — PURE: does this align change the
 * attribution BUCKET? Every bucket change flushes (null↔task, task↔task);
 * a same-task settings update never does. The widened trigger: the old
 * wizard flushed only when a task was ALREADY aligned, so the
 * unaligned→first-task boundary silently charged pre-align spend to the
 * first task.
 */
export function alignChangesBucket(
  currentTaskId: string | null,
  nextTaskId: string | null,
): boolean {
  return (currentTaskId ?? null) !== (nextTaskId ?? null);
}

export async function runSessionAlign(
  flags: SessionAlignFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    if (!flags.task && !flags.sessionLevel) {
      throw new UsageError(
        "one of --task <id-or-key> or --session-level is required — session align anchors work, it never invents it",
      );
    }
    if (flags.task && flags.sessionLevel) {
      throw new UsageError("--task and --session-level are mutually exclusive");
    }
    // Trusted provider identity, exactly the connect rules (P3): hooks or an
    // explicit id — never guessed.
    let provider = flags.provider ?? null;
    let providerSessionId = flags.providerSession ?? null;
    let transcriptPath = flags.transcriptPath ?? null;
    if (!providerSessionId) {
      const claude = provider !== "codex" ? readClaudeHookContext(deps) : null;
      if (claude) {
        provider = "claude";
        providerSessionId = claude.sessionId;
        transcriptPath = transcriptPath ?? claude.transcriptPath ?? null;
      } else if (provider !== "claude") {
        const codex = readCodexHookContext(deps);
        if (codex) {
          provider = "codex";
          providerSessionId = codex.sessionId;
          transcriptPath = transcriptPath ?? codex.transcriptPath ?? null;
        }
      }
    } else if (provider === "claude" && !transcriptPath) {
      transcriptPath = readClaudeHookTranscript(deps, providerSessionId);
    } else if (provider === "codex" && !transcriptPath) {
      transcriptPath = readCodexRolloutPath(deps, providerSessionId);
    }
    if (!provider || !providerSessionId) {
      throw new UsageError(
        "PROVIDER_SESSION_UNAVAILABLE: alignment anchors a LIVE session — run from inside a provider session (plugin hooks), or pass --provider <p> --provider-session <id> from trusted lifecycle context; retroactive ids are never guessed",
      );
    }
    // JEN-295: the plugin ledger rides every plan (see runSessionConnect).
    const hookDir = hooksDir(deps, provider);
    // Narrowed copies for the closure below (`let` bindings widen inside it).
    const boundProvider = provider;
    const boundProviderSessionId = providerSessionId;
    const inspection = await inspectCheckout(deps);
    const installationId = deps.ensureInstallationId();
    return await withCaller(deps, async (caller, target) => {
      // §11.4: the folder binding scopes the session; drift fails closed.
      const binding = requireFolderBinding(inspection.root, {
        endpoint: target.url,
        repoOwnerName: inspection.repoOwnerName,
      });
      // Converge on (or create) the session for this provider thread — the
      // v2 attach shape; the server's plan cap gates creation only (D19).
      const attached = await callStructured(caller, "attach_agent_session", {
        workspaceId: binding.workspaceId,
        provider,
        connection: { kind: "local", installationId },
        providerSessionId,
        repoOwnerName: inspection.repoOwnerName,
        startBranch: inspection.branch,
        startHead: inspection.head,
        startDirty: inspection.dirty,
        idempotencyKey: `attach:${randomUUID()}`,
      });
      const sessionId = String(attached.id);
      const session = await callStructured(caller, "get_agent_session", {
        sessionId,
      });

      const taskId = flags.task
        ? await resolveTaskId(caller, flags.task, binding.workspaceId)
        : null;

      // Capture gates: a live host's actual collection is immutable
      // mid-session (the wizard's exact rules, kept).
      const liveHost = readLiveHostMarker(deps, sessionId);
      const liveCapturing =
        liveHost !== null && isHostCapturing(deps, sessionId, liveHost);
      if (flags.capture === true && liveHost && !liveCapturing) {
        throw new UsageError(
          `cannot turn TRACE capture on: the live session host (pid ${liveHost.pid}) was started without capture — end this session and connect a new one with --capture`,
        );
      }
      if (flags.capture === false && liveCapturing && liveHost) {
        throw new UsageError(
          `cannot turn TRACE capture off: the live session host (pid ${liveHost.pid}) is actively capturing — end the session to stop it`,
        );
      }

      // D6: flush before EVERY attribution-bucket change — null↔task and
      // task↔task alike — never on a same-task settings update.
      const currentTaskId =
        typeof session.taskId === "string" ? session.taskId : null;
      let boundary: "FLUSHED" | "UNFLUSHED" | "NOT_REQUIRED" = "NOT_REQUIRED";
      if (liveHost && alignChangesBucket(currentTaskId, taskId)) {
        const acked = await requestUsageFlush(deps, sessionId);
        boundary = acked ? "FLUSHED" : "UNFLUSHED";
        // `--json` promises a parseable document on stdout, and this line was
        // landing ABOVE it — `jq` and `JSON.parse` both die on it (JEN-457
        // follow-up, observed while verifying an align on prod). Nothing is
        // lost by withholding it there: the SAME fact rides the document as
        // `boundary`, which is the machine-readable form of exactly this
        // sentence. Prose to a human, an enum to a parser — never both to a
        // parser. The unflushed arm still reaches a `--json` caller, because
        // it is a real telemetry-attribution caveat, not decoration.
        if (!flags.json) {
          deps.writeOut(
            acked
              ? "Usage flush acknowledged by the live session host — spend so far is recorded on the previous alignment."
              : "Live session host did not acknowledge the usage flush in time — mid-switch spend stays bounded by one heartbeat window (~30s).",
          );
        }
      }

      const aligned = await callStructured(caller, "align_agent_session", {
        sessionId,
        taskId,
        ...(flags.owner ? { ownerUserId: flags.owner } : {}),
        ...(flags.agent !== undefined
          ? {
              agentLabel: flags.agent || null,
              ...(flags.agentEmoji ? { agentEmoji: flags.agentEmoji } : {}),
            }
          : {}),
        ...(flags.budget === false
          ? { tokenBudget: null }
          : typeof flags.budget === "number"
            ? { tokenBudget: flags.budget }
            : {}),
        ...(captureSubmission(
          flags.capture,
          liveHost !== null,
          liveCapturing,
        ) !== undefined
          ? {
              capture: captureSubmission(
                flags.capture,
                liveHost !== null,
                liveCapturing,
              ),
            }
          : {}),
        ...(skeletonSubmission(flags.skeleton) !== undefined
          ? { skeleton: skeletonSubmission(flags.skeleton) }
          : {}),
        expectedUpdatedAt: session.updatedAt,
      });
      const alignment = aligned.alignment as Record<string, unknown>;
      const captureMode: "on" | "off" =
        (alignment as { capture?: string }).capture === "on" ? "on" : "off";
      const skeletonMode: "on" | "off" =
        (alignment as { skeleton?: string }).skeleton === "off" ? "off" : "on";
      const serverSources = (aligned.captureSources ?? null) as {
        capture?: string;
        skeleton?: string;
      } | null;
      const captureSources = serverSources
        ? {
            capture: captureSourceLabel(
              flags.capture,
              liveHost !== null,
              serverSources.capture,
              liveHost?.captureSource,
            ),
            skeleton: serverSources.skeleton,
          }
        : null;

      // Marker v3 (§12.4): keyed by provider session id, no projectId.
      writeAlignmentMarker(
        deps.configPath,
        inspection.root,
        {
          sessionId,
          workspaceId: binding.workspaceId,
          taskId,
          capture: captureMode,
          ...(captureSources?.capture
            ? { captureSource: captureSources.capture }
            : {}),
          ...(captureSources?.skeleton
            ? { skeletonSource: captureSources.skeleton }
            : {}),
          skeleton: skeletonMode,
          alignedAt: new Date().toISOString(),
        },
        providerSessionId,
      );

      // Taxonomy AC5.1 (D9): the opening-prompt request marker, best-effort.
      try {
        const spoolDir = join(deps.spoolRoot, sessionId);
        mkdirSync(spoolDir, { recursive: true });
        writeFileSync(
          join(spoolDir, "prompt-request.json"),
          JSON.stringify({ requestedAt: new Date().toISOString() }),
          { mode: 0o600 },
        );
      } catch {
        // never block alignment on a spool write
      }

      // Keep the session alive + collect receipts when no host runs yet.
      let hostStarted = false;
      if (
        !liveHost &&
        provider === "claude" &&
        transcriptPath &&
        transcriptBelongsTo(transcriptPath, providerSessionId) === false
      ) {
        deps.writeErr(
          `TRANSCRIPT MISMATCH: ${transcriptPath} does not belong to provider session ${providerSessionId} — no session host was started (a host on a foreign transcript records nothing).`,
        );
      } else if (
        !liveHost &&
        ((provider === "claude" && transcriptPath) ||
          (provider === "codex" && hookDir))
      ) {
        const auth = hostAuthOf(deps);
        const pid = await launchHostDetached(
          deps,
          sessionId,
          {
            protocolVersion: 1,
            sessionId,
            provider,
            jentrixBaseUrl: stacksBaseUrlOf(target.url),
            mcpUrl: target.url,
            configPath: auth.configPath,
            repoRoot: inspection.root,
            installationId,
            mode: "watch",
            providerSessionId,
            ...(transcriptPath ? { transcriptPath } : {}),
            ...(hookDir ? { hookDir } : {}),
            captureTrace: captureMode === "on",
            collectSkeleton: skeletonMode === "on",
            ...(captureSources?.capture
              ? { captureSource: captureSources.capture }
              : {}),
            spoolRoot: deps.spoolRoot,
          },
          auth.env,
        );
        if (pid !== null) {
          hostStarted = true;
          if (!flags.json) {
            deps.writeOut(
              captureMode === "on"
                ? `Capture host running (pid ${pid}) — TRACE capture ON for this session.`
                : `Session host running (pid ${pid}) — heartbeats + telemetry; TRACE capture is OFF.`,
            );
          }
        }
      }
      // JEN-301: an alignment nothing observes must SAY so — connect already
      // does; align printed "Aligned …" over the same silence and the operator
      // learned at `end` (NO TOKEN TELEMETRY). The telemetry source rides this
      // surface too (C2.4): doctor, align and status must not disagree.
      if (!liveHost && !hostStarted) {
        warnAttachedWithoutCapture(deps, sessionId, boundProvider);
      }
      const telemetry = telemetrySourceFor(
        deps,
        boundProvider,
        boundProviderSessionId,
        transcriptPath,
      );

      // Semantic recall (PRD D9/D13): related evidence rides the align
      // result. Passed through VERBATIM in JSON when the server sent it (an
      // older server sends nothing, and nothing is what the caller sees);
      // printed as the `Related evidence:` block otherwise — the thing to
      // read before reading code.
      const relatedArtifacts = relatedArtifactsOf(aligned);
      const relatedNotice = relatedNoticeOf(aligned);
      if (flags.json) {
        // §16.4: the composite result — the locally observed boundary beside
        // the server's own snapshot, never folded into it.
        deps.writeOut(
          JSON.stringify({
            boundary,
            sessionId,
            alignment,
            realigned: Boolean(aligned.realigned),
            captureMode,
            captureSources,
            telemetrySource: telemetry,
            ...(relatedArtifacts !== null
              ? { relatedArtifacts: aligned.relatedArtifacts }
              : {}),
            ...(relatedNotice !== undefined
              ? { relatedArtifactsNotice: relatedNotice }
              : {}),
          }),
        );
      } else {
        const task = (alignment as { task?: { key?: string; title?: string } })
          .task;
        deps.writeOut(
          `Aligned session ${sessionId} → ${
            task ? `${task.key} ${task.title}` : "session-level work"
          } (workspace ${binding.workspaceSlug}).`,
        );
        for (const line of telemetrySourceLines(telemetry)) deps.writeOut(line);
        for (const line of renderRelatedEvidence(
          relatedArtifacts,
          relatedNotice,
        ))
          deps.writeOut(line);
      }
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}
