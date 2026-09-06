/**
 * `jentrix session` — connected Claude Code / Codex sessions (M20.1 §8.2/§8.3).
 *
 * The CLI owns identity and repository inspection; the session HOST ships in
 * this same package as the `jentrix-session-host` bin (client-runtime v2 D10)
 * and carries NO provider SDK (G6 — codex launch mode refuses; watch mode is
 * hook/rollout-driven). A launch hands the host a transient plan through a
 * 0600 file that the host unlinks on read; the plan carries the human bearer
 * via the environment only — never argv, never the plan file, never persisted
 * config (AC4/D18).
 *
 * Authority order (client-runtime v2 §11): authenticated operator → folder
 * binding's workspace. The repository is recorded as identity and drift is
 * checked fail-closed; it never grants access. A Project is an optional task
 * label, no longer part of session scope.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { Command, Option } from "commander";

import { readFolderBinding, requireFolderBinding } from "../binding";
import { EXIT_CODES, envelopeOfResult, type McpErrorCode } from "../errors";
import {
  clientChecks,
  doctorBundle,
  type ClientProbeDeps,
} from "./doctor-client";
import { withRateLimitRetry } from "../retry";
import {
  defaultGitRunner,
  inspectRepository,
  type GitRunner,
  type RepoInspection,
} from "../repo";
import { createSessionRedactor } from "../session-host/session-redact";

/** The narrow tool-caller surface (mirrors call.ts's ToolCaller). */
export interface SessionToolCaller {
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Local alignment marker — how `jentrix push` and `jentrix session end` find
// the aligned session for this checkout without a server-side "find by cwd".
// Mode 0600, keyed by repo root hash, next to the CLI config. Defined HERE
// (not align.ts) so `session end` can self-resolve without an import cycle;
// align.ts re-exports for its callers.
//
// mvp-hardening Slice 6: the file holds a MAP keyed by PROVIDER session id,
// not one flat record. Two Claude Code sessions in the same checkout used to
// share one marker — the second `align` overwrote it and both sessions' pushes
// then resolved to whichever wrote last, filing artifacts under the wrong
// session. That is the exact failure the trusted-hook-id design prevents one
// layer up. A v1 (flat) file still READS; it is migrated in place on the next
// write, never rewritten on read.
// ---------------------------------------------------------------------------

export interface AlignmentMarker {
  sessionId: string;
  workspaceId: string;
  /**
   * Client-runtime v2 (§12.4, marker v3): LEGACY only — markers written by
   * the wizard era carry the confirmed project; v2 entries omit it (the
   * workspace is the durable scope). The parser reads both; a new write
   * upgrades only the touched entry.
   */
  projectId?: string;
  taskId: string | null;
  capture: "off" | "on";
  /**
   * Capture settings (capture-settings PRD D6/S4). What the align that wrote
   * this marker RESOLVED, and where each value came from — "(flag)",
   * "(this session)", "(your default)", "(built-in)", in the server's own
   * words. Optional: markers written before this round carry neither, and
   * `session status` then names the value without claiming a source.
   */
  skeleton?: "on" | "off";
  captureSource?: string;
  skeletonSource?: string;
  alignedAt: string;
}

/** The on-disk v2 shape. v1 is the bare `AlignmentMarker` object. */
export interface AlignmentMarkerFile {
  version: 2;
  sessions: Record<string, AlignmentMarker>;
  latest: string;
}

/**
 * The key a migrated v1 entry keeps: the flat file recorded no provider
 * session id, so its entry can only ever be reached through `latest`.
 */
export const LEGACY_MARKER_KEY = "__v1__";

function isMarker(value: unknown): value is AlignmentMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AlignmentMarker).sessionId === "string"
  );
}

/**
 * PURE: on-disk JSON → the v2 shape, accepting v1. Returns null for anything
 * that carries no usable entry (an unreadable or foreign file is "no
 * alignment", never a crash).
 */
export function parseAlignmentMarkerFile(
  raw: unknown,
): AlignmentMarkerFile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<AlignmentMarkerFile>;
  if (candidate.version === 2 && typeof candidate.sessions === "object") {
    const sessions: Record<string, AlignmentMarker> = {};
    for (const [key, value] of Object.entries(candidate.sessions ?? {})) {
      if (isMarker(value)) sessions[key] = value;
    }
    const keys = Object.keys(sessions);
    if (keys.length === 0) return null;
    const latest =
      typeof candidate.latest === "string" && sessions[candidate.latest]
        ? candidate.latest
        : newestKey(sessions);
    return { version: 2, sessions, latest };
  }
  // v1: one flat marker, no provider session id to key it by.
  if (isMarker(raw)) {
    return {
      version: 2,
      sessions: { [LEGACY_MARKER_KEY]: raw },
      latest: LEGACY_MARKER_KEY,
    };
  }
  return null;
}

function newestKey(sessions: Record<string, AlignmentMarker>): string {
  return Object.entries(sessions).sort(
    (a, b) => Date.parse(b[1].alignedAt) - Date.parse(a[1].alignedAt),
  )[0]![0];
}

/**
 * PURE: which entry a caller in provider session `providerSessionId` resolves
 * to.
 *
 * A NAMED provider session resolves its OWN entry and NOTHING else. Falling
 * back to `latest` is what made a checkout look like it holds one alignment: a
 * second Claude Code session in the same folder read the first one's alignment
 * as its own, so its pushes filed there and a re-align re-aligned that session
 * instead of itself; an ended session's key kept resolving to whatever aligned
 * next. The migrated v1 entry is no different — it cannot say whose it is, and
 * a session that CAN name itself must never claim it.
 *
 * An UNNAMED caller resolves nothing. A single entry is not evidence that it
 * belongs to the process asking: STA-74 found a Codex shell silently borrowing
 * the checkout's only marker, which belonged to an active Claude session in a
 * different project. Non-provider shells can still address a task/session
 * explicitly; generic tool calls stay honestly uncorrelated.
 */
export function resolveAlignmentMarker(
  file: AlignmentMarkerFile | null,
  providerSessionId?: string | null,
): AlignmentMarker | null {
  if (!file) return null;
  if (providerSessionId) return file.sessions[providerSessionId] ?? null;
  return null;
}

/** PURE: add/replace one provider session's entry and make it `latest`. */
export function upsertAlignmentMarker(
  file: AlignmentMarkerFile | null,
  providerSessionId: string,
  marker: AlignmentMarker,
): AlignmentMarkerFile {
  const sessions = { ...(file?.sessions ?? {}) };
  // A migrated v1 entry describing the SAME Jentrix session is this alignment,
  // now properly keyed — drop it rather than leaving a shadow copy.
  const legacy = sessions[LEGACY_MARKER_KEY];
  if (legacy && legacy.sessionId === marker.sessionId) {
    delete sessions[LEGACY_MARKER_KEY];
  }
  sessions[providerSessionId] = marker;
  return { version: 2, sessions, latest: providerSessionId };
}

/**
 * PURE: the marker entry describing `sessionId`, whichever provider session
 * key holds it. Capture settings (D6/S4): `session status` needs the align
 * that RESOLVED this session's knobs, and that entry is identified by the
 * session it points at — not by whoever is asking.
 */
export function findAlignmentMarkerForSession(
  file: AlignmentMarkerFile | null,
  sessionId: string,
): AlignmentMarker | null {
  if (!file) return null;
  return (
    Object.values(file.sessions).find((m) => m.sessionId === sessionId) ?? null
  );
}

/** PURE: drop every entry pointing at `sessionId`; null = nothing is left. */
export function removeAlignmentMarkerEntry(
  file: AlignmentMarkerFile | null,
  sessionId: string,
): AlignmentMarkerFile | null {
  if (!file) return null;
  const sessions = Object.fromEntries(
    Object.entries(file.sessions).filter(
      ([, marker]) => marker.sessionId !== sessionId,
    ),
  );
  if (Object.keys(sessions).length === 0) return null;
  return {
    version: 2,
    sessions,
    latest: sessions[file.latest] ? file.latest : newestKey(sessions),
  };
}

export function alignmentMarkerPath(
  configPath: string,
  repoRoot: string,
): string {
  const digest = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, 16);
  return join(dirname(configPath), "alignments", `${digest}.json`);
}

function readAlignmentMarkerFile(
  configPath: string,
  repoRoot: string,
): AlignmentMarkerFile | null {
  try {
    return parseAlignmentMarkerFile(
      JSON.parse(
        readFileSync(alignmentMarkerPath(configPath, repoRoot), "utf8"),
      ),
    );
  } catch {
    return null;
  }
}

function writeAlignmentMarkerFile(
  configPath: string,
  repoRoot: string,
  file: AlignmentMarkerFile,
): void {
  const path = alignmentMarkerPath(configPath, repoRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // TMP + RENAME, never a plain write. `rename(2)` is atomic within a
  // filesystem, so a concurrent reader sees the old file or the new one and
  // never a half-written one — a torn parse returns null from
  // `readAlignmentMarkerFile`, which reads as "this session was never
  // aligned" and is the worse of the two failure modes this file has.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Sync sleep — the marker API is sync throughout and stays that way. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock nobody holds for longer than this is assumed to be a crashed one. */
const MARKER_LOCK_STALE_MS = 5_000;
const MARKER_LOCK_WAIT_MS = 2_000;

/**
 * Read → transform → write the marker map under an exclusive lock.
 *
 * The map holds one entry PER PROVIDER SESSION, and several sessions of one
 * operator share a checkout — the documented use. Both mutations
 * (`writeAlignmentMarker`, `clearAlignmentMarker`) are read-modify-write, so
 * two of them interleaving loses an entry: last writer wins, and the session
 * whose entry vanished looks unaligned until it re-aligns. The network calls
 * that precede each write make the window small, which is why the 2026-09-06
 * three-session test did not hit it — small is not zero, and this is the file
 * every push resolves through.
 *
 * `mkdir` is the lock because it is atomic on every filesystem Node runs on,
 * needs no dependency, and leaves a directory whose mtime dates it.
 *
 * IT NEVER FAILS AN ALIGNMENT. A lock held past the wait budget is broken and
 * the write proceeds: alignment is the operator's anchor for their work, and
 * refusing it because another process is slow would trade a rare lost entry
 * for a common hard stop. Losing the lock costs at most the original race,
 * which tmp+rename already keeps from corrupting anything.
 */
function mutateAlignmentMarkerFile(
  configPath: string,
  repoRoot: string,
  transform: (current: AlignmentMarkerFile | null) => AlignmentMarkerFile | null,
): void {
  const path = alignmentMarkerPath(configPath, repoRoot);
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let held = false;
  const deadline = Date.now() + MARKER_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      // Held by someone. Break a stale one (crashed mid-write), else wait.
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > MARKER_LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // it vanished between the two calls — try to take it
      }
      if (Date.now() >= deadline) break; // proceed unlocked, see the doc above
      sleepSync(25);
    }
  }
  try {
    const next = transform(readAlignmentMarkerFile(configPath, repoRoot));
    if (next === null) {
      rmSync(path, { force: true });
    } else {
      writeAlignmentMarkerFile(configPath, repoRoot, next);
    }
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true });
  }
}

export function readAlignmentMarker(
  configPath: string,
  repoRoot: string,
  providerSessionId?: string | null,
): AlignmentMarker | null {
  return resolveAlignmentMarker(
    readAlignmentMarkerFile(configPath, repoRoot),
    providerSessionId,
  );
}

/**
 * STA-11 — the repo's MOST RECENT alignment, regardless of which provider
 * session made it. This is the wizard's ordering signal only ("this checkout
 * last worked in workspace X"), never a resolution path for pushes — those
 * stay strictly per-session (`resolveAlignmentMarker`).
 */
export function newestAlignmentMarker(
  configPath: string,
  repoRoot: string,
): AlignmentMarker | null {
  const file = readAlignmentMarkerFile(configPath, repoRoot);
  return file ? (file.sessions[file.latest] ?? null) : null;
}

export function writeAlignmentMarker(
  configPath: string,
  repoRoot: string,
  marker: AlignmentMarker,
  providerSessionId?: string | null,
): void {
  // No provider session id (a non-Claude front end) keys the entry by the
  // STACKS session id: still unique per session, still never colliding.
  const key = providerSessionId || marker.sessionId;
  mutateAlignmentMarkerFile(configPath, repoRoot, (current) =>
    upsertAlignmentMarker(current, key, marker),
  );
}

/**
 * AGE-960: a successfully ENDED session must not keep resolving as the
 * checkout's current alignment. Removes only the ENTRIES that still point at
 * the ended session — a concurrent session's alignment in the same checkout
 * survives, and a re-align that already claimed the key is never clobbered by
 * a late end of the previous session. The file itself goes only when it would
 * otherwise be empty.
 */
export function clearAlignmentMarker(
  configPath: string,
  repoRoot: string,
  sessionId: string,
): void {
  mutateAlignmentMarkerFile(configPath, repoRoot, (file) => {
    // Re-read INSIDE the lock: the file this decision is made from must be the
    // one the write lands on, or a concurrent re-align that claimed the key
    // between the two is silently dropped.
    if (!file) return null;
    const next = removeAlignmentMarkerEntry(file, sessionId);
    if (next === null) return null; // the transform's null removes the file
    if (
      Object.keys(next.sessions).length === Object.keys(file.sessions).length
    ) {
      return file; // nothing pointed at this session — write it back unchanged
    }
    return next;
  });
}

export interface SessionCommandDeps {
  env: Record<string, string | undefined>;
  cwd(): string;
  configPath: string;
  /**
   * Resolve {token, url} or throw ConfigError (exit 7 when no token).
   * `tokenSource` says where the token came from — the host's config-following
   * bearer must engage ONLY for a config-file token (see hostConfigPathOf).
   */
  resolveTarget(): {
    token: string;
    url: string;
    tokenSource?: "flag" | "env" | "file";
  };
  ensureInstallationId(): string;
  connect(target: {
    token: string;
    url: string;
    /**
     * STA-26 — the VALIDATED session correlation (from the alignment marker
     * or an explicit --session, never model-authored). When present the
     * transport sends `X-Stacks-Session-Id`, the server validates it in
     * `safe()` (a bearer cannot stamp someone else's session), and every
     * activity payload the call writes carries `sessionId` — which is what
     * lets a minted issue's TASK_CREATED land in the session's RUN_SUMMARY.
     */
    sessionId?: string;
  }): Promise<{ caller: SessionToolCaller; close(): Promise<void> }>;
  git?: GitRunner;
  writeOut(text: string): void;
  writeErr(text: string): void;
  isInteractive: boolean;
  readLine(prompt: string): Promise<string>;
  /**
   * Absolute path of the BUNDLED session-host entry (dist/session-host-main.js
   * — client-runtime v2 D10: the host ships inside this package; nothing to
   * install). Null only when the build is missing (a source checkout that
   * never ran `pnpm --dir cli build`).
   */
  resolveSessionHost(): string | null;
  /**
   * Foreground `jentrix-session-host run --plan-file <path>` (stdio
   * inherit). `env` is merged into the child's environment — the D18 channel
   * for a non-config credential (the plan file itself never carries one).
   */
  runSessionHost(
    hostPath: string,
    planPath: string,
    env?: Record<string, string>,
  ): Promise<number>;
  /**
   * Detached `jentrix-session-host run --plan-file <path>` with stdio to a
   * log file — background capture for attach without --watch (F-4/AGE-930).
   * Returns the child pid. `env` as above (D18).
   */
  spawnSessionHostDetached(
    hostPath: string,
    planPath: string,
    logPath: string,
    env?: Record<string, string>,
  ): number;
  spoolRoot: string;
  /** Injectable fetch for the REST boundaries (attested pushes); default global. */
  fetchImpl?: typeof fetch;
  /** Injectable pid-liveness probe (default: signal-0). */
  isPidAlive?(pid: number): boolean;
  /** Injectable delay for host-exit polling (default: setTimeout). */
  sleep?(ms: number): Promise<void>;
  /**
   * Open-client S5: the client-side probes the doctor reports through —
   * versions and install source, marketplace ownership, hook pinning, the
   * adopted contract. The installer's own resolvers, wired by main.ts; absent
   * in tests that do not exercise them.
   */
  client?: ClientProbeDeps;
}

export interface SessionStartFlags {
  project?: string;
  resume?: string;
  json?: boolean;
}

export interface SessionAttachFlags extends SessionStartFlags {
  provider?: "claude" | "codex";
  providerSession?: string;
  transcriptPath?: string;
  importHistory?: boolean;
  watch?: boolean;
  /**
   * JEN-457 — the per-session capture override, at the only moment it can be
   * made. A host's collection is immutable once it starts, so `align --capture`
   * over a live host started without capture is REFUSED; connect is where the
   * decision belongs. Absent = the server resolves it (account default, then
   * the built-in off).
   */
  capture?: boolean;
  skeleton?: boolean;
}

interface ProjectCandidate {
  id: string;
  name: string;
  slug: string;
  workspace: { id: string; name: string; slug: string };
  repoMatch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Call a tool; an isError envelope becomes a thrown ToolCallError. */
export async function callStructured(
  caller: SessionToolCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return call(caller, name, args);
}

/**
 * STA-116 — the envelope CODE must survive into the thrown error, or every
 * caller reads RATE_LIMITED/INTERNAL as "does not exist". `code` is null when
 * the failure carried no parseable envelope (non-Jentrix server, protocol
 * text).
 */
export class ToolCallError extends Error {
  constructor(
    message: string,
    readonly code: McpErrorCode | null = null,
  ) {
    super(message);
  }
}

async function call(
  caller: SessionToolCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Same RATE_LIMITED policy as the generic path (call.ts): a result carrying
  // a usable retryAfterSeconds sleeps and retries instead of surfacing.
  const result = await withRateLimitRetry(
    () => caller.callTool({ name, arguments: args }),
    {
      maxRetries: 2,
      maxWaitSeconds: 60,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    },
  );
  if (isRecord(result) && result.isError === true) {
    const envelope = envelopeOfResult(result);
    if (envelope) {
      throw new ToolCallError(envelope.error.message, envelope.error.code);
    }
    let message = "tool call failed";
    if (Array.isArray(result.content)) {
      const text = result.content.find(
        (b): b is { type: string; text: string } =>
          isRecord(b) && b.type === "text" && typeof b.text === "string",
      );
      if (text) {
        try {
          const payload = JSON.parse(text.text) as {
            error?: { message?: string };
          };
          message = payload.error?.message ?? text.text;
        } catch {
          message = text.text;
        }
      }
    }
    throw new ToolCallError(message);
  }
  return isRecord(result) && isRecord(result.structuredContent)
    ? (result.structuredContent as Record<string, unknown>)
    : {};
}

export async function inspectCheckout(
  deps: SessionCommandDeps,
): Promise<RepoInspection> {
  const inspection = await inspectRepository(deps.cwd(), deps.git);
  if (!inspection) {
    throw new UsageError(
      "the current directory is not inside a git work tree — run from your project checkout, or make this folder one: git init (then git remote add origin git@github.com:<owner>/<repo>.git)",
    );
  }
  return inspection;
}

export class UsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODES.INVALID_INPUT) {
    super(message);
    this.exitCode = exitCode;
  }
}

type SessionPromptDeps = Pick<
  SessionCommandDeps,
  "isInteractive" | "readLine" | "writeOut" | "writeErr"
>;

/**
 * The ONE interactive confirmation picker (AC7/AC8): a single candidate is
 * preselected but still confirmed, several prompt a numbered choice, and a
 * declined/blank answer cancels with no session created.
 */
async function confirmProjectFromCandidates(
  deps: SessionPromptDeps,
  found: ProjectCandidate[],
  opts: { heading: string; showMatch: boolean },
): Promise<{ projectId: string; projectLabel: string }> {
  if (found.length === 1) {
    const only = found[0]!;
    const answer = await deps.readLine(
      `Project: ${only.name} · Workspace ${only.workspace.name} — start session here? [Y/n] `,
    );
    if (/^(n|no)$/i.test(answer.trim())) {
      throw new UsageError(
        "cancelled before project confirmation — no session was created",
        1,
      );
    }
    return {
      projectId: only.id,
      projectLabel: `${only.name} · ${only.workspace.name}`,
    };
  }
  deps.writeOut(opts.heading);
  found.forEach((candidate, index) => {
    deps.writeOut(
      `  ${index + 1}. ${candidate.name} — workspace ${candidate.workspace.name}${opts.showMatch ? ` (${candidate.repoMatch})` : ""}`,
    );
  });
  const answer = await deps.readLine(
    `Select a project [1-${found.length}, empty cancels]: `,
  );
  const index = Number(answer.trim());
  if (!Number.isInteger(index) || index < 1 || index > found.length) {
    throw new UsageError(
      "cancelled before project confirmation — no session was created",
      1,
    );
  }
  const chosen = found[index - 1]!;
  return {
    projectId: chosen.id,
    projectLabel: `${chosen.name} · ${chosen.workspace.name}`,
  };
}

/**
 * The pinned-credential picker: discovery stays refused server-side (AC45 —
 * never weakened), so the CLI composes a SCOPED candidate list from the pin's
 * own workspace(s) and says so explicitly. The list is every non-archived
 * project inside the pin — repo-link filtering needs unpinned discovery — and
 * the repo link is still checked fail-closed at session create.
 */
async function pickProjectInsidePin(
  caller: SessionToolCaller,
  deps: SessionPromptDeps,
): Promise<{ projectId: string; projectLabel: string }> {
  const workspaces =
    ((await call(caller, "list_workspaces", {})).workspaces as Array<{
      id: string;
      name: string;
      slug: string;
    }>) ?? [];
  const candidates: ProjectCandidate[] = [];
  for (const ws of workspaces) {
    const result = await call(caller, "list_projects", { workspaceId: ws.id });
    for (const project of (result.projects as Array<{
      id: string;
      name: string;
      slug: string;
    }>) ?? []) {
      candidates.push({
        id: project.id,
        name: project.name,
        slug: project.slug,
        workspace: ws,
        repoMatch: "unfiltered",
      });
    }
  }
  const scopeName = workspaces.map((ws) => ws.name).join(", ") || "(none)";
  // AC45: a scoped answer must never read as "no other project uses this
  // repo" — name the pin and state that other workspaces were NOT searched.
  deps.writeOut(
    `Scope: workspace ${scopeName} (workspace-pinned credential) — other workspaces were not searched; projects elsewhere may also use this repository.`,
  );
  deps.writeOut(
    "Showing all projects in the pinned workspace (repo-link filtering needs unpinned discovery); the repo link is still checked at session create.",
  );
  if (candidates.length === 0) {
    throw new UsageError(
      `PROJECT_REQUIRED: no projects exist in workspace ${scopeName} (credential pin). Create a project first, then retry.`,
      1,
    );
  }
  return confirmProjectFromCandidates(deps, candidates, {
    heading: `Projects in workspace ${scopeName}:`,
    showMatch: false,
  });
}

/**
 * Resolve + CONFIRM the project (§8.2 steps 4–5, AC7/AC8/AC45). Every path
 * ends in an explicit choice: cancellation creates no session and invokes no
 * model.
 */
export async function resolveProjectForSession(
  caller: SessionToolCaller,
  deps: SessionPromptDeps,
  repoOwnerName: string,
  projectFlag: string | undefined,
): Promise<{ projectId: string; projectLabel: string }> {
  let candidates: ProjectCandidate[] | null = null;
  try {
    const result = await call(caller, "resolve_projects_for_repo", {
      repoOwnerName,
    });
    candidates = (result.projects as ProjectCandidate[]) ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN")) {
      throw error;
    }
    // Workspace-pinned credential: cross-workspace discovery is refused by
    // design (AC45). An exact --project is validated inside the pin; with no
    // flag, an interactive terminal still gets the normal confirmation picker
    // — scoped to the pin, behind an explicit scope banner.
    if (!projectFlag) {
      if (!deps.isInteractive) {
        throw new UsageError(
          "PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN: this credential is workspace-pinned; non-interactive sessions must pass --project <id> to validate an exact project inside the pin",
          EXIT_CODES.FORBIDDEN,
        );
      }
      return pickProjectInsidePin(caller, deps);
    }
  }

  if (projectFlag) {
    if (candidates) {
      const match = candidates.find(
        (candidate) =>
          candidate.id === projectFlag || candidate.slug === projectFlag,
      );
      if (match) {
        return {
          projectId: match.id,
          projectLabel: `${match.name} · ${match.workspace.name}`,
        };
      }
      // Not among the repo's candidates: the server-side create re-checks the
      // repo link fail-closed (PROJECT_REPO_MISMATCH), so pass the id through.
    }
    return { projectId: projectFlag, projectLabel: projectFlag };
  }

  const found = candidates ?? [];
  if (found.length === 0) {
    throw new UsageError(
      `PROJECT_REQUIRED: no project links repository ${repoOwnerName}. Ask a workspace admin to add the repo link (project settings → Linked items), then retry.`,
      1,
    );
  }
  if (!deps.isInteractive) {
    throw new UsageError(
      `PROJECT_REQUIRED: non-interactive sessions must pass --project. Matching projects: ${found
        .map((candidate) => `${candidate.slug} (${candidate.workspace.slug})`)
        .join(", ")}`,
      1,
    );
  }
  return confirmProjectFromCandidates(deps, found, {
    heading: `Repository ${repoOwnerName} is linked by several projects:`,
    showMatch: true,
  });
}

/**
 * Run a session create/attach call and make PROJECT_REPO_MISMATCH
 * self-service: interactively offer to add the project's REPO link through
 * `add_project_link` (authorization stays in the ops core — workspace ADMIN +
 * admin scope) and retry ONCE; non-interactive callers get the exact command
 * to run instead of a dead end. The retried call reuses the same arguments —
 * a failed create stores nothing in the idempotency cache.
 */
export async function callWithRepoLinkOffer(
  caller: SessionToolCaller,
  deps: SessionPromptDeps,
  name: string,
  args: Record<string, unknown>,
  projectId: string,
  repoOwnerName: string,
): Promise<Record<string, unknown>> {
  try {
    return await call(caller, name, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("PROJECT_REPO_MISMATCH")) throw error;
    const fix = `jentrix tool add_project_link --args '${JSON.stringify({
      projectId,
      targetType: "REPO",
      targetId: repoOwnerName,
    })}'`;
    if (!deps.isInteractive) {
      throw new UsageError(
        `${message}\nAdd the link (workspace ADMIN + admin scope), then retry:\n  ${fix}`,
        EXIT_CODES.CONFLICT,
      );
    }
    const answer = await deps.readLine(
      `Project ${projectId} does not link ${repoOwnerName}. Add the REPO link now (needs workspace ADMIN + admin scope)? [y/N] `,
    );
    if (!/^(y|yes)$/i.test(answer.trim())) {
      throw new UsageError(
        `cancelled — the project does not link ${repoOwnerName}. Add it in project settings → Linked items, or run:\n  ${fix}`,
        1,
      );
    }
    try {
      await call(caller, "add_project_link", {
        projectId,
        targetType: "REPO",
        targetId: repoOwnerName,
      });
    } catch (linkError) {
      const detail =
        linkError instanceof Error ? linkError.message : String(linkError);
      throw new UsageError(
        `could not add the repo link (${detail}). Ask a workspace admin to add it (project settings → Linked items), or run with an admin-scoped login:\n  ${fix}`,
        EXIT_CODES.FORBIDDEN,
      );
    }
    deps.writeOut(
      `Linked ${repoOwnerName} to project ${projectId} — retrying…`,
    );
    return call(caller, name, args);
  }
}

export async function withCaller<T>(
  deps: SessionCommandDeps,
  fn: (
    caller: SessionToolCaller,
    target: { token: string; url: string },
  ) => Promise<T>,
  opts?: { sessionId?: string },
): Promise<T> {
  const target = deps.resolveTarget();
  const { caller, close } = await deps.connect(
    opts?.sessionId ? { ...target, sessionId: opts.sessionId } : target,
  );
  try {
    return await fn(caller, freshTarget(deps, target));
  } finally {
    await close().catch(() => undefined);
  }
}

/**
 * The token to hand the RAW REST legs, re-resolved AFTER connect.
 *
 * `connect` performs the C4.2 OAuth refresh and PERSISTS the rotated pair to
 * the config file, but the `target` it was handed still holds the expired
 * access token. Flows that mix MCP with direct `fetch` — every `jentrix push`,
 * `artifact`, and the issue mint — passed that stale token as their bearer, so
 * the first push after an access token expired failed with a bare
 * `STACKS_LOGIN_REQUIRED` while the MCP half of the SAME command succeeded.
 * The next invocation then read the refreshed token off disk and worked, which
 * makes a deterministic one-shot failure read as a flake and sends the
 * operator to re-login they never needed (observed in the TPM e2e round).
 *
 * Re-reading is the whole fix: the refresh already wrote the answer down.
 * A config file that became unreadable in between falls back to the original
 * target — the same token as before, so this can only ever improve on it.
 */
function freshTarget(
  deps: SessionCommandDeps,
  original: { token: string; url: string },
): { token: string; url: string } {
  try {
    return deps.resolveTarget();
  } catch {
    return original;
  }
}

export function stacksBaseUrlOf(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

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

async function launchHost(
  deps: SessionCommandDeps,
  plan: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<number> {
  const host = deps.resolveSessionHost();
  if (!host) {
    deps.writeErr(
      "SESSION_HOST_MISSING: this install carries no dist/session-host-main.js — reinstall @jentrix/cli (or run `pnpm --dir cli build` in a source checkout).",
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
      "SESSION_HOST_MISSING: this install carries no dist/session-host-main.js — reinstall @jentrix/cli (or run `pnpm --dir cli build` in a source checkout).",
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
function warnAttachedWithoutCapture(
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
      : `Fix: install the Codex plugin (\`jentrix plugin install codex\`), then ${CODEX_HOOK_REMEDY}. \`jentrix session codex\` remains the SDK fallback.`;
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
async function warnIfBoundNotRecording(
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

/**
 * The `local:` connection key a session bound from THIS machine carries —
 * MIRRORS `deriveConnectionKey` in `src/server/agent-sessions/operations.ts`
 * (dependency firewall: the CLI never imports server code; changing either
 * side is a protocol break). Matching it against the session's
 * `providerConnectionId` is what lets `session status` tell "captured on
 * another machine" (silence is correct) from "bound HERE with nothing
 * recording" (silence was the F-3/AGE-931 lie).
 */
export function localConnectionKey(
  operatorUserId: string,
  installationId: string,
): string {
  const digest = createHash("sha256")
    .update(`${operatorUserId}:${installationId}`)
    .digest("hex")
    .slice(0, 32);
  return `local:${digest}`;
}

/** Any local capture evidence for the session: host marker or spool parts. */
function hasLocalCaptureFootprint(
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
async function waitForHostEnd(
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
function clearEndRefusal(
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

export async function runSessionStart(
  provider: "claude" | "codex",
  flags: SessionStartFlags,
  deps: SessionCommandDeps,
): Promise<number> {
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
      } else if (flags.project) {
        // LEGACY shape (compatibility window, §15.3): --project keeps the
        // old Project-derived scope and repo-link check.
        const { projectId, projectLabel } = await resolveProjectForSession(
          caller,
          deps,
          inspection.repoOwnerName,
          flags.project,
        );
        const created = await callWithRepoLinkOffer(
          caller,
          deps,
          "create_agent_session",
          {
            projectId,
            provider,
            connection: { kind: "local", installationId },
            repoOwnerName: inspection.repoOwnerName,
            startBranch: inspection.branch,
            startHead: inspection.head,
            startDirty: inspection.dirty,
            idempotencyKey: `launch:${randomUUID()}`,
          },
          projectId,
          inspection.repoOwnerName,
        );
        sessionId = String(created.id);
        deps.writeOut(`Jentrix session ${sessionId} · ${projectLabel}`);
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
 * A SessionStart with no SessionEnd is not evidence of a LIVE session — the
 * 2026-08-11 gap report found 45 unterminated starts on one machine, the
 * oldest 35 hours dead. Anything whose newest sign of life (the start itself,
 * or its transcript's mtime) is older than this is stale, not current.
 */
const STALE_HOOK_MS = 12 * 60 * 60 * 1000;

export interface ClaudeHookContext {
  sessionId: string;
  transcriptPath: string | null;
  /** One sentence naming HOW this record won — disclosed before submit. */
  basis: string;
  /**
   * A LIVE hook record NEWER than the winner, recorded in a directory this
   * checkout does NOT sit under — the F1 shape (Claude Code launched from
   * one directory, the CLI run in a sibling). Null when unambiguous.
   */
  newerElsewhere: {
    sessionId: string;
    cwd: string;
    startedAt: string | null;
  } | null;
}

interface HookStart {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string;
  at: string | null;
  startedMs: number;
}

/** Default mtime probe: epoch ms, or null when the file is not on disk. */
function transcriptMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** First 64 KiB of a transcript — enough for the first stamped record. */
function readTranscriptHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse the hooks ledger into its SessionStart records plus the newest
 * SessionEnd per session id. Both halves matter: the ledger is append-only,
 * so "is this session still running?" is only answerable by reading the ends.
 */
function parseHookLedger(body: string): {
  starts: HookStart[];
  endedAt: Map<string, number>;
  transcriptBySession: Map<string, string>;
} {
  const starts: HookStart[] = [];
  const endedAt = new Map<string, number>();
  const transcriptBySession = new Map<string, string>();
  for (const line of body.split("\n").filter(Boolean)) {
    let parsed: {
      event?: string;
      at?: string;
      payload?: {
        session_id?: string;
        transcript_path?: string;
        cwd?: string;
      };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    const sessionId = parsed.payload?.session_id;
    if (typeof sessionId !== "string") continue;
    const transcriptPath = parsed.payload?.transcript_path?.trim();
    if (transcriptPath) {
      transcriptBySession.set(sessionId, transcriptPath);
    }
    // A record written before the writer stamped `at`, or with an unparseable
    // one, reads as epoch 0: the transcript's mtime then has to carry the
    // liveness argument on its own, which is the honest fallback.
    const stamped = parsed.at ? Date.parse(parsed.at) : NaN;
    const ms = Number.isNaN(stamped) ? 0 : stamped;
    if (parsed.event === "SessionEnd") {
      endedAt.set(sessionId, Math.max(endedAt.get(sessionId) ?? 0, ms));
    } else if (
      parsed.event === "SessionStart" &&
      typeof parsed.payload?.cwd === "string"
    ) {
      starts.push({
        sessionId,
        transcriptPath: parsed.payload.transcript_path ?? null,
        cwd: parsed.payload.cwd,
        at: parsed.at ?? null,
        startedMs: ms,
      });
    }
  }
  return { starts, endedAt, transcriptBySession };
}

/** Newest transcript the ledger names for one session id, from any directory. */
function transcriptForSessionIn(
  ledger: { transcriptBySession: Map<string, string> },
  sessionId: string,
): string | null {
  return ledger.transcriptBySession.get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// W2 / JEN-163 — the telemetry SOURCE as an explicit three-value fact.
//
// The defect this replaces: `align` reported "host watches trusted Codex
// lifecycle hooks and provider-reported rollout usage" whenever a home
// directory was resolvable. A resolvable home says nothing about whether a
// hook has ever fired — so a session could report COMPLETE token coverage
// while prompts, tool calls, assistant messages and compaction boundaries
// were all silently unrecorded, and the operator read the one as the other.
//
// Decided from the hook LEDGER's record for THIS session, never from a
// directory and never from an installed plugin (C2.1/C2.5). One helper, three
// surfaces (align preconditions, `session status`, `session doctor`) — three
// surfaces that can disagree are three chances to be wrong (C2.4).
// ---------------------------------------------------------------------------

/** Where a connected session's local telemetry actually comes from (C2.1). */
export type TelemetrySource =
  "hooks+rollout" | "rollout-fallback" | "unavailable";

export interface TelemetrySourceFact {
  source: TelemetrySource;
  /** One line naming the source — the SAME words on every surface. */
  detail: string;
  /** What this source cannot record. Empty only when nothing is missing. */
  missing: string[];
  /** The one real remedy for `missing`, or null when nothing is missing. */
  remedy: string | null;
}

/**
 * What a Codex task's lifecycle hooks are the only source of. The rollout
 * carries token receipts and nothing else, so a hookless task is blind to all
 * five of these — and it is exactly this list an operator deserves to read
 * instead of the word COMPLETE (C2.3).
 */
const CODEX_HOOK_ONLY = [
  "prompts",
  "tool calls",
  "assistant messages",
  "final response",
  "compaction boundaries",
];

/**
 * Trusting hooks mid-task changes NOTHING for the task already running —
 * plugins and hooks load at task start. Saying "trust the hooks" without the
 * new task is the advice that looks like a fix and is not one.
 */
const CODEX_HOOK_REMEDY =
  "type `/hooks` at Codex's own prompt (an in-session Codex CLI command, not a shell command), review and trust the Jentrix hooks, then start a NEW task — the trust persists, and hooks load at task start, so it covers tasks started after it";

/**
 * The three-value telemetry source (C2.1). `hookRecord` is whether the LEDGER
 * holds a record for this session; `boundPath` is the exact rollout (Codex) or
 * transcript (Claude) that was bound — never a "latest" substitute, which
 * would manufacture a receipt for a session we did not observe (C2.5).
 *
 * PURE: both inputs are facts the caller already has, so all three cases are
 * directly unit-testable without a filesystem.
 */
export function telemetrySourceFact(
  provider: "claude" | "codex",
  input: { hookRecord: boolean; boundPath: string | null },
): TelemetrySourceFact {
  const { hookRecord, boundPath } = input;
  const source: TelemetrySource = hookRecord
    ? "hooks+rollout"
    : boundPath
      ? "rollout-fallback"
      : "unavailable";
  if (provider === "codex") {
    // Codex splits cleanly: the hook ledger is the ONLY source of the five
    // capabilities above, the rollout the ONLY source of token receipts.
    const missing = [
      ...(hookRecord ? [] : CODEX_HOOK_ONLY),
      ...(boundPath ? [] : ["token receipts"]),
    ];
    return {
      source,
      detail: hookRecord
        ? boundPath
          ? "hooks+rollout — trusted Codex lifecycle hooks recorded this task and its exact rollout is bound"
          : "hooks+rollout — trusted Codex lifecycle hooks recorded this task, but no rollout file is bound for it yet"
        : boundPath
          ? "rollout-fallback — NO Jentrix hook has fired for this task; the exact rollout was resolved from Codex's own sessions directory, so token receipts are the only thing observable"
          : "unavailable — no Jentrix hook record and no rollout for this task, so nothing local can observe it",
      missing,
      remedy: missing.length === 0 ? null : CODEX_HOOK_REMEDY,
    };
  }
  // Claude's transcript carries prompts, tool calls, messages AND receipts;
  // the hook ledger's job is to NAME it. So the hole here is a missing
  // transcript, and the pre-existing no-transcript warning is exactly this
  // `unavailable` case in the shared vocabulary (C2.6).
  if (!boundPath) {
    return {
      source: "unavailable",
      detail:
        "unavailable — no transcript is bound for this session, so nothing local can observe it",
      missing: [...CODEX_HOOK_ONLY, "token receipts"],
      remedy:
        "run `/jentrix-connect` inside the Claude session (the plugin's hooks record the transcript path), or re-align with `--transcript-path <this session's .jsonl>`",
    };
  }
  return {
    source,
    detail: hookRecord
      ? "hooks+rollout — a Jentrix hook record names this session and its transcript is bound"
      : "rollout-fallback — the transcript is bound, but NO Jentrix hook record names this session, so the binding is unattested: a transcript belonging to another session would look exactly like this",
    missing: [],
    remedy: null,
  };
}

/**
 * Does the provider hook LEDGER hold any record for this session id (C2.1)?
 * A SessionStart with no transcript is still a record — the hooks fired, which
 * is the whole question. Never asks whether a home directory exists, never
 * asks whether a plugin is installed.
 */
export function hookLedgerNamesSession(
  deps: Pick<SessionCommandDeps, "env">,
  provider: "claude" | "codex",
  sessionId: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean {
  const dir = hooksDir(deps, provider);
  if (!dir) return false;
  let body: string;
  try {
    body = readFile(join(dir, "hooks.ndjson"));
  } catch {
    return false;
  }
  const { starts, endedAt, transcriptBySession } = parseHookLedger(body);
  return (
    transcriptBySession.has(sessionId) ||
    endedAt.has(sessionId) ||
    starts.some((start) => start.sessionId === sessionId)
  );
}

/**
 * The telemetry source for a SERVER-reported session row (`session status`).
 * Resolves the bound path exactly as align does — the session's OWN rollout
 * (Codex) or the transcript its own hook record names (Claude). Never a
 * "latest" file: a receipt for a session we did not observe is worse than no
 * receipt (C2.5).
 */
export function telemetrySourceForSessionRow(
  deps: Pick<SessionCommandDeps, "env">,
  provider: "claude" | "codex",
  providerSessionId: string | null,
): TelemetrySourceFact {
  const boundPath = providerSessionId
    ? provider === "codex"
      ? readCodexRolloutPath(deps, providerSessionId)
      : readClaudeHookTranscript(deps, providerSessionId)
    : null;
  return telemetrySourceFor(deps, provider, providerSessionId, boundPath);
}

/** Render one telemetry fact as the lines every surface prints (C2.4). */
export function telemetrySourceLines(fact: TelemetrySourceFact): string[] {
  return [
    `Telemetry source: ${fact.detail}`,
    ...(fact.missing.length > 0
      ? [`  NOT recorded: ${fact.missing.join(", ")}`]
      : []),
    ...(fact.remedy ? [`  Fix: ${fact.remedy}`] : []),
  ];
}

/** The telemetry source for one resolved binding — the one call every surface makes. */
export function telemetrySourceFor(
  deps: Pick<SessionCommandDeps, "env">,
  provider: "claude" | "codex",
  sessionId: string | null,
  boundPath: string | null,
  readFile?: (path: string) => string,
): TelemetrySourceFact {
  return telemetrySourceFact(provider, {
    hookRecord: sessionId
      ? hookLedgerNamesSession(deps, provider, sessionId, readFile)
      : false,
    boundPath,
  });
}

/**
 * Claude Code exports its session id into every command it runs. That is the
 * ONE thing the ledger can never derive: the ledger says which sessions exist,
 * the env var says which one is ASKING.
 */
const CLAUDE_SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
const CODEX_THREAD_ENV = "CODEX_THREAD_ID";
const CODEX_SESSION_ENV = "CODEX_SESSION_ID";

export interface ProviderHookContext extends ClaudeHookContext {
  provider: "claude" | "codex";
}

function hooksDir(
  deps: Pick<SessionCommandDeps, "env">,
  provider: "claude" | "codex",
): string | null {
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  return home ? join(home, ".config", "stacks", `${provider}-sessions`) : null;
}

export function codexHooksDir(
  deps: Pick<SessionCommandDeps, "env">,
): string | null {
  return hooksDir(deps, "codex");
}

/** Exact Codex rollout for a trusted task id when plugin hooks did not fire. */
export function readCodexRolloutPath(
  deps: Pick<SessionCommandDeps, "env">,
  sessionId: string,
): string | null {
  const configuredHome = deps.env.CODEX_HOME?.trim() || null;
  const userHome = deps.env.HOME ?? deps.env.USERPROFILE;
  const home = configuredHome ?? (userHome ? join(userHome, ".codex") : null);
  if (!home) return null;
  const root = join(home, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  try {
    const relative = readdirSync(root, {
      encoding: "utf8",
      recursive: true,
    }).find((path) => path.endsWith(suffix));
    return relative ? join(root, relative) : null;
  } catch {
    return null;
  }
}

/**
 * The TRUSTED provider lifecycle context the Claude plugin's hooks recorded
 * (AC17), narrowed to the session that is actually ASKING. Written by
 * `stacks-runner session-hook` from structured hook stdin — never
 * model-authored text. Null when no live hook context exists for this
 * checkout.
 *
 * `CLAUDE_CODE_SESSION_ID` decides FIRST when it is set, and then nothing else
 * gets a vote. Every rung below it is inference from the ledger, and inference
 * keyed on the checkout cannot tell two Claude Code sessions in ONE folder
 * apart: both match the same cwd, so both resolve to whichever started last,
 * and the folder behaves as though it holds a single alignment — the second
 * align re-aligns the first session, and both sessions' pushes land on the
 * newest. Claude Code stamps this id on the process, so each session names
 * ITSELF and concurrent sessions in one checkout stop colliding.
 *
 * The ledger still supplies the TRANSCRIPT for that id (from any directory —
 * `readClaudeHookTranscript`'s rule); a session whose SessionStart hook never
 * ran is identified with no transcript, which is honest and exactly what the
 * "no telemetry" disclosure already covers.
 *
 * Three discriminators, in order, when the env var is absent (2026-08-11 gap
 * report F1). A session with a later SessionEnd is never a candidate. A
 * candidate whose newest sign of life is older than STALE_HOOK_MS is never a
 * candidate — measured against max(start, transcript mtime), because a 20-hour
 * session is current and a 35-hour-abandoned one is not, and only the
 * transcript can tell them apart. Only then does the AGE-957 transcript-exists
 * preference run, WITHIN the survivors: it fixes a different failure (a
 * SessionStart naming a transcript that never materializes) and is orthogonal
 * to this one.
 *
 * cwd containment still selects on that path, because it is the only link
 * between a checkout and a session — but it can be WRONG (Claude Code launched
 * from a sibling directory), and being wrong here silently costs the session
 * its whole telemetry. So the result carries its own `basis` and names any
 * newer live session elsewhere; every caller is expected to disclose both.
 */
export function readClaudeHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  mtimeOf: (path: string) => number | null = transcriptMtime,
  now: () => number = Date.now,
): ClaudeHookContext | null {
  const own = deps.env[CLAUDE_SESSION_ENV]?.trim() || null;
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  let body = "";
  if (home) {
    try {
      body = readFile(
        join(home, ".config", "stacks", "claude-sessions", "hooks.ndjson"),
      );
    } catch {
      // No ledger. Fatal only for the inference path below — an env-named
      // session is still identified, just without a transcript.
    }
  }
  const ledger = parseHookLedger(body);
  const { starts, endedAt } = ledger;
  if (own) {
    const transcriptPath = transcriptForSessionIn(ledger, own);
    return {
      sessionId: own,
      transcriptPath,
      basis: `${CLAUDE_SESSION_ENV}=${own} — this session's own id${
        transcriptPath
          ? " (transcript from its hook record)"
          : " (no hook record names a transcript for it)"
      }`,
      // Nothing to be ambiguous about: the process named itself.
      newerElsewhere: null,
    };
  }
  if (!home || body === "") return null;
  const at = now();
  const live: Array<HookStart & { transcriptMs: number | null }> = [];
  for (const start of starts) {
    const ended = endedAt.get(start.sessionId);
    if (ended !== undefined && ended >= start.startedMs) continue;
    const transcriptMs = start.transcriptPath
      ? mtimeOf(start.transcriptPath)
      : null;
    if (at - Math.max(start.startedMs, transcriptMs ?? 0) > STALE_HOOK_MS) {
      continue;
    }
    live.push({ ...start, transcriptMs });
  }
  const cwd = deps.cwd();
  const matches = live.filter(
    (start) => cwd === start.cwd || cwd.startsWith(`${start.cwd}/`),
  );
  // AGE-957: prefer the newest match whose transcript file EXISTS. A startup
  // can fire two SessionStart hooks seconds apart, and the newest may name a
  // transcript that never materializes — a host launched on it tails ENOENT
  // silently forever (zero events, usage UNAVAILABLE) and the session binds
  // the wrong provider id. Evidence beats recency; newest-overall stays the
  // fallback (a brand-new session may not have written its transcript yet).
  let winner: (HookStart & { transcriptMs: number | null }) | null = null;
  for (let i = matches.length - 1; i >= 0 && !winner; i--) {
    if (matches[i]!.transcriptMs !== null) winner = matches[i]!;
  }
  winner ??= matches[matches.length - 1] ?? null;
  if (!winner) return null;
  const elsewhere = live
    .filter(
      (start) =>
        start.sessionId !== winner.sessionId &&
        !matches.includes(start) &&
        start.startedMs > winner.startedMs,
    )
    .sort((a, b) => b.startedMs - a.startedMs)[0];
  return {
    sessionId: winner.sessionId,
    transcriptPath: winner.transcriptPath,
    basis: `SessionStart${winner.at ? ` at ${winner.at}` : ""} in ${winner.cwd}${
      winner.transcriptMs !== null
        ? " (transcript on disk)"
        : " (transcript not written yet)"
    }`,
    newerElsewhere: elsewhere
      ? {
          sessionId: elsewhere.sessionId,
          cwd: elsewhere.cwd,
          startedAt: elsewhere.at,
        }
      : null,
  };
}

/**
 * Trusted Codex task identity. The process-owned thread/session environment
 * wins; the plugin ledger is the fallback. Unlike the older Claude cwd
 * heuristic, a ledger fallback must have exactly ONE live matching session —
 * Codex has no transcript stamp that could safely break a same-checkout tie.
 */
export function readCodexHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  now: () => number = Date.now,
): ClaudeHookContext | null {
  const threadId = deps.env[CODEX_THREAD_ENV]?.trim() || null;
  const sessionId = deps.env[CODEX_SESSION_ENV]?.trim() || null;
  if (threadId && sessionId && threadId !== sessionId) {
    throw new UsageError(
      `PROVIDER_SESSION_CONFLICT: ${CODEX_THREAD_ENV} and ${CODEX_SESSION_ENV} disagree — refusing to guess which Codex task owns this command`,
    );
  }
  const own = threadId ?? sessionId;
  const dir = hooksDir(deps, "codex");
  let body = "";
  if (dir) {
    try {
      body = readFile(join(dir, "hooks.ndjson"));
    } catch {
      // An environment-named task remains trusted without a ledger record.
    }
  }
  const ledger = parseHookLedger(body);
  const { starts, endedAt } = ledger;
  if (own) {
    const source = threadId ? CODEX_THREAD_ENV : CODEX_SESSION_ENV;
    const hookTranscript = transcriptForSessionIn(ledger, own);
    const transcriptPath = hookTranscript ?? readCodexRolloutPath(deps, own);
    return {
      sessionId: own,
      transcriptPath,
      basis: `${source}=${own} — this Codex task's own id${
        hookTranscript
          ? " (rollout from its hook record)"
          : transcriptPath
            ? " (rollout resolved from Codex sessions)"
            : ""
      }`,
      newerElsewhere: null,
    };
  }
  if (!dir || !body) return null;
  const cwd = deps.cwd();
  const liveIds = new Map<string, HookStart>();
  for (const start of starts) {
    const ended = endedAt.get(start.sessionId);
    if (ended !== undefined && ended >= start.startedMs) continue;
    if (now() - start.startedMs > STALE_HOOK_MS) continue;
    if (cwd !== start.cwd && !cwd.startsWith(`${start.cwd}/`)) continue;
    liveIds.set(start.sessionId, start);
  }
  const matches = [...liveIds.values()];
  if (matches.length > 1) {
    throw new UsageError(
      `PROVIDER_SESSION_AMBIGUOUS: ${matches.length} live Codex tasks match ${cwd} — use the command inside the target Codex task or pass --provider-session explicitly`,
    );
  }
  const match = matches[0];
  return match
    ? {
        sessionId: match.sessionId,
        transcriptPath:
          transcriptForSessionIn(ledger, match.sessionId) ??
          readCodexRolloutPath(deps, match.sessionId),
        basis: `unambiguous SessionStart${match.at ? ` at ${match.at}` : ""} in ${match.cwd}`,
        newerElsewhere: null,
      }
    : null;
}

/** Current trusted provider context for implicit session correlation. */
export function readCurrentProviderHookContext(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
): ProviderHookContext | null {
  const hasCodex = Boolean(
    deps.env[CODEX_THREAD_ENV]?.trim() || deps.env[CODEX_SESSION_ENV]?.trim(),
  );
  const hasClaude = Boolean(deps.env[CLAUDE_SESSION_ENV]?.trim());
  if (hasCodex && hasClaude) {
    throw new UsageError(
      "PROVIDER_SESSION_AMBIGUOUS: both Codex and Claude identify this process — pass the target session explicitly",
    );
  }
  if (hasCodex) {
    const context = readCodexHookContext(deps);
    return context ? { ...context, provider: "codex" } : null;
  }
  if (hasClaude) {
    const context = readClaudeHookContext(deps);
    return context ? { ...context, provider: "claude" } : null;
  }
  const codex = readCodexHookContext(deps);
  const claude = readClaudeHookContext(deps);
  if (codex && claude) {
    throw new UsageError(
      "PROVIDER_SESSION_AMBIGUOUS: live Codex and Claude sessions both match this checkout — run inside the target provider task",
    );
  }
  return codex
    ? { ...codex, provider: "codex" }
    : claude
      ? { ...claude, provider: "claude" }
      : null;
}

/**
 * The transcript the hooks recorded for ONE session id, from any directory
 * (F1c). An explicitly-supplied `--provider-session` fixes the identity; this
 * is how the transcript follows it, instead of the host being launched on
 * whatever file the cwd-keyed resolution happened to name.
 */
export function readClaudeHookTranscript(
  deps: Pick<SessionCommandDeps, "env">,
  sessionId: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | null {
  const home = deps.env.HOME ?? deps.env.USERPROFILE;
  if (!home) return null;
  try {
    return transcriptForSessionIn(
      parseHookLedger(
        readFile(
          join(home, ".config", "stacks", "claude-sessions", "hooks.ndjson"),
        ),
      ),
      sessionId,
    );
  } catch {
    // no ledger — the caller falls back to refusing the host launch
    return null;
  }
}

/**
 * Does this transcript belong to this provider session (F1c)? Claude Code
 * stamps `sessionId` on every record, so the file answers for itself — and it
 * has to, because `transcriptSeen: true` only reports that the host found A
 * transcript, not that it found THIS session's. Watching a foreign one yields
 * a healthy-looking host that matches no receipts and closes at exit 0 with
 * every token count null.
 *
 * Returns null when the file cannot be read or carries no session id at all:
 * unknown is not a mismatch, and refusing on unknown would break every
 * provider whose transcript does not stamp one.
 */
export function transcriptBelongsTo(
  transcriptPath: string,
  sessionId: string,
  // Head only: a transcript runs to hundreds of MB and the stamp is on the
  // first record. Reading the whole file to check one field is the kind of
  // cost that only shows up on someone else's machine.
  readFile: (path: string) => string = readTranscriptHead,
): boolean | null {
  let body: string;
  try {
    body = readFile(transcriptPath);
  } catch {
    return null;
  }
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const stamped = (JSON.parse(line) as { sessionId?: unknown }).sessionId;
      if (typeof stamped === "string") return stamped === sessionId;
    } catch {
      // keep scanning — a truncated tail line is not a verdict
    }
  }
  return null;
}

/**
 * D16 compatibility: `session attach` is the pre-v2 name for `session
 * connect` — one rename notice, same behavior, removed after the window.
 */
export async function runSessionAttach(
  flags: SessionAttachFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  deps.writeErr(
    "note: `jentrix session attach` is now `jentrix session connect` — the old name keeps working for one release window.",
  );
  return runSessionConnect(flags, deps);
}

/**
 * `jentrix session connect` (client-runtime v2 §15.3): bind the CURRENT
 * trusted provider session to a Jentrix session scoped by the FOLDER's
 * workspace. Identity, not work alignment — no Project, no task; `session
 * align` anchors work separately. Legacy `--project` rides the compatibility
 * create path for one D16 window.
 */
export async function runSessionConnect(
  flags: SessionAttachFlags,
  deps: SessionCommandDeps,
): Promise<number> {
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
        "PROVIDER_SESSION_UNAVAILABLE: pass --provider-session <id> from the provider integration (hooks/app-server); retroactive attachment is never guessed. Fallback: start fresh with `jentrix session " +
          flags.provider +
          "`.",
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
      if (flags.project) {
        // LEGACY shape (compatibility window, §15.3).
        const { projectId, projectLabel } = await resolveProjectForSession(
          caller,
          deps,
          inspection.repoOwnerName,
          flags.project,
        );
        attached = await callWithRepoLinkOffer(
          caller,
          deps,
          "attach_agent_session",
          { ...base, projectId },
          projectId,
          inspection.repoOwnerName,
        );
        scopeLabel = projectLabel;
      } else {
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

/**
 * JEN-296: THIS provider session's aligned Jentrix session for the checkout —
 * the same resolution `push` and `end` use (trusted hook context → alignment
 * marker), so a bare `status` answers the question the plugin commands ask.
 * Null when unknown; an ambiguous provider context is not a status failure.
 */
async function ownAlignedSessionId(
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
 * PURE close verdict (AGE-965). A successful close and a failed close used to
 * share exit 1 whenever capture was incomplete, so a script could not tell
 * "closed, with a recorded gap" from "the close did not happen". The gap gets
 * its own code; real failures keep theirs (they never reach here — they throw).
 *
 * `captureStatus` (AGE-958, on BOTH `get_agent_session` and
 * `complete_agent_session`) is the server's own derived verdict and the field
 * a `--json` consumer should read; `captureComplete` + the alignment's capture
 * mode stay the fallback for a server that predates it.
 */
export function sessionCloseVerdict(
  row: { captureStatus?: unknown; captureComplete?: unknown },
  offByDesign: boolean,
): { code: number; capture: string } {
  const status =
    typeof row.captureStatus === "string" ? row.captureStatus : null;
  if (status === "OFF_BY_DESIGN" || (status === null && offByDesign)) {
    // Capture-off is a deliberate mode, never capture debt.
    return { code: EXIT_CODES.OK, capture: "off (typed artifacts only)" };
  }
  const complete =
    status !== null ? status === "COMPLETE" : Boolean(row.captureComplete);
  return complete
    ? { code: EXIT_CODES.OK, capture: "complete" }
    : {
        code: EXIT_CODES.CAPTURE_INCOMPLETE,
        capture: "INCOMPLETE (recorded)",
      };
}

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
      line: `Telemetry: in ${tokens.in} · out ${tokens.out} · cacheRead ${tokens.cacheRead} · cacheWrite ${tokens.cacheWrite}${ttlPart}${wallPart}${coveragePart}`,
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

/** Session evidence floor (PRD §5): the attested-delivery patch cap. */
export const MAX_ATTESTED_DIFF_BYTES = 256 * 1024;

/**
 * Build the attested delivery body for `startHead..endHead` — the REAL git
 * patch, generated by the CLI from the aligned checkout (D4: the server never
 * runs git). Truncates STAT-FIRST: when the full `--patch --stat` output
 * exceeds the 256 KB cap (or git refuses it), the body keeps the commit list
 * + per-file stat and DECLARES the cut. Returns null when the range holds no
 * commits.
 *
 * JEN-171 — the body is a PURE FUNCTION OF THE RANGE. It used to append the
 * dirty tree's uncommitted-delta stat, which is the one part that is not
 * about the attested range at all: between a refused `session end` and its
 * comply-and-retry the working tree moves, the regenerated body differed, and
 * the server's content-identity dedupe correctly saw two artifacts — one
 * range, two attested DIFFs. The stat comes back as `uncommitted` so the end
 * command can still SAY it; the durable dirty fact is the RUN_SUMMARY's own
 * `repo delta: … dirty: true`.
 */
export async function buildAttestedDiffBody(
  git: GitRunner,
  root: string,
  startHead: string,
  endHead: string,
  dirty: boolean,
): Promise<{
  body: string;
  commitCount: number;
  uncommitted: string | null;
} | null> {
  const counted = await git(
    ["rev-list", "--count", `${startHead}..${endHead}`],
    root,
  );
  if (counted.code !== 0) return null;
  const commitCount = Number(counted.stdout.trim());
  if (!Number.isFinite(commitCount) || commitCount === 0) return null;
  const header = [
    "Attested delivery — generated by `jentrix session end` from the aligned checkout (source: cli).",
    `Range: ${startHead}..${endHead} · ${commitCount} commit(s)`,
    "",
  ].join("\n");
  const cap = MAX_ATTESTED_DIFF_BYTES - Buffer.byteLength(header, "utf8");
  const full = await git(
    ["log", "--patch", "--stat", `${startHead}..${endHead}`],
    root,
  );
  let body: string;
  if (full.code === 0 && Buffer.byteLength(full.stdout, "utf8") <= cap) {
    body = full.stdout;
  } else {
    const stat = await git(["log", "--stat", `${startHead}..${endHead}`], root);
    const notice =
      "[truncated stat-first: the full --patch output exceeded the 256 KB attested-diff cap — commit list + per-file stat retained; the full patch lives in git]\n\n";
    let kept = stat.code === 0 ? stat.stdout : "(git log --stat failed)";
    const room = cap - Buffer.byteLength(notice, "utf8");
    if (Buffer.byteLength(kept, "utf8") > room) {
      kept =
        Buffer.from(kept, "utf8")
          .subarray(0, Math.max(0, room - 64))
          .toString("utf8")
          .replace(/�+$/, "") + "\n[stat tail truncated at the cap]";
    }
    body = notice + kept;
  }
  let uncommitted: string | null = null;
  if (dirty) {
    const delta = await git(["diff", "--stat", "HEAD"], root);
    uncommitted =
      delta.code === 0 && delta.stdout.trim() ? delta.stdout.trim() : null;
  }
  return { body: header + body, commitCount, uncommitted };
}

/**
 * POST an ATTESTED typed artifact (D4) to the session's push boundary —
 * redacted locally like every push, `attested: true` so it lands with
 * `source: "cli"`. Best-effort by design: a failed push is reported and the
 * E1 check refuses the close honestly rather than this throwing.
 */
async function postAttestedArtifact(
  deps: SessionCommandDeps,
  sessionId: string,
  input: { kind: "diff" | "log"; title: string; body: string },
): Promise<{ ok: boolean; artifactId: string | null; detail: string | null }> {
  const credentials = deps.resolveTarget();
  try {
    const response = await (deps.fetchImpl ?? fetch)(
      new URL(
        `/api/agent-sessions/${sessionId}/artifacts`,
        stacksBaseUrlOf(credentials.url),
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          kind: input.kind,
          title: input.title,
          body: createSessionRedactor({ env: deps.env }).text(input.body),
          attested: true,
        }),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      artifactId?: string;
      error?: string;
      detail?: string;
    };
    return response.ok
      ? { ok: true, artifactId: payload.artifactId ?? null, detail: null }
      : {
          ok: false,
          artifactId: null,
          detail: payload.detail ?? payload.error ?? `HTTP ${response.status}`,
        };
  } catch (error) {
    return {
      ok: false,
      artifactId: null,
      detail: error instanceof Error ? error.message : "network failure",
    };
  }
}

export async function runSessionEnd(
  sessionIdFlag: string | undefined,
  flags: { json?: boolean; acknowledgeEvidenceGaps?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    const inspection = await inspectRepository(deps.cwd(), deps.git);
    return await withCaller(deps, async (caller) => {
      // AGE-958: bare `session end` resolves the CURRENT session the same way
      // `jentrix push` does — THIS provider session's alignment marker for this
      // checkout. Keyed by the asking session, because a checkout can hold
      // several open sessions at once and closing the newest one instead of
      // your own is not a bare `end`, it is someone else's. AGE-963: the
      // marker is VERIFIED against the server first — a stale marker (session
      // already ended) is reaped and never shadows the live session, and with
      // no usable marker the ACTIVE session this machine bound to this
      // checkout is the fallback.
      const ownThread = readCurrentProviderHookContext(deps)?.sessionId ?? null;
      let resolved = sessionIdFlag;
      if (!resolved && inspection) {
        const marker = readAlignmentMarker(
          deps.configPath,
          inspection.root,
          ownThread,
        );
        if (marker) {
          let markerStatus: string | null = null;
          try {
            const s = await call(caller, "get_agent_session", {
              sessionId: marker.sessionId,
            });
            markerStatus = String(s.status);
          } catch {
            markerStatus = null;
          }
          if (markerStatus === "ACTIVE" || markerStatus === "STARTING") {
            resolved = marker.sessionId;
            deps.writeOut(
              `Ending the aligned session for this checkout: ${resolved}`,
            );
          } else {
            clearAlignmentMarker(
              deps.configPath,
              inspection.root,
              marker.sessionId,
            );
            deps.writeOut(
              `Stale alignment marker cleared (session ${marker.sessionId} ${markerStatus ? `is ${markerStatus}` : "is no longer readable"}).`,
            );
          }
        }
        if (!resolved && inspection.repoOwnerName) {
          const all = await activeSessionsBoundHere(
            caller,
            deps,
            inspection.repoOwnerName,
          );
          // This provider thread's own session wins outright when the server
          // knows one — that is the session the caller is sitting in, however
          // many others share the checkout.
          const own = ownThread
            ? all.filter((s) => s.providerSessionId === ownThread)
            : [];
          const bound = own;
          if (bound.length === 1) {
            resolved = bound[0].id;
            deps.writeOut(`Ending this session: ${resolved}`);
          } else if (ownThread && bound.length > 1) {
            throw new UsageError(
              `several active sessions are bound to this checkout — pass one id to \`jentrix session end <id>\`: ${bound.map((s) => s.id).join(", ")}`,
            );
          } else if (!ownThread && all.length > 0) {
            throw new UsageError(
              "no trusted provider session identifies the caller — pass one id to `jentrix session end <id>`",
            );
          }
        }
      }
      if (!resolved) {
        throw new UsageError(
          "pass the Jentrix session id to end — no aligned session marker for this checkout (run `jentrix session align --task <id-or-key>` first, or find the id with `jentrix session status`, `jentrix agent list-sessions --workspace <id>`, or the workspace's Sessions page)",
        );
      }
      const sessionId: string = resolved;
      // Evidence floor (PRD §5): when HEAD moved in the aligned checkout,
      // generate and push the ATTESTED delivery patch BEFORE anything closes
      // — the E1 check server-side keys on its existence. Best-effort: a
      // failed push is disclosed and the close's refusal names the gap.
      let commitCount: number | null = null;
      try {
        const row = await call(caller, "get_agent_session", { sessionId });
        const startHead =
          typeof row.startHead === "string" ? row.startHead : null;
        const attestRepo =
          inspection && inspection.repoOwnerName === row.repoOwnerName
            ? inspection
            : null;
        if (
          attestRepo?.head &&
          startHead &&
          attestRepo.head !== startHead &&
          (row.status === "ACTIVE" || row.status === "STARTING")
        ) {
          const built = await buildAttestedDiffBody(
            deps.git ?? defaultGitRunner,
            attestRepo.root,
            startHead,
            attestRepo.head,
            attestRepo.dirty,
          );
          if (built) {
            commitCount = built.commitCount;
            const pushed = await postAttestedArtifact(deps, sessionId, {
              kind: "diff",
              title: `Attested diff ${startHead.slice(0, 10)}..${attestRepo.head.slice(0, 10)} (${built.commitCount} commit${built.commitCount === 1 ? "" : "s"})`,
              body: built.body,
            });
            if (pushed.ok) {
              deps.writeOut(
                `Attested diff pushed → artifact ${pushed.artifactId ?? "(unknown)"} (${built.commitCount} commit(s), source: cli)`,
              );
              // JEN-171: said, never embedded. The uncommitted delta is real
              // and worth knowing at close, but it is not part of the range
              // the artifact attests — inside the body it made a retry after
              // any tree churn push a SECOND DIFF for the same range.
              if (built.uncommitted) {
                deps.writeOut(
                  `note: uncommitted delta at end (stat only — not part of the attested range):\n${built.uncommitted}`,
                );
              }
            } else {
              deps.writeErr(
                `note: attested diff push failed (${pushed.detail}) — the E1 delivery check will refuse the close; retry \`jentrix session end\`, or acknowledge with --acknowledge-evidence-gaps.`,
              );
            }
          }
        }
      } catch {
        // Unreadable session/repo state: the server's checks stay the truth.
      }
      /**
       * F1c/F3 + F4: the closing telemetry is the session's most important
       * closing fact AND the one that silently fails, so `end` states it on
       * every path — including the one that returns early. `/jentrix-end` can
       * then report a real number (or a named gap) instead of inferring
       * success from exit 0, which is exactly what went wrong on 2026-08-11.
       * Reported AFTER the close line so the JSON payload stays first.
       */
      const hostRan = hasLocalCaptureFootprint(deps, sessionId);
      const reportTelemetry = (row: Record<string, unknown>): void => {
        const verdict = telemetryVerdict(
          sessionId,
          row.usage,
          hostRan,
          row.provider === "codex" ? "codex" : "claude",
        );
        // Under --json stdout stays ONE parseable document (the payload
        // already carries `usage`); the warning is stderr on both paths.
        if (!flags.json) deps.writeOut(verdict.line);
        if (verdict.warning) deps.writeErr(verdict.warning);
      };
      // A LIVE local host owns the spool and the manifest — hand it the end
      // request and report ITS verdict instead of racing it with a direct
      // server-side completion that would find parts still unflushed.
      const live = readLiveHostMarker(deps, sessionId);
      if (live) {
        // A refusal from an EARLIER end must never answer this one.
        clearEndRefusal(deps, sessionId);
        writeFileSync(
          join(deps.spoolRoot, sessionId, "end-request.json"),
          JSON.stringify({
            requestedAt: new Date().toISOString(),
            // JEN-167: the host closes the session, so the operator's
            // acknowledgement has to travel with the request — otherwise the
            // floor refuses a close they explicitly asked to force. The
            // CLI-counted commits ride along for the same reason: only the
            // CLI can count them, and the host's close is the one that lands.
            ...(flags.acknowledgeEvidenceGaps
              ? { acknowledgeEvidenceGaps: true }
              : {}),
            ...(commitCount !== null ? { commitCount } : {}),
          }),
          { mode: 0o600 },
        );
        deps.writeOut(
          `Local capture host (pid ${live.pid}) is finalizing capture…`,
        );
        const outcome = await waitForHostEnd(deps, sessionId, live.pid, 90_000);
        if (outcome.kind === "refused") {
          // JEN-167: the floor refused and the host SURVIVED it — the session
          // is untouched and still recording. Relay the envelope verbatim
          // (reportError adds the acknowledge hint and exits 5) and never
          // complete server-side over a living host.
          deps.writeErr(
            `local capture host (pid ${live.pid}) is still running — the skeleton, heartbeats and telemetry keep accumulating through the comply work; re-run \`jentrix session end ${sessionId}\` once the evidence is pushed`,
          );
          throw new Error(outcome.message);
        }
        if (outcome.kind === "exited") {
          const final = await call(caller, "get_agent_session", { sessionId });
          const stillOpen =
            final.status === "STARTING" || final.status === "ACTIVE";
          if (!stillOpen) {
            if (inspection) {
              clearAlignmentMarker(deps.configPath, inspection.root, sessionId);
            }
            const verdict = sessionCloseVerdict(
              final,
              (final.alignment as { capture?: string } | null)?.capture ===
                "off",
            );
            deps.writeOut(
              flags.json
                ? JSON.stringify(final)
                : `Session ${sessionId} closed · capture ${verdict.capture} · summary ${final.summaryArtifactId ? String(final.summaryArtifactId) : "—"}`,
            );
            reportTelemetry(final);
            return verdict.code;
          }
          // The host exited but could not close the session (dead bearer,
          // crash mid-finalize) — never report "closed" over an open session.
          deps.writeErr(
            `local capture host (pid ${live.pid}) exited without completing the session — completing server-side; the local spool is retained`,
          );
        } else {
          deps.writeErr(
            `local capture host (pid ${live.pid}) did not finalize in time — completing server-side; the local spool is retained for retry`,
          );
        }
      }
      const session = await call(caller, "get_agent_session", { sessionId });
      const sameRepo =
        inspection?.repoOwnerName === session.repoOwnerName ? inspection : null;
      // Durable-telemetry fallback (2026-08-08): a host that died before
      // completing leaves its last provider-receipt rollup in the spool —
      // submit that instead of closing the session with null usage.
      let spooledUsage: Record<string, unknown> | undefined;
      try {
        const snapshot = JSON.parse(
          readFileSync(join(deps.spoolRoot, sessionId, "usage.json"), "utf8"),
        ) as { rollup?: Record<string, unknown> };
        const rollup = snapshot?.rollup;
        if (rollup && typeof rollup === "object") {
          spooledUsage = {
            inputTokens: rollup.inputTokens,
            outputTokens: rollup.outputTokens,
            cacheReadTokens: rollup.cacheReadTokens,
            cacheCreationTokens: rollup.cacheCreationTokens,
            cacheCreation1hTokens: rollup.cacheCreation1hTokens,
            reasoningOutputTokens: rollup.reasoningOutputTokens,
            providerActiveDurationMs: rollup.providerActiveDurationMs,
            toolDurationMs: rollup.toolDurationMs,
            coverage: rollup.coverage,
            ...(Array.isArray(rollup.missingRanges) &&
            rollup.missingRanges.length
              ? { missingRanges: rollup.missingRanges.slice(0, 200) }
              : {}),
          };
          deps.writeErr(
            "submitting the host's last usage snapshot from the retained spool",
          );
        }
      } catch {
        // No snapshot — the session closes with whatever the server holds.
      }
      const result = await call(caller, "complete_agent_session", {
        sessionId,
        outcome: "COMPLETED",
        endBranch: sameRepo?.branch ?? null,
        endHead: sameRepo?.head ?? null,
        endDirty: sameRepo?.dirty ?? null,
        ...(spooledUsage ? { usage: spooledUsage } : {}),
        // Evidence floor (§5/§6): the CLI-counted commits in the range feed
        // E2 and the summary's density line; the acknowledge flag closes over
        // unmet checks with each stamped MISSING into Review readiness.
        ...(commitCount !== null ? { commitCount } : {}),
        ...(flags.acknowledgeEvidenceGaps
          ? { acknowledgeEvidenceGaps: true }
          : {}),
        expectedUpdatedAt: session.updatedAt,
      });
      if (inspection) {
        clearAlignmentMarker(deps.configPath, inspection.root, sessionId);
      }
      const verdict = sessionCloseVerdict(
        result,
        (session.alignment as { capture?: string } | null)?.capture === "off",
      );
      deps.writeOut(
        flags.json
          ? JSON.stringify(result)
          : `Session ${sessionId} closed · capture ${verdict.capture} · summary ${result.summaryArtifactId ? String(result.summaryArtifactId) : "—"}`,
      );
      // `complete_agent_session` answers lifecycle fields only — it carries
      // no `usage`, so reading it here printed NO TOKEN TELEMETRY over a
      // close that had just submitted the spool's snapshot. The verdict must
      // read the authoritative post-close row instead.
      const closed = await call(caller, "get_agent_session", {
        sessionId,
      }).catch(() => null);
      reportTelemetry(closed ?? result);
      return verdict.code;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

export interface SessionDoctorFlags {
  project?: string;
  json?: boolean;
  /** `--bundle [file]`: write the redacted support bundle (true = default name). */
  bundle?: string | boolean;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  fix?: string;
  /** Structured facts behind the detail (the contract check carries both sides). */
  data?: Record<string, unknown>;
}

/**
 * The doctor's LOCAL preconditions (runner installed, spool writable) as a
 * reusable probe — `align --questions` runs the same checks at question time
 * (AGE-955 item 3) instead of growing its own validation, so an "answered
 * everything, then failed" round trip is caught before the first question.
 */
export async function doctorLocalChecks(
  deps: Pick<SessionCommandDeps, "resolveSessionHost" | "spoolRoot">,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  // Client-runtime v2 (G6): the session host ships INSIDE this package — the
  // check is the bundled entry's presence, never a runner install.
  const host = deps.resolveSessionHost();
  checks.push(
    host
      ? { name: "session host", status: "ok", detail: host }
      : {
          name: "session host",
          status: "fail",
          detail:
            "SESSION_HOST_MISSING: this install carries no dist/session-host-main.js",
          fix: "reinstall @jentrix/cli (or `pnpm --dir cli build` in a source checkout)",
        },
  );
  try {
    mkdirSync(deps.spoolRoot, { recursive: true, mode: 0o700 });
    const probe = join(deps.spoolRoot, `.doctor-${process.pid}`);
    writeFileSync(probe, "ok", { mode: 0o600 });
    unlinkSync(probe);
    checks.push({
      name: "spool",
      status: "ok",
      detail: `${deps.spoolRoot} writable`,
    });
  } catch (error) {
    checks.push({
      name: "spool",
      status: "fail",
      detail: `spool root is not writable: ${error instanceof Error ? error.message : String(error)}`,
      fix: `fix permissions on ${deps.spoolRoot}`,
    });
  }
  return checks;
}

/**
 * W2/C2.4 — what a session started HERE would actually record, from the same
 * `telemetrySourceFact` align and `session status` read. A preflight that
 * reports "Ready" while the hooks have never fired is the JEN-163 failure one
 * step earlier: the operator learns at `end` that four of five capabilities
 * were never observed.
 *
 * Local and read-only: the CURRENT provider context plus the hook ledger. No
 * session exists yet, so there is no server row to ask.
 */
export function telemetrySourceCheck(
  deps: Pick<SessionCommandDeps, "env" | "cwd">,
): DoctorCheck {
  let context: ProviderHookContext | null;
  try {
    context = readCurrentProviderHookContext(deps);
  } catch (error) {
    return {
      name: "telemetry",
      status: "warn",
      detail: error instanceof Error ? error.message : String(error),
      fix: "run this inside the target provider task, or pass --provider-session <id> to align",
    };
  }
  if (!context) {
    return {
      name: "telemetry",
      status: "skip",
      detail:
        "no provider session is identified here — a session started from this shell records nothing until one is",
      fix: "run this from inside a Claude Code or Codex task with the Jentrix plugin installed",
    };
  }
  const fact = telemetrySourceFor(
    deps,
    context.provider,
    context.sessionId,
    context.transcriptPath,
  );
  return fact.missing.length === 0
    ? { name: "telemetry", status: "ok", detail: fact.detail }
    : {
        name: "telemetry",
        status: "warn",
        detail: `${fact.detail} — NOT recorded: ${fact.missing.join(", ")}`,
        ...(fact.remedy ? { fix: fact.remedy } : {}),
      };
}

/**
 * Slice 6 — the single preflight. Runs EVERY connected-session precondition
 * (credential + pin, session host present, spool root writable, repository
 * identity, folder binding — plus the optional-Project information row and
 * the legacy `--project` exact check) and reports all failures at once,
 * instead of surfacing one blocker per session-start round trip. Read-only:
 * creates no session, adds no link, invokes no model.
 */
export async function runSessionDoctor(
  flags: SessionDoctorFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  const checks: DoctorCheck[] = [];

  // — local checks (no server round trip) —
  checks.push(...(await doctorLocalChecks(deps)));
  checks.push(telemetrySourceCheck(deps));
  // — the client itself (open-client S5): what is installed, who owns the
  // marketplaces, whether the hooks are pinned, and the adopted contract
  // against the endpoint's (one unauthenticated GET) —
  checks.push(...(await clientChecks(deps)));

  let repo: string | null = null;
  const inspection = await inspectRepository(deps.cwd(), deps.git);
  if (!inspection) {
    checks.push({
      name: "repository",
      status: "fail",
      detail: "the current directory is not inside a git work tree",
      fix: "run from your project checkout",
    });
  } else {
    repo = inspection.repoOwnerName;
    const state = `branch ${inspection.branch ?? "detached"}, ${inspection.dirty ? "dirty" : "clean"}`;
    checks.push({
      name: "repository",
      status: "ok",
      // A remote-less checkout is supported, not a failure — but say WHERE
      // the identity came from, since it is the folder name and it moves
      // with a rename.
      detail: inspection.syntheticRepoIdentity
        ? `${repo} (${state}) — no usable origin remote, so this checkout is identified by its directory name`
        : `${repo} (${state})`,
    });
    // Client-runtime v2 §11: the folder binding is what scopes a session —
    // THE first-run precondition, checked where the old flow checked
    // project links.
    const binding = readFolderBinding(inspection.root);
    checks.push(
      binding
        ? {
            name: "folder binding",
            status: "ok",
            detail: `workspace ${binding.workspaceSlug} @ ${binding.endpoint}`,
          }
        : {
            name: "folder binding",
            // Under the legacy `--project` window a session can still scope
            // by the explicit project, so an unbound folder is a warning
            // there; on the v2 path it is THE first-run blocker.
            status: flags.project ? "warn" : "fail",
            detail:
              "FOLDER_NOT_ALIGNED: this checkout has no workspace binding",
            fix: "jentrix folder align --workspace <slug> (setup normally does this)",
          },
    );
  }

  // — server checks (one connection, every check still reported) —
  let target: { token: string; url: string } | null = null;
  try {
    target = deps.resolveTarget();
  } catch (error) {
    checks.push({
      name: "credential",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "jentrix login (or set STACKS_TOKEN)",
    });
  }
  if (target) {
    try {
      const { caller, close } = await deps.connect(target);
      try {
        let pinnedWorkspaceId: string | null = null;
        try {
          const context = await call(caller, "get_token_context", {});
          const scopes = (context.scopes as string[]) ?? [];
          const pinned = context.workspacePinned === true;
          pinnedWorkspaceId =
            pinned && typeof context.workspaceId === "string"
              ? context.workspaceId
              : null;
          const missing = ["read", "write"].filter(
            (scope) => !scopes.includes(scope),
          );
          checks.push(
            missing.length > 0
              ? {
                  name: "credential",
                  status: "fail",
                  detail: `token lacks the ${missing.join(" + ")} scope${missing.length > 1 ? "s" : ""} a session needs`,
                  fix: "jentrix login (or mint a read+write token)",
                }
              : {
                  name: "credential",
                  status: "ok",
                  detail: `scopes ${scopes.join(", ")} · ${pinned ? `pinned to workspace ${pinnedWorkspaceId}` : "unpinned"}`,
                },
          );
        } catch (error) {
          checks.push({
            name: "credential",
            status: "fail",
            detail: `token verification failed: ${error instanceof Error ? error.message : String(error)}`,
            fix: "jentrix login",
          });
        }

        // Project resolution + repo link. Discovery matching a project IS the
        // repo-link proof; otherwise the project's own links are inspected and
        // anything unprovable from here is an honest warn, never a guess.
        // The board link is evaluated in the SAME pass (AGE-951 live-test
        // finding: it used to surface only after the repo blocker cleared).
        let linkCheck: DoctorCheck | null = null;
        let boardCheck: DoctorCheck | null = null;
        const boardCheckOf = (
          projectName: string,
          links: Array<{ targetType: string }>,
        ): DoctorCheck => {
          const boards = links.filter(
            (link) => link.targetType === "BOARD",
          ).length;
          return boards > 0
            ? {
                name: "board link",
                status: "ok",
                detail: `${projectName} links ${boards} board(s)`,
              }
            : {
                name: "board link",
                status: "warn",
                detail: `${projectName} links no board — creating a task during align will auto-provision and link one`,
              };
        };
        if (flags.project) {
          try {
            let project: Record<string, unknown> | null = null;
            try {
              project = await call(caller, "get_project", {
                projectId: flags.project,
              });
            } catch (byId) {
              // STA-60: `--project` is documented `<id-or-slug>`, so the
              // by-slug retry must run for EVERY credential. It used to run
              // only for a workspace-PINNED token, which left the documented
              // slug form failing with a bare "Project not found" on an
              // ordinary unpinned one — exactly the dead end this preflight
              // exists to prevent. `get_project`'s slug form needs a
              // workspace (a slug is unique only within one), so an unpinned
              // token asks across the workspaces it can actually see.
              const scope = pinnedWorkspaceId
                ? [pinnedWorkspaceId]
                : (
                    ((await call(caller, "list_workspaces", {}))
                      .workspaces as Array<{ id: string }>) ?? []
                  ).map((ws) => ws.id);
              for (const workspaceId of scope) {
                try {
                  project = await call(caller, "get_project", {
                    workspaceId,
                    slug: flags.project,
                  });
                  break;
                } catch {
                  // Not in this workspace — keep asking. Only when no
                  // workspace holds the slug does the ORIGINAL by-id error
                  // stand, so the operator still reads why their input
                  // failed rather than a rethrown last-workspace miss.
                }
              }
              if (!project) throw byId;
            }
            checks.push({
              name: "project",
              status: "ok",
              detail: `${String(project.name)} (${String(project.id)})`,
            });
            const links =
              (project.links as Array<{
                targetType: string;
                targetId: string;
              }>) ?? [];
            boardCheck = boardCheckOf(String(project.name), links);
            const hasRepoLink =
              repo !== null &&
              links.some(
                (link) =>
                  link.targetType === "REPO" &&
                  link.targetId.trim().toLowerCase() === repo,
              );
            const linkFix = `jentrix tool add_project_link --args '${JSON.stringify(
              {
                projectId: String(project.id),
                targetType: "REPO",
                targetId: repo ?? "owner/name",
              },
            )}'`;
            const unprovableWarn: DoctorCheck = {
              name: "repo link",
              status: "warn",
              detail: `no explicit REPO link for ${repo ?? "the checkout"} on ${String(project.name)} — a linked board's GitHub sync or the workspace default may still satisfy the gate`,
              fix: linkFix,
            };
            if (hasRepoLink) {
              linkCheck = {
                name: "repo link",
                status: "ok",
                detail: `project links ${repo}`,
              };
            } else if (repo !== null && !pinnedWorkspaceId) {
              // AGE-936: discovery IS the server's own matching (all rungs —
              // explicit link, board GitHub sync, workspace default), so
              // membership proves the gate and absence deterministically
              // predicts the attach refusal. Warn only where discovery
              // cannot run (pinned credential) or errors — unprovable, never
              // a guessed "Ready".
              try {
                const found = await call(caller, "resolve_projects_for_repo", {
                  repoOwnerName: repo,
                });
                const candidates = (found.projects as ProjectCandidate[]) ?? [];
                linkCheck = candidates.some(
                  (candidate) => candidate.id === String(project.id),
                )
                  ? {
                      name: "repo link",
                      status: "ok",
                      detail: `matched by repository discovery (${repo})`,
                    }
                  : {
                      name: "repo link",
                      status: "fail",
                      detail: `PROJECT_REPO_MISMATCH: ${String(project.name)} does not link ${repo} and repository discovery does not match it — session start/attach will refuse`,
                      fix: linkFix,
                    };
              } catch {
                linkCheck = unprovableWarn;
              }
            } else {
              linkCheck = unprovableWarn;
            }
          } catch (error) {
            checks.push({
              name: "project",
              status: "fail",
              detail: `project ${flags.project} did not resolve: ${error instanceof Error ? error.message : String(error)}`,
              fix: "check the id/slug (list with `jentrix project list`)",
            });
          }
        } else if (repo === null) {
          checks.push({
            name: "project",
            status: "skip",
            detail: "skipped — repository identity missing",
          });
        } else {
          // Client-runtime v2: a Project is an OPTIONAL task label — sessions
          // scope by the folder binding's workspace, so "no project links
          // this repo" is a fully connectable state, reported as
          // information, never a blocker. (`--project` above stays the exact
          // check for the legacy compatibility window.)
          try {
            const found = await call(caller, "resolve_projects_for_repo", {
              repoOwnerName: repo,
            });
            const projects = (found.projects as ProjectCandidate[]) ?? [];
            checks.push({
              name: "project",
              status: "ok",
              detail:
                projects.length === 0
                  ? `no Project links ${repo} — optional in v2 (label tasks with \`jentrix task project add\`)`
                  : `${projects.length} Project(s) link ${repo} — optional labels; governed workers scope by them`,
            });
          } catch {
            // Informational only — discovery being unreachable is not a
            // session blocker in v2 and the credential check already reports
            // connectivity.
          }
        }
        if (linkCheck) checks.push(linkCheck);
        if (boardCheck) checks.push(boardCheck);
      } finally {
        await close().catch(() => undefined);
      }
    } catch (error) {
      checks.push({
        name: "credential",
        status: "fail",
        detail: `cannot reach ${target.url}: ${error instanceof Error ? error.message : String(error)}`,
        fix: "check STACKS_MCP_URL / network, or jentrix login",
      });
    }
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warned = checks.filter((check) => check.status === "warn");
  // Open-client R2 S2 (PRD §8 Phase 5): the redacted support bundle. Built
  // from the checks above and nothing else; the resolved bearer (if any) is
  // scrubbed as a literal on top of the redactor's patterns. Written with
  // owner-only permissions; the user previews and shares it by hand.
  let bundlePath: string | null = null;
  if (flags.bundle) {
    const bundle = doctorBundle(checks, {
      env: deps.env,
      homedir: deps.client?.homeDir() ?? deps.env.HOME ?? null,
      literals: target ? [target.token] : [],
    });
    bundlePath =
      typeof flags.bundle === "string"
        ? resolve(deps.cwd(), flags.bundle)
        : join(
            deps.cwd(),
            `jentrix-doctor-${bundle.generatedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`,
          );
    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  if (flags.json) {
    deps.writeOut(
      JSON.stringify({
        ok: failed.length === 0,
        checks,
        ...(bundlePath ? { bundle: bundlePath } : {}),
      }),
    );
    return failed.length === 0 ? 0 : 1;
  }
  deps.writeOut(
    `Connected-session preflight: ${failed.length} failed, ${warned.length} warning(s), ${checks.filter((c) => c.status === "ok").length} ok`,
  );
  const ICONS = { ok: "✓", warn: "⚠", fail: "✗", skip: "-" } as const;
  for (const check of checks) {
    deps.writeOut(
      `  ${ICONS[check.status]} ${check.name.padEnd(12)} ${check.detail}`,
    );
    if (check.fix) deps.writeOut(`      fix: ${check.fix}`);
  }
  if (bundlePath) {
    deps.writeOut(
      `Support bundle written: ${bundlePath} — redacted (no tokens, no transcript content, no hook bodies, no file contents). Preview it, then attach it to your report by hand; nothing uploads it.`,
    );
  }
  deps.writeOut(
    failed.length === 0
      ? "Ready — start with: jentrix session connect --provider claude|codex, then jentrix session align --task <id-or-key>"
      : `${failed.length} blocker(s) — fix everything above in one pass, then re-run.`,
  );
  return failed.length === 0 ? 0 : 1;
}

export function reportError(error: unknown, deps: SessionCommandDeps): number {
  if (error instanceof UsageError) {
    deps.writeErr(`error: ${error.message}`);
    return error.exitCode;
  }
  const withCode = error as { exitCode?: number; message?: string };
  if (typeof withCode?.exitCode === "number") {
    deps.writeErr(`error: ${withCode.message ?? "failed"}`);
    return withCode.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  deps.writeErr(`error: ${message}`);
  if (message.includes("EVIDENCE_FLOOR")) {
    // §6: the refusal envelope is relayed VERBATIM above; add only the escape
    // hatch — an honest close over the named gaps.
    deps.writeErr(
      "To close anyway with the unmet checks stamped MISSING: `jentrix session end --acknowledge-evidence-gaps` (a declared deviation is an ordinary `jentrix push gap`).",
    );
    return EXIT_CODES.CONFLICT;
  }
  if (message.includes("SESSION_ALREADY_BOUND")) return EXIT_CODES.CONFLICT;
  if (
    message.includes("FORBIDDEN") ||
    message.includes("PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN")
  ) {
    return EXIT_CODES.FORBIDDEN;
  }
  return 1;
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

export interface SessionAlignFlags {
  task?: string;
  sessionLevel?: boolean;
  owner?: string;
  agent?: string;
  agentEmoji?: string;
  capture?: boolean;
  skeleton?: boolean;
  budget?: number | false;
  provider?: "claude" | "codex";
  providerSession?: string;
  transcriptPath?: string;
  json?: boolean;
}

/** Resolve `--task <id-or-key>` — a human key goes through get_task. */
async function resolveTaskFlag(
  caller: SessionToolCaller,
  workspaceId: string,
  wanted: string,
): Promise<string> {
  const key = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(wanted.trim());
  if (!key) return wanted.trim();
  const task = await callStructured(caller, "get_task", {
    workspaceId,
    number: Number(key[2]),
    response_format: "concise",
  });
  return String(task.id);
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
        ? await resolveTaskFlag(caller, binding.workspaceId, flags.task)
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
          deps.writeOut(
            captureMode === "on"
              ? `Capture host running (pid ${pid}) — TRACE capture ON for this session.`
              : `Session host running (pid ${pid}) — heartbeats + telemetry; TRACE capture is OFF.`,
          );
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
      }
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

export function registerSessionCommand(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  const session = program
    .command("session")
    .description(
      "Start, attach, inspect, and end connected Claude Code / Codex sessions bound to a Jentrix project.",
    );
  for (const provider of ["claude", "codex"] as const) {
    session
      .command(provider)
      .description(
        `Start a connected ${provider === "claude" ? "Claude Code" : "Codex"} session in the current checkout (project-confirmed; capture runs beside the provider).`,
      )
      .option(
        "--project <id-or-slug>",
        "project to bind (required non-interactively)",
      )
      .option(
        "--resume <jentrix-session-id>",
        "resume an eligible interrupted session",
      )
      .action(async (flags: SessionStartFlags) =>
        onExit(await runSessionStart(provider, flags, deps)),
      );
  }
  session
    .command("connect")
    .description(
      "Connect the CURRENT provider session (id from trusted lifecycle context) to a Jentrix session in the folder's workspace — identity only; `session align` anchors work.",
    )
    .addOption(
      new Option(
        "--provider <provider>",
        "provider of the running session",
      ).choices(["claude", "codex"]),
    )
    .option("--provider-session <id>", "current provider session/thread id")
    .addOption(
      // §15.3: the legacy compatibility shape — parsed, never advertised.
      new Option("--project <id-or-slug>", "legacy project binding").hideHelp(),
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
    .option("--no-skeleton", "activity skeleton off")
    .action(async (flags: SessionAttachFlags) =>
      onExit(await runSessionConnect(flags, deps)),
    );
  session
    .command("attach", { hidden: true })
    .description("(renamed) — use `jentrix session connect`")
    .addOption(
      new Option(
        "--provider <provider>",
        "provider of the running session",
      ).choices(["claude", "codex"]),
    )
    .option("--provider-session <id>", "current provider session/thread id")
    .addOption(
      new Option("--project <id-or-slug>", "legacy project binding").hideHelp(),
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
    .action(async (flags: SessionAttachFlags) =>
      onExit(await runSessionAttach(flags, deps)),
    );
  session
    .command("align")
    .description(
      "Anchor THIS session's next work + telemetry to a task (or session level) with an accountable owner — flag-driven, no wizard, no Project.",
    )
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
    .option("--json", "stable JSON output")
    .action(async (flags: SessionAlignFlags) =>
      onExit(await runSessionAlign(flags, deps)),
    );
  session
    .command("doctor")
    .description(
      "Preflight EVERY connected-session precondition at once (credential + pin, runner, spool, repository, project, repo link) — read-only, reports all failures together.",
    )
    .option(
      "--project <id-or-slug>",
      "check an exact project instead of discovery",
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
