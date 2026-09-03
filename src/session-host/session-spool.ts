/**
 * M20.1 §12.3 — the crash-safe local spool. Every event line is REDACTED
 * before it is appended (the caller passes lines through the session
 * redactor first); files are mode-0600 under a mode-0700 session directory.
 *
 * Deletion contract (AC22/AC23 + the amended §12.3): a part file is deleted
 * ONLY when the server acknowledged that exact content — the acknowledgement
 * carries the STORED checksum, and a redacted-slot refusal or CONFLICT keeps
 * the file. Losing the network never loses evidence; the CLI reports pending
 * parts and retries with the same part numbers.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * M20.1 follow-up (AGE-929): the LOCAL liveness marker `jentrix session status`
 * reads. The server cannot see the local capture leg — a bound session whose
 * host died reads healthy until the abandonment sweep — so the host marks its
 * own lifecycle in the spool directory: `host.json` written at start, stamped
 * with the exit at clean shutdown. A crash leaves the start marker with no
 * exit; the CLI detects that shape by probing the recorded pid.
 * The CLI mirrors this file's shape rather than importing it (dependency
 * firewall — the CLI never imports the runner package).
 */
export interface SessionHostMarker {
  pid: number;
  startedAt: string;
  provider: string;
  mode: string;
  /**
   * Whether THIS host runs TRACE capture (AGE-956): `mode` describes how the
   * host attaches (watch/launch), never what it collects, and the CLI's
   * align must report capture truthfully from the live host's actual state —
   * marker existence alone reads capture-blind.
   */
  captureTrace?: boolean;
  /**
   * AGE-957: whether the host has EVER successfully stat'ed its transcript
   * path. False after the grace window means the host is observing nothing
   * (no events, no usage receipts) — `session status` surfaces it instead of
   * letting a dead tail read as healthy silence.
   */
  transcriptSeen?: boolean;
  /**
   * WHICH transcript this host watches (2026-08-11 gap report F1/P3). Two
   * things need it. `transcriptSeen: true` only reports that the host found A
   * transcript, so proving it found THIS session's needs the path recorded.
   * And a compaction hook, whose cwd is the SESSION's directory and not
   * necessarily the aligned checkout, resolves its Jentrix session by matching
   * the hook payload's transcript_path against this field — a provable link
   * where a cwd match is a guess.
   */
  transcriptPath?: string;
  /**
   * Cumulative server-acknowledged part count + when the last flush ran —
   * an empty spool is ambiguous (nothing captured vs everything flushed);
   * this stamp is how `session status` tells the two apart.
   */
  ackedParts?: number;
  lastFlushAt?: string;
  exitedAt?: string;
  exitCode?: number;
}

export function writeHostMarker(
  sessionDir: string,
  marker: Pick<
    SessionHostMarker,
    "pid" | "provider" | "mode" | "captureTrace" | "transcriptPath"
  >,
): void {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const body: SessionHostMarker = {
    ...marker,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(sessionDir, "host.json"), JSON.stringify(body), {
    mode: 0o600,
  });
}

/** Stamp whether the transcript path has ever been seen (AGE-957). */
export function markHostTranscript(
  sessionDir: string,
  seen: boolean,
  transcriptPath?: string,
): void {
  const path = join(sessionDir, "host.json");
  let marker: SessionHostMarker;
  try {
    marker = JSON.parse(readFileSync(path, "utf8")) as SessionHostMarker;
  } catch {
    return; // no start marker to stamp — best-effort
  }
  marker.transcriptSeen = seen;
  if (transcriptPath) marker.transcriptPath = transcriptPath;
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
}

export function markHostFlushed(sessionDir: string, ackedParts: number): void {
  const path = join(sessionDir, "host.json");
  let marker: SessionHostMarker;
  try {
    marker = JSON.parse(readFileSync(path, "utf8")) as SessionHostMarker;
  } catch {
    return; // no start marker to stamp — best-effort
  }
  marker.ackedParts = ackedParts;
  marker.lastFlushAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
}

export function markHostExited(sessionDir: string, exitCode: number): void {
  const path = join(sessionDir, "host.json");
  let marker: SessionHostMarker;
  try {
    marker = JSON.parse(readFileSync(path, "utf8")) as SessionHostMarker;
  } catch {
    return; // no start marker to stamp — best-effort
  }
  marker.exitedAt = new Date().toISOString();
  marker.exitCode = exitCode;
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
}

/** Rotate a part before it crosses the server's inline ingestion cap. */
export const SPOOL_PART_ROTATE_BYTES = 6 * 1024 * 1024;

const PART_FILE = /^part-(\d{6})\.ndjson$/;

export interface SpoolPart {
  part: number;
  path: string;
  byteSize: number;
  /** sha256 over the part's redacted NDJSON text — the convergence identity. */
  checksum: string;
}

export class SessionSpool {
  private readonly dir: string;
  private currentPart: number;

  constructor(root: string, sessionId: string) {
    this.dir = join(root, sessionId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const existing = this.listPartNumbers();
    this.currentPart = existing.length ? Math.max(...existing) : 0;
  }

  get directory(): string {
    return this.dir;
  }

  private partPath(part: number): string {
    return join(this.dir, `part-${String(part).padStart(6, "0")}.ndjson`);
  }

  private listPartNumbers(): number[] {
    return readdirSync(this.dir)
      .map((name) => PART_FILE.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
  }

  /**
   * Append one ALREADY-REDACTED NDJSON line durably (0600, fsync'd). Rotates
   * to the next part when the current one would cross the ingestion cap.
   */
  append(redactedLine: string): void {
    const path = this.partPath(this.currentPart);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // first line of a new part
    }
    if (
      size > 0 &&
      size + Buffer.byteLength(redactedLine) > SPOOL_PART_ROTATE_BYTES
    ) {
      this.currentPart += 1;
    }
    const target = this.partPath(this.currentPart);
    const fd = openSync(target, "a", 0o600);
    try {
      writeSync(fd, redactedLine);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Advance past a flushed (acked + deleted) part. Ingestion slots are
   * append-only — same part + different checksum is a permanent CONFLICT —
   * so a slot the server acknowledged must never be reused for new events.
   */
  advancePast(part: number): void {
    if (part >= this.currentPart) this.currentPart = part + 1;
  }

  /** Cheap append without rotation checks (tests / recovery merges). */
  appendRaw(part: number, redactedLine: string): void {
    appendFileSync(this.partPath(part), redactedLine, { mode: 0o600 });
    if (part > this.currentPart) this.currentPart = part;
  }

  /** Every pending part with its convergence checksum, ordered by number. */
  pendingParts(): SpoolPart[] {
    return this.listPartNumbers()
      .sort((a, b) => a - b)
      .map((part) => {
        const path = this.partPath(part);
        const body = readFileSync(path, "utf8");
        return {
          part,
          path,
          byteSize: Buffer.byteLength(body),
          checksum: createHash("sha256").update(body, "utf8").digest("hex"),
        };
      });
  }

  /** Read one part's redacted text for upload. */
  readPart(part: number): string {
    return readFileSync(this.partPath(part), "utf8");
  }

  /**
   * Delete a part ONLY on a server acknowledgement of this exact content.
   * `acknowledgedChecksum` is the STORED checksum from the server's ack; when
   * the server's re-redaction changed the bytes, the caller records the acked
   * checksum into its manifest first, then confirms deletion explicitly with
   * `force`. An audit stub can never satisfy this — a refusal keeps the file.
   */
  deleteAcknowledged(
    part: number,
    acknowledgedChecksum: string,
    opts: { force?: boolean } = {},
  ): boolean {
    const path = this.partPath(part);
    let body: string;
    try {
      body = readFileSync(path, "utf8");
    } catch {
      return false; // already gone
    }
    const localChecksum = createHash("sha256")
      .update(body, "utf8")
      .digest("hex");
    if (localChecksum !== acknowledgedChecksum && !opts.force) {
      return false;
    }
    // Atomic-ish removal: rename first so a crash mid-delete never leaves a
    // half-truncated live part.
    const tomb = `${path}.acked`;
    renameSync(path, tomb);
    unlinkSync(tomb);
    return true;
  }
}
