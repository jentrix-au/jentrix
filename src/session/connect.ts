/** Session connect. */
import {
  type SessionStartFlags,
  type SessionCommandDeps,
  type SessionAttachFlags,
} from "./deps";
import {
  refuseProjectScope,
  inspectCheckout,
  withCaller,
  stacksBaseUrlOf,
  reportError,
} from "./runtime";
import {
  hostAuthOf,
  launchHost,
  warnIfBoundNotRecording,
  captureSubmission,
  skeletonSubmission,
  readLiveHostMarker,
  launchHostDetached,
  warnAttachedWithoutCapture,
} from "./host-control";
import { EXIT_CODES } from "../errors";
import {
  callStructured as call,
  UsageError,
  callStructured,
} from "../tool-client";
import { requireFolderBinding } from "../binding";
import { randomUUID } from "node:crypto";
import {
  readClaudeHookContext,
  readCodexHookContext,
  readClaudeHookTranscript,
  readCodexRolloutPath,
  hooksDir,
} from "./provider-context";

export async function runSessionStart(
  provider: "claude" | "codex",
  flags: SessionStartFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  // Unsupported launch must be inert even with --resume or a broken config.
  if (provider === "codex") {
    deps.writeErr(
      "CODEX_LAUNCH_UNAVAILABLE: start Codex normally, then run `jentrix session connect --provider codex`.",
    );
    return EXIT_CODES.INVALID_INPUT;
  }
  if (refuseProjectScope(flags.project, deps)) return EXIT_CODES.INVALID_INPUT;
  try {
    const inspection = await inspectCheckout(deps);
    const installationId = deps.ensureInstallationId();
    return await withCaller(deps, async (caller, target) => {
      let sessionId: string;
      let resumeProviderSessionId: string | null = null;
      if (flags.resume) {
        const session = await call(caller, "get_agent_session", {
          sessionId: flags.resume,
        });
        if (session.provider !== provider) {
          throw new UsageError(
            `SESSION_RESUME_CONFLICT: session ${flags.resume} belongs to provider ${String(session.provider)}`,
          );
        }
        const resumed = await call(caller, "resume_agent_session", {
          sessionId: flags.resume,
          repoOwnerName: inspection.repoOwnerName,
          expectedUpdatedAt: session.updatedAt,
        });
        sessionId = String(resumed.id);
        resumeProviderSessionId =
          typeof session.providerSessionId === "string"
            ? session.providerSessionId
            : null;
        deps.writeOut(`Resuming session ${sessionId}`);
      } else {
        // Client-runtime v2 (§16.1): the session's durable scope is the
        // FOLDER's workspace — no Project, no repo-link gate (the repo is
        // attribution, not access control). Drift fails closed (§11.4).
        const binding = requireFolderBinding(inspection.root, {
          endpoint: target.url,
          repoOwnerName: inspection.repoOwnerName,
        });
        const created = await callStructured(caller, "create_agent_session", {
          workspaceId: binding.workspaceId,
          provider,
          connection: { kind: "local", installationId },
          repoOwnerName: inspection.repoOwnerName,
          startBranch: inspection.branch,
          startHead: inspection.head,
          startDirty: inspection.dirty,
          idempotencyKey: `launch:${randomUUID()}`,
        });
        sessionId = String(created.id);
        deps.writeOut(
          `Jentrix session ${sessionId} · workspace ${binding.workspaceSlug}`,
        );
      }
      // D18: the plan names the credential SOURCE (configPath), or the child
      // env carries it — the plan file itself holds no bearer bytes.
      const auth = hostAuthOf(deps);
      const hostExit = await launchHost(
        deps,
        {
          protocolVersion: 1,
          sessionId,
          provider,
          jentrixBaseUrl: stacksBaseUrlOf(target.url),
          mcpUrl: target.url,
          configPath: auth.configPath,
          repoRoot: inspection.root,
          installationId,
          mode: "launch",
          resumeProviderSessionId,
          spoolRoot: deps.spoolRoot,
        },
        auth.env,
      );
      await warnIfBoundNotRecording(caller, deps, sessionId, hostExit);
      return hostExit;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

/**
 * D16 compatibility: `session attach` is the pre-v2 name for `session
 * connect` — one rename notice, same behavior; retirement is documented in docs/compatibility.md.
 */
export async function runSessionAttach(
  flags: SessionAttachFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  deps.writeErr(
    "note: `jentrix session attach` is now `jentrix session connect` — the old name is a compatibility adapter; see docs/compatibility.md for its retirement boundary.",
  );
  return runSessionConnect(flags, deps);
}

/**
 * `jentrix session connect` (client-runtime v2 §15.3): bind the CURRENT
 * trusted provider session to a Jentrix session scoped by the FOLDER's
 * workspace. Identity, not work alignment — no Project, no task; `session
 * align` anchors work separately. Legacy --project receives a migration refusal.
 */
export async function runSessionConnect(
  flags: SessionAttachFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  if (refuseProjectScope(flags.project, deps)) return EXIT_CODES.INVALID_INPUT;
  try {
    const provider = flags.provider;
    if (!provider) {
      throw new UsageError("--provider claude|codex is required for connect");
    }
    let hookDir: string | null = null;
    if (!flags.providerSession && flags.provider === "claude") {
      // The /jentrix-connect path: the plugin's lifecycle hooks recorded the
      // trusted session context for this checkout.
      const hookContext = readClaudeHookContext(deps);
      if (hookContext) {
        flags.providerSession = hookContext.sessionId;
        if (!flags.transcriptPath && hookContext.transcriptPath) {
          flags.transcriptPath = hookContext.transcriptPath;
        }
      }
    } else if (!flags.providerSession && flags.provider === "codex") {
      const hookContext = readCodexHookContext(deps);
      if (hookContext) {
        flags.providerSession = hookContext.sessionId;
        if (!flags.transcriptPath && hookContext.transcriptPath) {
          flags.transcriptPath = hookContext.transcriptPath;
        }
      }
    } else if (
      flags.provider === "claude" &&
      flags.providerSession &&
      !flags.transcriptPath
    ) {
      // F1c: an explicit id gets the transcript ITS OWN hook record names,
      // from any directory — never the one a cwd match produced for another
      // session. Absent, the attach stays honest ("BOUND BUT NOT RECORDING").
      flags.transcriptPath =
        readClaudeHookTranscript(deps, flags.providerSession) ?? undefined;
    } else if (
      flags.provider === "codex" &&
      flags.providerSession &&
      !flags.transcriptPath
    ) {
      flags.transcriptPath =
        readCodexRolloutPath(deps, flags.providerSession) ?? undefined;
    }
    // JEN-295: BOTH providers hand the host their plugin ledger — that is the
    // only way a watch host ever sees its own session's SessionEnd. The host
    // filters the machine-global file by provider session id.
    hookDir = hooksDir(deps, provider);
    if (!flags.providerSession) {
      // Never guessed from session files (§15.2): the id must come from the
      // provider integration's TRUSTED lifecycle context.
      throw new UsageError(
        "PROVIDER_SESSION_UNAVAILABLE: start the provider normally with trusted lifecycle hooks, then run `jentrix session connect --provider " +
          provider +
          "`; provider identity is never guessed.",
      );
    }
    const inspection = await inspectCheckout(deps);
    const installationId = deps.ensureInstallationId();
    return await withCaller(deps, async (caller, target) => {
      const base = {
        provider: flags.provider,
        connection: { kind: "local", installationId },
        providerSessionId: flags.providerSession,
        repoOwnerName: inspection.repoOwnerName,
        startBranch: inspection.branch,
        startHead: inspection.head,
        startDirty: inspection.dirty,
        importHistory: Boolean(flags.importHistory),
        // Per-invocation NONCE (AGE-961): a stable key froze the FIRST
        // target for its 24h TTL — CONFLICT on same-target replay after a
        // commit and on re-target after `session end`. The server's
        // convergence on (provider, connection, providerSessionId) is the
        // real idempotency; the key only dedupes transport retries.
        // JEN-457: the tri-state submission — a flag sends, absence OMITS, and
        // omission is the only way the server reaches the operator's account
        // default. Same helper the align path uses; no live host exists yet at
        // connect, so there is no observation to send.
        ...(captureSubmission(flags.capture, false, false) !== undefined
          ? { capture: captureSubmission(flags.capture, false, false) }
          : {}),
        ...(skeletonSubmission(flags.skeleton) !== undefined
          ? { skeleton: skeletonSubmission(flags.skeleton) }
          : {}),
        idempotencyKey: `attach:${randomUUID()}`,
      };
      let attached: Record<string, unknown>;
      let scopeLabel: string;
      {
        // v2 (§16.2): folder workspace + trusted provider identity, nothing
        // else — no Project decision, no repo-link gate. Drift fails closed.
        const binding = requireFolderBinding(inspection.root, {
          endpoint: target.url,
          repoOwnerName: inspection.repoOwnerName,
        });
        attached = await callStructured(caller, "attach_agent_session", {
          ...base,
          workspaceId: binding.workspaceId,
        });
        scopeLabel = `workspace ${binding.workspaceSlug}`;
      }
      const sessionId = String(attached.id);
      // JEN-457: the posture the SERVER resolved for this operator — previous
      // value → account CapturePreference → built-in off. An older server that
      // does not answer leaves these undefined and the built-ins apply, which
      // is still the documented default rather than the old TRACE-on.
      const captureMode: "on" | "off" =
        (attached as { capture?: string }).capture === "on" ? "on" : "off";
      const skeletonMode: "on" | "off" =
        (attached as { skeleton?: string }).skeleton === "off" ? "off" : "on";
      const captureSources = (attached.captureSources ?? null) as {
        capture?: string;
        skeleton?: string;
      } | null;
      deps.writeOut(
        `${attached.converged ? "Reconnected to" : "Connected"} Jentrix session ${sessionId} · ${scopeLabel}`,
      );
      const existingHost = readLiveHostMarker(deps, sessionId);
      if (existingHost) {
        deps.writeOut(
          `Session host already running (pid ${existingHost.pid}) — reused; no second host started.`,
        );
        return EXIT_CODES.OK;
      }
      if (
        (flags.provider === "claude" && flags.transcriptPath) ||
        (flags.provider === "codex" && hookDir)
      ) {
        // D18: no bearer in the plan — the config reference (rotation-
        // following) or the child env carries the credential.
        const auth = hostAuthOf(deps);
        const plan = {
          protocolVersion: 1,
          sessionId,
          provider: flags.provider,
          jentrixBaseUrl: stacksBaseUrlOf(target.url),
          mcpUrl: target.url,
          configPath: auth.configPath,
          repoRoot: inspection.root,
          installationId,
          mode: "watch",
          providerSessionId: flags.providerSession,
          ...(flags.transcriptPath
            ? { transcriptPath: flags.transcriptPath }
            : {}),
          ...(hookDir ? { hookDir } : {}),
          // Capture begins at attachment; --import-history tails from byte 0.
          importHistory: Boolean(flags.importHistory),
          // JEN-457: the host starts under the RESOLVED mode. Omitting these
          // is what made every connected session TRACE-on regardless of the
          // operator's own default.
          captureTrace: captureMode === "on",
          collectSkeleton: skeletonMode === "on",
          ...(captureSources?.capture
            ? { captureSource: captureSources.capture }
            : {}),
          spoolRoot: deps.spoolRoot,
        };
        if (flags.watch) {
          const hostExit = await launchHost(deps, plan, auth.env);
          await warnIfBoundNotRecording(caller, deps, sessionId, hostExit);
          return hostExit;
        }
        const pid = await launchHostDetached(deps, sessionId, plan, auth.env);
        if (pid !== null) {
          deps.writeOut(
            [
              captureMode === "on"
                ? `Capture running in the background (host pid ${pid}) — TRACE capture ON ${captureSources?.capture ?? "(built-in)"}.`
                : `Session host running in the background (pid ${pid}) — heartbeats + telemetry; TRACE capture is OFF ${captureSources?.capture ?? "(built-in)"}.`,
              `\`jentrix session status ${sessionId}\` shows local liveness; \`jentrix session end ${sessionId}\` finalizes it.`,
              "Pre-attach history stays out of coverage unless imported through a supported provider surface.",
            ].join("\n"),
          );
          return 0;
        }
      }
      warnAttachedWithoutCapture(deps, sessionId, provider);
      return 0;
    });
  } catch (error) {
    return reportError(captureFlagUnsupported(error, flags), deps);
  }
}

/**
 * JEN-457 — `connect --capture` / `--no-capture` reach the server as fields the
 * app half added in the same change, and the CLI is released separately, so a
 * client can meet a deployment that predates them. The server's own refusal
 * ("Unknown parameter \"capture\" for this tool") is accurate and useless: it
 * names a parameter the operator never typed. Say what actually happened.
 *
 * Only the flags, only that refusal — everything else propagates untouched.
 * The failure is deliberately NOT swallowed: starting a capturing host the
 * server would record as capture-off is a consent defect, not a fallback.
 */
function captureFlagUnsupported(
  error: unknown,
  flags: SessionAttachFlags,
): unknown {
  if (flags.capture === undefined && flags.skeleton === undefined) return error;
  const message = error instanceof Error ? error.message : String(error);
  const field = message.includes('Unknown parameter "capture"')
    ? "--capture/--no-capture"
    : message.includes('Unknown parameter "skeleton"')
      ? "--skeleton/--no-skeleton"
      : null;
  if (!field) return error;
  return new UsageError(
    `${field} at connect needs a Jentrix deployment that supports it, and this one does not (it refused the field). ` +
      "Connect without the flag — your account default decides — or set the posture at Account → Capture.",
  );
}
