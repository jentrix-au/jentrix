/**
 * R02 — the local semantic-checkpoint ledger beside the spool. Shared by the
 * hook handler (which REQUESTS a checkpoint at a boundary), `push --checkpoint`
 * (which answers it), and `status`/`end` (which repeat the request until it
 * is answered). Lives here, not in commands/push, so status → push → contact →
 * status never becomes a cycle.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHECKPOINT_BOUNDARIES = [
  "compaction",
  "handoff",
  "intent-change",
  "task-switch",
  "investigation-resolved",
  "manual",
  "none-occurred",
] as const;
export type CheckpointBoundary = (typeof CHECKPOINT_BOUNDARIES)[number];

/**
 * R02 — the local checkpoint ledger beside the spool: what the last semantic
 * checkpoint was, and whether a hook has REQUESTED one since. The hook cannot
 * distil (no model turn); it records the request, and `status`/`end` say it
 * out loud until a `--checkpoint` push clears it.
 */
export interface CheckpointRequest {
  boundary: CheckpointBoundary;
  requestedAt: string;
  reason: string;
}

export function checkpointRequestPath(spoolRoot: string, sessionId: string): string {
  return join(spoolRoot, sessionId, "checkpoint-request.json");
}

export function readCheckpointRequest(
  spoolRoot: string,
  sessionId: string,
): CheckpointRequest | null {
  try {
    const parsed = JSON.parse(
      readFileSync(checkpointRequestPath(spoolRoot, sessionId), "utf8"),
    ) as CheckpointRequest;
    return typeof parsed?.boundary === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Record a checkpoint request (never overwrites an older pending one's time). */
export function writeCheckpointRequest(
  spoolRoot: string,
  sessionId: string,
  request: CheckpointRequest,
): void {
  try {
    mkdirSync(join(spoolRoot, sessionId), { recursive: true, mode: 0o700 });
    const existing = readCheckpointRequest(spoolRoot, sessionId);
    writeFileSync(
      checkpointRequestPath(spoolRoot, sessionId),
      JSON.stringify(existing ? { ...request, requestedAt: existing.requestedAt } : request),
      { mode: 0o600 },
    );
  } catch {
    // best-effort — a request that cannot be written is disclosed nowhere,
    // which is the pre-R02 behaviour, never a crash inside a hook
  }
}

