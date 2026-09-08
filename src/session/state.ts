/** Session state. */
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  statSync,
  rmSync,
} from "node:fs";

/** The narrow tool-caller surface (mirrors call.ts's ToolCaller). */
// ---------------------------------------------------------------------------
// Local alignment marker — how `jentrix push` and `jentrix session end` find
// the aligned session for this checkout without a server-side "find by cwd".
// Mode 0600, keyed by repo root hash, next to the CLI config. Owned here so commands share the same safe reader and migration.
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

export function readAlignmentMarkerFile(
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
  transform: (
    current: AlignmentMarkerFile | null,
  ) => AlignmentMarkerFile | null,
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
