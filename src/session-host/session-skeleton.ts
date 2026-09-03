/**
 * Session evidence floor (session-evidence PRD §4, D2/D3) — the v1 ACTIVITY
 * SKELETON: content-free counts, names, paths, and timing accumulated from the
 * events the bridge already observes, INDEPENDENT of TRACE capture. No bodies,
 * no prompt text, no argv, no URLs — metadata about volume and shape only.
 *
 * The accumulator is fed the REDACTED event (post `redactor.value`), so file
 * paths arrive home-prefix scrubbed exactly like a spooled part. Serialization
 * is capped at 32 KB: beyond the cap the file list drops from the tail first
 * (counts stay exact) and the JSON says so (`truncated: true`, D2).
 */

import type { SessionEvent } from "./session-events.js";

export const SKELETON_VERSION = 1 as const;
export const MAX_SKELETON_BYTES = 32 * 1024;

/** Caps that keep the accumulator itself bounded on a very long session. */
const MAX_DISTINCT_TOOLS = 100;
const MAX_TRACKED_FILES = 300;
const MAX_HOURLY_BUCKETS = 500;
const MAX_PATH_CHARS = 300;

export interface ActivitySkeleton {
  version: typeof SKELETON_VERSION;
  provider: "claude" | "codex";
  /** User turns observed (user_message events). */
  turns: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  /** Per-kind counts over the SessionEvent vocabulary. */
  eventCounts: Record<string, number>;
  /** Tool-call counts by tool NAME (never arguments). */
  toolCounts: Record<string, number>;
  filesTouched: {
    /** Distinct paths observed — exact even when the list below is capped. */
    total: number;
    paths: string[];
    listTruncated?: true;
  };
  /** UTC hour ("YYYY-MM-DDTHH") → events observed in that hour. */
  hourlyBuckets: Record<string, number>;
  /** Present when a cap coalesced anything (D2 — declared, never silent). */
  truncated?: true;
}

/** Path-shaped string fields the skeleton may read off a tool_call input. */
const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath"] as const;

function pathOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null; // no URLs
  return trimmed.slice(0, MAX_PATH_CHARS);
}

export class SessionSkeleton {
  private turns = 0;
  private firstEventAt: string | null = null;
  private lastEventAt: string | null = null;
  private readonly eventCounts = new Map<string, number>();
  private readonly toolCounts = new Map<string, number>();
  private readonly files = new Set<string>();
  private filesOverflow = 0;
  private readonly hourly = new Map<string, number>();
  private coalesced = false;

  constructor(private readonly provider: "claude" | "codex") {}

  get observedAnything(): boolean {
    return this.firstEventAt !== null;
  }

  /** Feed one REDACTED observed event. Pure accumulation, never throws. */
  observe(event: SessionEvent): void {
    this.eventCounts.set(
      event.kind,
      (this.eventCounts.get(event.kind) ?? 0) + 1,
    );
    if (event.kind === "user_message") this.turns += 1;
    if (this.firstEventAt === null) this.firstEventAt = event.at;
    this.lastEventAt = event.at;
    const hour = event.at.slice(0, 13); // YYYY-MM-DDTHH
    if (this.hourly.has(hour) || this.hourly.size < MAX_HOURLY_BUCKETS) {
      this.hourly.set(hour, (this.hourly.get(hour) ?? 0) + 1);
    } else {
      this.coalesced = true;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.kind === "tool_call") {
      const name =
        typeof payload.name === "string" && payload.name.trim()
          ? payload.name.trim().slice(0, 120)
          : "(unnamed)";
      if (
        this.toolCounts.has(name) ||
        this.toolCounts.size < MAX_DISTINCT_TOOLS
      ) {
        this.toolCounts.set(name, (this.toolCounts.get(name) ?? 0) + 1);
      } else {
        this.coalesced = true;
        this.toolCounts.set(
          "(other)",
          (this.toolCounts.get("(other)") ?? 0) + 1,
        );
      }
      const input = payload.input;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        for (const key of PATH_KEYS) {
          const path = pathOf((input as Record<string, unknown>)[key]);
          if (path) this.touch(path);
        }
      }
    }
    if (event.kind === "file_change") {
      const changes = payload.changes;
      if (Array.isArray(changes)) {
        for (const change of changes) {
          const path = pathOf((change as Record<string, unknown>)?.path);
          if (path) this.touch(path);
        }
      } else if (changes && typeof changes === "object") {
        for (const key of Object.keys(changes as Record<string, unknown>)) {
          const path = pathOf(key);
          if (path) this.touch(path);
        }
      }
    }
  }

  private touch(path: string): void {
    if (this.files.has(path)) return;
    if (this.files.size >= MAX_TRACKED_FILES) {
      this.filesOverflow += 1;
      this.coalesced = true;
      return;
    }
    this.files.add(path);
  }

  /** The bounded v1 JSON. ≤ 32 KB serialized — file-list tail drops first. */
  snapshot(): ActivitySkeleton {
    const build = (
      paths: string[],
      listTruncated: boolean,
    ): ActivitySkeleton => ({
      version: SKELETON_VERSION,
      provider: this.provider,
      turns: this.turns,
      firstEventAt: this.firstEventAt,
      lastEventAt: this.lastEventAt,
      eventCounts: Object.fromEntries(this.eventCounts),
      toolCounts: Object.fromEntries(this.toolCounts),
      filesTouched: {
        total: this.files.size + this.filesOverflow,
        paths,
        ...(listTruncated ? { listTruncated: true as const } : {}),
      },
      hourlyBuckets: Object.fromEntries(this.hourly),
      ...(this.coalesced || listTruncated ? { truncated: true as const } : {}),
    });
    let paths = [...this.files];
    let listTruncated = this.filesOverflow > 0;
    let skeleton = build(paths, listTruncated);
    while (
      Buffer.byteLength(JSON.stringify(skeleton), "utf8") >
        MAX_SKELETON_BYTES &&
      paths.length > 0
    ) {
      // Drop the file-list tail first (D2) — counts stay exact.
      paths = paths.slice(0, Math.max(0, Math.floor(paths.length / 2)));
      listTruncated = true;
      skeleton = build(paths, listTruncated);
    }
    return skeleton;
  }
}
