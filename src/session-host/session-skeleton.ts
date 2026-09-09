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
  /**
   * Turns observed: the GREATER of user-message events and the provider turns
   * the host recorded (JEN-494 D12). `turnsBasis` says which one this is, so a
   * reader never has to guess — a `claude -p` run whose prompt predates the
   * attach observes zero user messages on a fully captured session, and
   * reporting that as `turns: 0` was §4 G4.
   */
  turns: number;
  /** Which count `turns` came from. Absent on a pre-JEN-494 skeleton. */
  turnsBasis?: "user messages" | "provider turns";
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

/**
 * JEN-496 (hardening D11) — path-shaped tokens inside a Bash `command`.
 *
 * The path KEYS above see Read/Edit/Write and nothing else, so an agent that
 * reads with `sed -n 1,60p tests/e2e/x.spec.ts` or `cat src/a.ts` touched a
 * file the record never mentions: JEN-486 recorded `files touched: 3` against
 * a thirteen-file attested diff (§4 G4), and the export-zip run filed a GAP
 * about a spec it had never opened (§4 G7).
 *
 * ponytail: a SYNTACTIC tokenizer, and deliberately so. It accepts a token
 * that contains "/" and ends in a dotted extension, which means it will also
 * count a path merely NAMED in an `echo`, and will miss a read through
 * `cat $f` or a glob. It does not test the filesystem, because the skeleton is
 * a pure accumulator over redacted events and knows nothing about a checkout —
 * the consumer that DOES know (`jentrix session contact`, `push gap`) applies
 * the in-checkout test. The honest fix is a provider-reported read event,
 * which neither provider emits today; until then this is a floor on code
 * contact, never a proof of it.
 */
const SHELL_SPLIT = /[\s;|&<>()'"`]+/;
const PATH_TOKEN = /^[\w.@~+-][\w./@~+-]*\/[\w./@~+-]*\.[A-Za-z][\w]{0,9}$/;

export function bashPathTokens(command: string): string[] {
  const found: string[] = [];
  for (const raw of command.split(SHELL_SPLIT)) {
    // Drop shell decoration a path never carries, then trailing punctuation.
    const token = raw.replace(/^[=:,]+/, "").replace(/[,:;]+$/, "");
    if (!token || token.length > MAX_PATH_CHARS) continue;
    // A glob or a variable is not a path this tokenizer will claim.
    if (/[*?$!{}\[\]]/.test(token)) continue;
    if (!PATH_TOKEN.test(token)) continue;
    found.push(token);
  }
  return found;
}

function pathOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null; // no URLs
  return trimmed.slice(0, MAX_PATH_CHARS);
}

export class SessionSkeleton {
  private turns = 0;
  private providerTurns = 0;
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

  /**
   * D12 — how many provider turns the host has intervals for. Pushed in by the
   * bridge rather than counted here: turn pairing is the timing tracker's job
   * (Claude) or the hook ledger's (Codex), and the skeleton stays a pure
   * accumulator over events.
   */
  noteProviderTurns(count: number): void {
    if (Number.isFinite(count) && count > this.providerTurns) {
      this.providerTurns = Math.floor(count);
    }
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
        const fields = input as Record<string, unknown>;
        for (const key of PATH_KEYS) {
          const path = pathOf(fields[key]);
          if (path) this.touch(path);
        }
        // D11: …and the path-shaped tokens of a shell command.
        if (typeof fields.command === "string") {
          for (const token of bashPathTokens(fields.command)) {
            const path = pathOf(token);
            if (path) this.touch(path);
          }
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
      turns: Math.max(this.turns, this.providerTurns),
      turnsBasis:
        this.providerTurns > this.turns ? "provider turns" : "user messages",
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
