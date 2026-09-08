/** Session host control. */
import { type SessionCommandDeps } from "./deps";
import {
  UsageError,
  type SessionToolCaller,
  callStructured as call,
} from "../tool-client";
import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CODEX_HOOK_REMEDY } from "./provider-context";

/**
 * D18 — the host's credential channels, NEITHER of which is the plan file:
 * a config-file token rides as `configPath` (the host follows rotations); an
 * env/flag token rides the CHILD'S ENVIRONMENT. The plan itself carries no
 * bearer or refresh-token bytes, ever — `assertPlanCarriesNoSecret` and the
 * packed no-bearer test enforce it.
 */
export function hostAuthOf(deps: SessionCommandDeps): {
  configPath: string | null;
  env: Record<string, string> | undefined;
} {
  const configPath = hostConfigPathOf(deps);
  if (configPath) return { configPath, env: undefined };
  return {
    configPath: null,
    env: { STACKS_TOKEN: deps.resolveTarget().token },
  };
}

/** The D18 guard every plan write runs: refuse rather than persist a secret. */
export function assertPlanCarriesNoSecret(
  plan: Record<string, unknown>,
  deps: Pick<SessionCommandDeps, "resolveTarget">,
): void {
  const serialized = JSON.stringify(plan);
  let token: string | null = null;
  try {
    token = deps.resolveTarget().token;
  } catch {
    token = null;
  }
  if (
    "bearer" in plan ||
    (token && token.length >= 6 && serialized.includes(token))
  ) {
    throw new UsageError(
      "SECRET_IN_PLAN: refusing to write a session-host plan carrying bearer material (D18) — plans carry a config reference; the host resolves credentials itself.",
    );
  }
}

export async function launchHost(
  deps: SessionCommandDeps,
  plan: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<number> {
  const host = deps.resolveSessionHost();
  if (!host) {
    deps.writeErr(
      "SESSION_HOST_MISSING: this install carries no dist/session-host-main.js — reinstall @jentrix/cli (or run `pnpm build` in a source checkout).",
    );
    return 2;
  }
  assertPlanCarriesNoSecret(plan, deps);
  // First launch on a machine has no spool root yet — create it here rather
  // than fail the plan write with ENOENT (the AGE-929 hand-run-mkdir gap).
  mkdirSync(deps.spoolRoot, { recursive: true, mode: 0o700 });
  const planPath = join(
    deps.spoolRoot,
    `plan-${process.pid}-${randomBytes(4).toString("hex")}.json`,
  );
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  try {
    return await deps.runSessionHost(host, planPath, env);
  } finally {
    // The runner unlinks on read; this is the crash fallback.
    try {
      unlinkSync(planPath);
    } catch {
      // already consumed
    }
  }
}

/**
 * Launch the capture host DETACHED — attach without --watch. F-4/AGE-930 was
 * the CLI printing "Capture begins at attachment" with no host process at
 * all; the bind must not require a foreground terminal to also be honest.
 * The plan file is 0600 and the child unlinks it on read, so a crash leaves
 * it only inside the 0700 spool dir. Returns the pid, or null when the
 * runner is missing (the caller then warns BOUND BUT NOT RECORDING).
 */
export async function launchHostDetached(
  deps: SessionCommandDeps,
  sessionId: string,
  plan: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<number | null> {
  const host = deps.resolveSessionHost();
  if (!host) {
    deps.writeErr(
      "SESSION_HOST_MISSING: this install carries no dist/session-host-main.js — reinstall @jentrix/cli (or run `pnpm build` in a source checkout).",
    );
    return null;
  }
  assertPlanCarriesNoSecret(plan, deps);
  const sessionDir = join(deps.spoolRoot, sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const planPath = join(
    deps.spoolRoot,
    `plan-${process.pid}-${randomBytes(4).toString("hex")}.json`,
  );
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  return deps.spawnSessionHostDetached(
    host,
    planPath,
    join(sessionDir, "host.log"),
    env,
  );
}

/**
 * F-4/AGE-930: the bind succeeded but NO local capture host is running — say
 * so at the moment it happens, never a capture claim over a session that
 * records nothing.
 */
export function warnAttachedWithoutCapture(
  deps: Pick<SessionCommandDeps, "writeErr">,
  sessionId: string,
  provider: "claude" | "codex",
): void {
  const reason =
    provider === "claude"
      ? "no trusted transcript path is available for the running session, so nothing is recording locally"
      : "no trusted Codex hook ledger is available, so nothing is recording locally";
  // C2.3/C2.6: one remedy vocabulary. The old Codex wording put the new task
  // BEFORE trusting the hooks, which reads as though trusting them repairs the
  // task you are in — it cannot; hooks load at task start.
  const fix =
    provider === "claude"
      ? "Fix: run /jentrix-connect inside the Claude session (the plugin records the transcript path), or pass --transcript-path from the lifecycle hook."
      : `Fix: install the Codex plugin (\`jentrix plugin install codex\`), then ${CODEX_HOOK_REMEDY}.`;
  deps.writeErr(
    [
      `SESSION BOUND BUT NOT RECORDING: session ${sessionId} is attached server-side, but ${reason}.`,
      fix,
      `\`jentrix session end ${sessionId}\` closes it honestly (the capture gap is recorded).`,
    ].join("\n"),
  );
}

/**
 * AGE-929 (the two-phase gap): the bind can succeed and the local capture leg
 * still die — the server then shows a healthy ACTIVE session while nothing is
 * recording, until the abandonment sweep (~5–10 min). When the host exits
 * nonzero, check the server side and SAY SO loudly, naming the remedy.
 */
export async function warnIfBoundNotRecording(
  caller: SessionToolCaller,
  deps: Pick<SessionCommandDeps, "writeErr">,
  sessionId: string,
  hostExitCode: number,
): Promise<void> {
  if (hostExitCode === 0) return;
  let status: string | null = null;
  try {
    const session = await call(caller, "get_agent_session", { sessionId });
    status = typeof session.status === "string" ? session.status : null;
  } catch {
    return; // unreachable server — the nonzero exit code already reports
  }
  if (status !== "STARTING" && status !== "ACTIVE") return;
  deps.writeErr(
    [
      `SESSION BOUND BUT NOT RECORDING: the local capture host exited (code ${hostExitCode}) while session ${sessionId} is still ${status} on the server.`,
      "The server cannot see the local process — the session will read as healthy until the abandonment sweep interrupts it (~5–10 minutes).",
      `Fix now: \`jentrix session end ${sessionId}\` closes it honestly (the capture gap is recorded), or resume capture with --resume once the sweep marks it INTERRUPTED.`,
    ].join("\n"),
  );
}

export interface LocalHostMarker {
  pid?: number;
  startedAt?: string;
  provider?: string;
  /** How the host attaches (watch/launch) — says nothing about capture. */
  mode?: string;
  /** Whether the host runs TRACE capture — stamped by runner ≥0.4.13 (AGE-956). */
  captureTrace?: boolean;
  /** WHERE that mode came from (JEN-457) — the label to disclose verbatim. */
  captureSource?: string;
  /** False = the transcript path never appeared (AGE-957, runner ≥0.4.14). */
  transcriptSeen?: boolean;
  /**
   * WHICH transcript this host watches (runner ≥0.4.19). The provable link
   * between a compaction hook's payload and a Jentrix session, and the only
   * way to tell "found A transcript" from "found THIS session's".
   */
  transcriptPath?: string;
  /** Stamped by the host after each flush — see the runner's SessionHostMarker. */
  ackedParts?: number;
  lastFlushAt?: string;
  exitedAt?: string;
  exitCode?: number;
}

/**
 * Is the live host ACTUALLY capturing TRACE (AGE-956)? The marker field is
 * authoritative when stamped; a legacy marker (runner ≤0.4.12) infers from
 * spool evidence — part files exist only when capture ran. Marker existence
 * alone must never read as "capturing": align reported capture ON for a
 * heartbeat-only host that way, against the "transcripts are not stored"
 * promise.
 */
export function isHostCapturing(
  deps: Pick<SessionCommandDeps, "spoolRoot">,
  sessionId: string,
  marker: LocalHostMarker,
  listSpool: (dir: string) => string[] = (dir) => readdirSync(dir),
): boolean {
  if (typeof marker.captureTrace === "boolean") return marker.captureTrace;
  try {
    return listSpool(join(deps.spoolRoot, sessionId)).some((name) =>
      /^part-\d{6}\.ndjson$/.test(name),
    );
  } catch {
    return false;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Any local capture evidence for the session: host marker or spool parts. */
export function hasLocalCaptureFootprint(
  deps: Pick<SessionCommandDeps, "spoolRoot">,
  sessionId: string,
): boolean {
  const dir = join(deps.spoolRoot, sessionId);
  try {
    readFileSync(join(dir, "host.json"), "utf8");
    return true;
  } catch {
    // fall through to the part scan
  }
  try {
    return readdirSync(dir).some((name) => /^part-\d{6}\.ndjson$/.test(name));
  } catch {
    return false;
  }
}

/** The session's host.json when a LIVE host holds it on this machine. */
export function readLiveHostMarker(
  deps: Pick<SessionCommandDeps, "spoolRoot" | "isPidAlive">,
  sessionId: string,
): (LocalHostMarker & { pid: number }) | null {
  try {
    const marker = JSON.parse(
      readFileSync(join(deps.spoolRoot, sessionId, "host.json"), "utf8"),
    ) as LocalHostMarker;
    if (marker.exitedAt || typeof marker.pid !== "number") return null;
    return (deps.isPidAlive ?? defaultIsPidAlive)(marker.pid)
      ? (marker as LocalHostMarker & { pid: number })
      : null;
  } catch {
    return null;
  }
}

/**
 * How a live host answered the end request.
 *
 * `refused` is JEN-167: the host asked the server to close, the evidence floor
 * refused (a 409 evaluated before any write), and the host STAYED UP so the
 * comply work still gets recorded. It is not a failed close — relaying the
 * refusal is the whole answer, and completing server-side over the top of a
 * living host would be a race, not a fallback.
 */
type HostEndOutcome =
  { kind: "exited" } | { kind: "refused"; message: string } | { kind: "gone" };

/**
 * Wait for the host to stamp its exit into host.json after an end request, or
 * to write the evidence-floor refusal it survived. `gone` on timeout OR when
 * the pid dies without stamping (a crash) — either way the caller falls back
 * to the direct server-side completion.
 */
export async function waitForHostEnd(
  deps: Pick<SessionCommandDeps, "spoolRoot" | "isPidAlive" | "sleep">,
  sessionId: string,
  pid: number,
  timeoutMs: number,
): Promise<HostEndOutcome> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const dir = join(deps.spoolRoot, sessionId);
  const path = join(dir, "host.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const refusal = readEndRefusal(deps, sessionId);
    if (refusal) return { kind: "refused", message: refusal };
    try {
      const marker = JSON.parse(readFileSync(path, "utf8")) as LocalHostMarker;
      if (marker.exitedAt) return { kind: "exited" };
    } catch {
      // transient read race — keep waiting
    }
    if (!(deps.isPidAlive ?? defaultIsPidAlive)(pid)) return { kind: "gone" };
  }
  return { kind: "gone" };
}

/** The refusal a surviving host left for THIS end request (runner ≥ 0.5.22). */
function readEndRefusal(
  deps: Pick<SessionCommandDeps, "spoolRoot">,
  sessionId: string,
): string | null {
  try {
    const marker = JSON.parse(
      readFileSync(join(deps.spoolRoot, sessionId, "end-refusal.json"), "utf8"),
    ) as { message?: string };
    return typeof marker.message === "string" && marker.message.trim()
      ? marker.message
      : null;
  } catch {
    return null;
  }
}

/** Drop a previous end's refusal so it can never answer the NEXT one. */
export function clearEndRefusal(
  deps: Pick<SessionCommandDeps, "spoolRoot">,
  sessionId: string,
): void {
  try {
    unlinkSync(join(deps.spoolRoot, sessionId, "end-refusal.json"));
  } catch {
    // absent (the normal case) or unremovable — the request's own write wins
  }
}

/**
 * LOCAL capture liveness for `session status` (AGE-929): the fast signal must
 * be local, because the server cannot see the host process. Reads the spool
 * directory this machine's host writes — `host.json` (pid marker) and the
 * part files (when the spool last grew). Returns display lines; empty when
 * this machine holds no spool for the session.
 */
export function localCaptureLines(
  deps: Pick<SessionCommandDeps, "spoolRoot" | "isPidAlive">,
  sessionId: string,
  serverStatus: string,
): string[] {
  const dir = join(deps.spoolRoot, sessionId);
  let marker: LocalHostMarker | null = null;
  try {
    marker = JSON.parse(
      readFileSync(join(dir, "host.json"), "utf8"),
    ) as LocalHostMarker;
  } catch {
    marker = null;
  }
  let newestPartAt: number | null = null;
  let partCount = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^part-\d{6}\.ndjson$/.test(name)) continue;
      partCount += 1;
      const mtime = statSync(join(dir, name)).mtimeMs;
      if (newestPartAt === null || mtime > newestPartAt) newestPartAt = mtime;
    }
  } catch {
    if (!marker) return []; // no spool on this machine — nothing to report
  }
  const open = serverStatus === "STARTING" || serverStatus === "ACTIVE";
  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    return s < 120 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
  };
  // An empty spool is ambiguous — the host's flush stamp disambiguates
  // "nothing captured yet" from "everything captured was acknowledged".
  const grew =
    newestPartAt !== null
      ? `spool last grew ${ago(newestPartAt)}`
      : typeof marker?.ackedParts === "number" && marker.ackedParts > 0
        ? `${marker.ackedParts} part(s) acknowledged server-side${
            marker.lastFlushAt
              ? ` (last flush ${ago(Date.parse(marker.lastFlushAt))})`
              : ""
          }`
        : "spool has no parts yet";
  const alive =
    typeof marker?.pid === "number" && !marker.exitedAt
      ? (deps.isPidAlive ?? defaultIsPidAlive)(marker.pid)
      : false;
  if (alive) {
    const lines = [
      `Local capture: host running (pid ${marker!.pid}) · ${grew}`,
    ];
    // AGE-957: a host whose transcript path never materialized observes
    // NOTHING — no events, no usage receipts. Healthy silence is a lie here.
    if (marker!.transcriptSeen === false) {
      lines.push(
        "  warning: the host has NEVER seen its transcript path — no events or usage are being observed; end the session and re-align to rebind.",
      );
    }
    return lines;
  }
  if (marker?.exitedAt) {
    return [
      `Local capture: host exited (code ${marker.exitCode ?? "?"})${partCount ? ` · local spool retains ${partCount} part(s)` : ""}`,
    ];
  }
  if (marker && open) {
    // Bound server-side, dead locally, no recorded exit — the AGE-929 shape.
    return [
      `Local capture: HOST NOT RUNNING (pid ${marker.pid ?? "?"}, no exit recorded) — the session is bound server-side but nothing is recording locally · ${grew}`,
      `  Fix: \`jentrix session end ${sessionId}\` to close it honestly, or wait for the abandonment sweep (~5–10 min) and resume.`,
    ];
  }
  if (marker || partCount > 0) {
    return [
      `Local capture: no host running${partCount ? ` · local spool retains ${partCount} part(s)` : ""}`,
    ];
  }
  return [];
}

/**
 * The config path a session-host PLAN should follow for bearer rotation —
 * ONLY when the resolved token actually came from that config file. A host
 * following the config while the CLI ran on a `STACKS_TOKEN`/--token
 * credential adopts a DIFFERENT deployment's bearer on its first 401 and
 * halts ("wrong deployment for this bearer?" — observed live 2026-08-26 on a
 * localhost dogfood with the production config beside it). An env/flag token
 * has no rotation to follow; the host then keeps its static snapshot.
 */
export function hostConfigPathOf(deps: SessionCommandDeps): string | null {
  const source = deps.resolveTarget().tokenSource;
  // Absent = an older caller that never reports the source — keep the
  // config-following behavior it was built with.
  return source === undefined || source === "file" ? deps.configPath : null;
}

// ---------------------------------------------------------------------------
// `jentrix session align` — LEVEL 2 alignment (client-runtime v2 §7.3/§15.3):
// anchor the CURRENT session's next work + telemetry to a task (or explicit
// session level) with an accountable owner. Narrow and flag-driven — the
// wizard this replaces asked eight questions and could create Projects,
// boards, tasks, repo links, and .mcp.json files; none of that happens here
// (D14). The capture-knob helpers below moved from the wizard unchanged.
// ---------------------------------------------------------------------------

export function decideCaptureMode(
  requested: boolean | undefined,
  liveCapturing: boolean,
): "off" | "on" {
  if (requested === true) return "on";
  if (requested === false) return "off";
  return liveCapturing ? "on" : "off";
}

/**
 * PURE tri-state submission (capture-settings PRD §5, D3/D4). What the align
 * request actually CARRIES for a knob — `undefined` means "omit the field",
 * which is the only way the server ever reaches the account default. A flag
 * always sends. A LIVE HOST also always sends, because what it is doing is an
 * OBSERVATION, not a default: the snapshot is the consent record of
 * collection actually happening.
 */
export function captureSubmission(
  requested: boolean | undefined,
  liveHost: boolean,
  liveCapturing: boolean,
): "off" | "on" | undefined {
  if (requested === undefined && !liveHost) return undefined;
  return decideCaptureMode(requested, liveCapturing);
}

/** PURE tri-state submission for the skeleton knob (no live-host arm). */
export function skeletonSubmission(
  requested: boolean | undefined,
): "off" | "on" | undefined {
  if (requested === undefined) return undefined;
  return requested ? "on" : "off";
}

/**
 * PURE provenance label for the capture knob (capture-settings D6): the
 * live-host observation the client sent on the operator's behalf is labelled
 * here, where the reason is known; everything else is the server's word.
 */
export function captureSourceLabel(
  requested: boolean | undefined,
  liveHost: boolean,
  serverLabel: string | undefined,
  /**
   * JEN-457 — the provenance the live host was STARTED with, off its own
   * marker. `connect` now resolves the mode through the server's chain before
   * launching, so the host's state is no longer an unattributable fact about a
   * process: it is the operator's own default (or flag), and saying so beats
   * naming the messenger. Absent (older host, or no host) ⇒ "(live host)".
   */
  hostSource?: string,
): string | undefined {
  if (requested === undefined && liveHost) return hostSource ?? "(live host)";
  return serverLabel;
}

/**
 * TPM Slice 2 (AC2.5): write `flush-request.json` into the session's spool
 * dir and wait (bounded) for the live host to delete it — the host deletes
 * the marker only after the server ACKNOWLEDGED the flush heartbeat, so a
 * surviving marker honestly means "not flushed". The end-request.json idiom.
 */
export async function requestUsageFlush(
  deps: Pick<SessionCommandDeps, "spoolRoot" | "sleep">,
  sessionId: string,
  timeoutMs = 6_000,
): Promise<boolean> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const path = join(deps.spoolRoot, sessionId, "flush-request.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({ requestedAt: new Date().toISOString() }),
    );
  } catch {
    return false; // no writable spool dir — nothing a wait would fix
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (!existsSync(path)) return true; // host acked (deleted after a 2xx beat)
  }
  return false;
}
