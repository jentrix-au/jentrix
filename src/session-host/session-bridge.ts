/**
 * M20.1 §8.4/§20 — the local session bridge: the crash-safe capture loop that
 * runs BESIDE the interactive provider. It spools redacted events locally,
 * uploads TRACE parts with retry, heartbeats at most every 30 seconds, and
 * closes the session with a server-verified manifest + the §12.5 usage
 * rollup. Network loss keeps the spool and marks capture pending — it can
 * never silently become "complete" (AC22).
 *
 * Every effectful edge (fetch, MCP tool call, clocks) is injected so the
 * fault-injection tests (provider exit, network loss, duplicate events,
 * retry) run with zero real sockets.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionEvent, SessionEventKind } from "./session-events.js";
import { serializeSessionEvent } from "./session-events.js";
import type { SessionRedactor } from "./session-redact.js";
import { SessionSkeleton } from "./session-skeleton.js";
import type { SessionSpool } from "./session-spool.js";
import {
  aggregateSessionUsage,
  type LifecycleInterval,
  type ObservedRange,
  type UsageReceipt,
} from "./session-usage.js";

export type SessionCallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * AGE-649 — the bound on the stored final response. Mirrors
 * MAX_TYPED_ARTIFACT_BYTES in src/server/agent-sessions/ingestion.ts across the
 * dependency firewall (the runner package cannot import from the app), so the
 * artifact is truncated with a visible notice HERE rather than refused there at
 * the moment the session is closing.
 */
export const MAX_FINAL_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface SessionBridgeDeps {
  jentrixBaseUrl: string;
  /**
   * Transient bearer for REST heartbeat/ingestion — NEVER persisted here. A
   * function form resolves the CURRENT token per request (OAuth rotation
   * revokes the old one mid-session — the 2026-08-08 capture-off finding).
   */
  bearer: string | (() => string);
  /**
   * Called with the bearer that just got a 401 — gives the host's bearer
   * source a chance to rotate/adopt before the next request. Fire-and-forget
   * from the silent paths (heartbeat, part upload).
   */
  onUnauthorized?: (failedBearer: string) => Promise<unknown>;
  sessionId: string;
  provider: "claude" | "codex";
  spool: SessionSpool;
  redactor: SessionRedactor;
  callTool: SessionCallTool;
  fetchImpl?: typeof fetch;
  monotonic?: () => number;
  wallClock?: () => Date;
  /**
   * Jentrix MVP (PRD §6): false = TRACE capture OFF — events are still
   * observed (usage receipts, timing, heartbeats) but nothing is spooled or
   * uploaded and completion submits no manifest. Default true.
   */
  traceCapture?: boolean;
  /**
   * Session evidence floor (D3): false = the operator opted out of the
   * activity skeleton (`jentrix align --no-skeleton`). Default true — the
   * skeleton is content-free metadata and is NOT gated on traceCapture.
   */
  collectSkeleton?: boolean;
  log?: (line: string) => void;
}

export const HEARTBEAT_MIN_INTERVAL_MS = 30_000;

/**
 * JEN-294: how many of a previous host's missingRanges a restart carries
 * forward. Below the server's 200-entry cap on `missingRanges` (which the
 * rollup already enforces at the source) so the carried tail can never crowd
 * out this host's own gaps; a longer list is summarized, never silently cut.
 */
export const CARRIED_RANGES_MAX = 150;

export interface CapabilitySnapshot {
  provider: "claude" | "codex";
  providerVersion: string | null;
  /** Event classes this provider/mode can emit; the rest are not_observable. */
  observable: SessionEventKind[];
  notObservable: SessionEventKind[];
}

export class SessionBridge {
  private sequence = 0;
  private readonly receipts: UsageReceipt[] = [];
  /** JEN-294: the restart baseline(s) this host seeded — named in every rollup. */
  private readonly namedGaps: string[] = [];
  private readonly providerTurns = new Map<string, LifecycleInterval>();
  private readonly toolIntervals = new Map<string, LifecycleInterval>();
  private readonly observedRanges: ObservedRange[] = [];
  /**
   * control-room AC2.1/AC2.2 — the LAST model the provider was observed
   * running. Last, not first: a session may legitimately switch models
   * mid-flight and the model that ran is the one that ran. Null until a line
   * names one; the heartbeat then omits the field entirely, so an unobserved
   * model can never overwrite a proven one server-side.
   */
  private observedModelId: string | null = null;
  private observingSince: number | null = null;
  private readonly ackedParts = new Map<number, string>();
  private readonly terminalParts = new Set<number>();
  private lastHeartbeatAt = 0;
  private unrecognizedEvents = 0;
  private capability: CapabilitySnapshot | null = null;
  private inactive = false;
  /**
   * AGE-649 — the newest non-empty assistant message observed, kept so the
   * session's own OUTPUT survives the close. Held in memory only: this is a
   * projection of an event the host already sees, never a second capture
   * channel, and it is recorded even when TRACE capture is off (which is the
   * whole point — capture-off is the MVP default, and without this a closed
   * session keeps its telemetry and loses what it actually concluded).
   */
  private lastAssistantMessage: {
    text: string;
    at: string;
    sequence: number;
  } | null = null;
  /**
   * Session evidence floor (PRD §4): the v1 activity skeleton, accumulated
   * from every REDACTED event this bridge records — capture-off included —
   * and submitted on the existing heartbeats plus the forced beat at close.
   * Null when the operator opted out at align (D3).
   */
  private readonly skeleton: SessionSkeleton | null;

  /**
   * True after a heartbeat came back 409 SESSION_NOT_ACTIVE — the session is
   * terminal server-side. The watch host uses this as its end signal when no
   * lifecycle hook can reach it; network loss never sets it.
   */
  get sessionInactive(): boolean {
    return this.inactive;
  }

  /** Heartbeat-refusal statuses already logged — one warning per status. */
  private warnedHeartbeatStatuses = new Set<number>();

  /** Server-acknowledged parts so far — the host stamps this into host.json. */
  get ackedPartCount(): number {
    return this.ackedParts.size;
  }

  constructor(private readonly deps: SessionBridgeDeps) {
    this.skeleton =
      deps.collectSkeleton === false
        ? null
        : new SessionSkeleton(deps.provider);
  }

  /** The injected MCP tool caller (host convenience — same credential). */
  get tool(): SessionCallTool {
    return this.deps.callTool;
  }

  private now(): number {
    return (this.deps.monotonic ?? (() => performance.now()))();
  }

  private wall(): Date {
    return (this.deps.wallClock ?? (() => new Date()))();
  }

  private fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /** Begin (or resume) continuous observation — opens an observed range. */
  startObserving(): void {
    if (this.observingSince === null) this.observingSince = this.now();
  }

  /** A capture gap (stream drop, provider restart): closes the range. */
  recordGap(reason: string): void {
    if (this.observingSince !== null) {
      this.observedRanges.push({ from: this.observingSince, to: this.now() });
      this.observingSince = null;
    }
    this.record({ kind: "error", payload: { captureGap: reason } });
  }

  /** Record the provider capability snapshot (§15.3) as an observable event. */
  recordCapabilities(snapshot: CapabilitySnapshot): void {
    this.capability = snapshot;
    this.record({ kind: "session", payload: { capabilities: snapshot } });
  }

  get capabilities(): CapabilitySnapshot | null {
    return this.capability;
  }

  countUnrecognized(): void {
    this.unrecognizedEvents += 1;
  }

  /**
   * Append one observable event: sequence + wall timestamp stamped here, the
   * whole line REDACTED before it becomes durable, usage receipts collected
   * for the rollup (deduped downstream by provider event identity).
   */
  record(
    event: Omit<SessionEvent, "sequence" | "version" | "at" | "provider"> & {
      at?: string;
      providerEventId?: string;
    },
  ): SessionEvent {
    const full: SessionEvent = {
      version: 1,
      sequence: this.sequence++,
      at: event.at ?? this.wall().toISOString(),
      provider: this.deps.provider,
      ...(event.providerEventId
        ? { providerEventId: event.providerEventId }
        : {}),
      kind: event.kind,
      payload: this.deps.redactor.value(event.payload),
    };
    if (this.deps.traceCapture !== false) {
      this.deps.spool.append(
        this.deps.redactor.text(serializeSessionEvent(full)),
      );
    }
    // Evidence floor (PRD §4): the skeleton observes the REDACTED event —
    // counts/names/paths only, independent of whether anything was spooled.
    this.skeleton?.observe(full);
    if (full.kind === "assistant_message") {
      // Read off the REDACTED payload, so the text kept here has already been
      // through the local pass — exactly like a spooled part.
      const text = (full.payload as { text?: unknown })?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        this.lastAssistantMessage = {
          text,
          at: full.at,
          sequence: full.sequence,
        };
      }
    }
    if (full.kind === "usage") {
      const payload = full.payload as {
        kind?: "delta" | "cumulative";
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        cacheCreation1hTokens?: number;
        reasoningOutputTokens?: number;
        modelId?: string | null;
        turnId?: string | null;
      };
      if (
        (payload?.kind === "delta" || payload?.kind === "cumulative") &&
        typeof payload.inputTokens === "number" &&
        typeof payload.outputTokens === "number"
      ) {
        this.receipts.push({
          eventId: full.providerEventId ?? `seq:${full.sequence}`,
          turnId: payload.turnId ?? null,
          kind: payload.kind,
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          ...(typeof payload.cacheReadTokens === "number"
            ? { cacheReadTokens: payload.cacheReadTokens }
            : {}),
          ...(typeof payload.cacheCreationTokens === "number"
            ? { cacheCreationTokens: payload.cacheCreationTokens }
            : {}),
          // D7: the 1-hour subset of the cache writes, when the mapper saw it.
          ...(typeof payload.cacheCreation1hTokens === "number"
            ? { cacheCreation1hTokens: payload.cacheCreation1hTokens }
            : {}),
          // TPM Slice 2 (AC2.4/AC2.7): the receipt's own model and reasoning
          // split, when the mapper reported them — grouped receipts, never
          // estimates.
          ...(typeof payload.reasoningOutputTokens === "number"
            ? { reasoningOutputTokens: payload.reasoningOutputTokens }
            : {}),
          ...(typeof payload.modelId === "string" && payload.modelId.trim()
            ? { modelId: payload.modelId.trim() }
            : {}),
          at: this.now(),
        });
        // Durable telemetry: a host that dies before completing (crash,
        // revoked bearer) must not take the usage rollup with it — `stacks
        // session end`'s server-side fallback submits this snapshot
        // (2026-08-08 capture-off finding: all-null tokens after host death).
        this.persistUsageSnapshot();
      }
    }
    return full;
  }

  /**
   * JEN-294 — continuity across a host restart. A RESTARTED watch host tails
   * the transcript from its current end, so the rollup it heartbeats used to
   * cover only its own window — and the server wrote that as the session's
   * totals while SessionUsageSegment kept the history, so tokens under-stated
   * after every restart. The spool already holds the previous host's last
   * rollup (`usage.json`, written after every receipt): seed one synthetic
   * delta receipt per perModel bucket from it, so totals AND buckets continue
   * from where the previous host stopped. The seam is NAMED (coverage can
   * never read COMPLETE across a restart; missingRanges says where the
   * baseline came from), and the snapshot is never unlinked here — only a
   * successful close removes it. Replays what a host RECORDED, never a number
   * anyone derived (AC35). The caller decides WHEN: never while importing
   * history, which re-reads the receipts the snapshot summarizes.
   *
   * @returns the snapshot's `updatedAt`, or null when there was nothing to seed.
   */
  seedFromSpoolSnapshot(): string | null {
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readFileSync(join(this.deps.spool.directory, "usage.json"), "utf8"),
      );
    } catch {
      return null; // no snapshot — a first host, or a previous clean close
    }
    const snapshot = (parsed ?? {}) as {
      rollup?: Record<string, unknown>;
      updatedAt?: unknown;
    };
    const rollup = snapshot.rollup;
    if (!rollup || typeof rollup !== "object") return null;
    type Bucket = Record<string, unknown>;
    const perModel = Array.isArray(rollup.perModel)
      ? (rollup.perModel as Bucket[])
      : [];
    // A snapshot without buckets (a pre-TPM host) seeds its totals as one
    // null-model bucket — the same honesty as an un-attributed receipt.
    const buckets: Bucket[] =
      perModel.length > 0
        ? perModel
        : num(rollup.inputTokens) !== null && num(rollup.outputTokens) !== null
          ? [{ ...rollup, modelId: null }]
          : [];
    let seeded = 0;
    for (const bucket of buckets) {
      const inputTokens = num(bucket.inputTokens);
      const outputTokens = num(bucket.outputTokens);
      if (inputTokens === null || outputTokens === null) continue;
      const modelId =
        typeof bucket.modelId === "string" && bucket.modelId.trim()
          ? bucket.modelId.trim()
          : null;
      const cacheReadTokens = num(bucket.cacheReadTokens);
      const cacheCreationTokens = num(bucket.cacheCreationTokens);
      const cacheCreation1hTokens = num(bucket.cacheCreation1hTokens);
      const reasoningOutputTokens = num(bucket.reasoningOutputTokens);
      this.receipts.push({
        eventId: `spool-baseline:${modelId ?? "null"}`,
        turnId: null,
        kind: "delta",
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== null ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== null ? { cacheCreationTokens } : {}),
        ...(cacheCreation1hTokens !== null ? { cacheCreation1hTokens } : {}),
        ...(reasoningOutputTokens !== null ? { reasoningOutputTokens } : {}),
        ...(modelId ? { modelId } : {}),
        at: this.now(),
      });
      seeded += 1;
    }
    if (seeded === 0) return null;
    const updatedAt =
      typeof snapshot.updatedAt === "string" && snapshot.updatedAt
        ? snapshot.updatedAt
        : "an unknown time";
    // JEN-294 (operator return, 2026-09-02): the previous host's own seams
    // travel WITH its totals. The snapshot's missingRanges — an earlier
    // restart note, a tool that never returned, a turn without a receipt —
    // are carried into this host's named gaps before the new baseline note,
    // deduplicated and bounded, so the rewrite of usage.json below can never
    // drop evidence a previous host recorded. Two restarts leave two notes.
    const carried = Array.isArray(rollup.missingRanges)
      ? (rollup.missingRanges as unknown[]).filter(
          (r): r is string => typeof r === "string" && r.length > 0,
        )
      : [];
    for (const range of carried.slice(0, CARRIED_RANGES_MAX)) {
      if (!this.namedGaps.includes(range)) this.namedGaps.push(range);
    }
    if (carried.length > CARRIED_RANGES_MAX) {
      this.namedGaps.push(
        `…and ${carried.length - CARRIED_RANGES_MAX} more ranges carried from the spool snapshot of ${updatedAt} were not kept (bounded at ${CARRIED_RANGES_MAX})`,
      );
    }
    this.namedGaps.push(
      `restart baseline seeded from the spool snapshot of ${updatedAt}`,
    );
    this.persistUsageSnapshot();
    return updatedAt;
  }

  /** Best-effort spool-side snapshot of the current rollup (provider receipts). */
  private persistUsageSnapshot(): void {
    try {
      writeFileSync(
        join(this.deps.spool.directory, "usage.json"),
        JSON.stringify({
          rollup: this.usageRollup(),
          updatedAt: this.wall().toISOString(),
        }),
        { mode: 0o600 },
      );
    } catch {
      // Telemetry durability is best-effort — never fail capture over it.
    }
  }

  /** Record the model a transcript line named (pure accumulation, no I/O). */
  observeModel(modelId: string): void {
    const next = modelId.trim();
    if (next) this.observedModelId = next;
  }

  /** What the host has observed running, for tests and the close-time record. */
  get modelId(): string | null {
    return this.observedModelId;
  }

  /**
   * control-room AC3.7 — record an interval whose bounds were OBSERVED rather
   * than measured on this process's clock. The Claude path replays timestamps
   * the transcript already carries, so `this.now()` (which the mark* pair
   * below uses for the live Codex path) would time the tail, not the turn.
   */
  recordInterval(interval: {
    kind: "turn" | "tool";
    id: string;
    startedAt: number;
    endedAt: number;
  }): void {
    const target =
      interval.kind === "turn" ? this.providerTurns : this.toolIntervals;
    target.set(interval.id, {
      id: interval.id,
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
    });
  }

  /**
   * An interval opened and never closed — a tool that never returned, a host
   * killed mid-turn. Recorded WITHOUT an end so `aggregateSessionUsage` names
   * the gap and degrades coverage to PARTIAL, instead of the total quietly
   * omitting it and reading as complete.
   */
  recordUnclosedInterval(kind: "turn" | "tool", id: string): void {
    const target = kind === "turn" ? this.providerTurns : this.toolIntervals;
    if (!target.has(id)) target.set(id, { id, startedAt: 0, endedAt: null });
  }

  markTurnStarted(id: string): void {
    this.providerTurns.set(id, { id, startedAt: this.now(), endedAt: null });
  }

  markTurnEnded(id: string): void {
    const turn = this.providerTurns.get(id);
    if (turn) turn.endedAt = this.now();
  }

  markToolStarted(id: string): void {
    this.toolIntervals.set(id, { id, startedAt: this.now(), endedAt: null });
  }

  markToolEnded(id: string): void {
    const interval = this.toolIntervals.get(id);
    if (interval) interval.endedAt = this.now();
  }

  /** The current REST bearer (function form resolves per request). */
  private bearerOf(): string {
    return typeof this.deps.bearer === "function"
      ? this.deps.bearer()
      : this.deps.bearer;
  }

  /** ≤ one heartbeat per 30s window (AC42); failures are silent (retry next). */
  async maybeHeartbeat(): Promise<void> {
    const now = this.now();
    if (now - this.lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return;
    await this.postHeartbeat(now);
  }

  /**
   * TPM Slice 2 (AC2.5): the flush receipt — an immediate beat that ignores
   * the 30-second window, posted before a task-changing re-align so the OLD
   * alignment's open interval absorbs everything observed so far. Host-side
   * ordering only: a killed host's mid-switch smear stays bounded by one
   * beat window, which the CLI disclosure names.
   */
  async flushUsageNow(): Promise<boolean> {
    return this.postHeartbeat(this.now());
  }

  /** @returns true when the server acknowledged the beat (HTTP ok). */
  private async postHeartbeat(now: number): Promise<boolean> {
    this.lastHeartbeatAt = now;
    const bearer = this.bearerOf();
    try {
      const response = await this.fetch()(
        new URL("/api/agent-sessions/heartbeat", this.deps.jentrixBaseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sessionId: this.deps.sessionId,
            // control-room AC2.1: the heartbeat is the host's "what I
            // observed" channel. No new timer, no new route, no new tool —
            // and host-attested by construction, since the route writes only
            // the authenticated operator's own open session.
            ...(this.observedModelId ? { modelId: this.observedModelId } : {}),
            // control-room AC4.1: the LIVE usage receipt on the same beat.
            // Sent only once a receipt has actually been observed — an empty
            // rollup would overwrite the session's totals with nulls and
            // report UNAVAILABLE for a session that had already reported.
            ...(this.receipts.length > 0 ? { usage: this.usageRollup() } : {}),
            // Evidence floor (PRD §4/D2): the bounded activity skeleton rides
            // the same beat (tolerant server parse — an old server strips the
            // unknown key). Sent only once something was observed: null column
            // means "never observed", never an empty object.
            ...(this.skeleton?.observedAnything
              ? { activitySkeleton: this.skeleton.snapshot() }
              : {}),
          }),
        },
      );
      if (response.status === 401) {
        // A rotated-away bearer must not silently kill liveness until the
        // sweep interrupts the session — ask the source to recover so the
        // NEXT window heartbeats with a live token.
        void this.deps.onUnauthorized?.(bearer)?.catch(() => undefined);
      }
      if (response.status === 409) {
        const body = await response.text().catch(() => "");
        if (body.includes("SESSION_NOT_ACTIVE")) this.inactive = true;
      }
      if (
        !response.ok &&
        response.status !== 401 &&
        response.status !== 409 &&
        !this.warnedHeartbeatStatuses.has(response.status)
      ) {
        // A silently-refused beat is how a live session gets swept
        // INTERRUPTED — say it ONCE per distinct status, not every 30s.
        this.warnedHeartbeatStatuses.add(response.status);
        this.deps.log?.(
          `capture: heartbeat rejected (HTTP ${response.status}) — liveness at risk; the sweep may interrupt this session`,
        );
      }
      return response.ok;
    } catch {
      // Offline: the sweep may interrupt server-side; reconnection resumes.
      return false;
    }
  }

  /**
   * Upload every pending spool part. Returns the still-pending count — a
   * non-zero result is "capture pending", printed prominently and encoded in
   * the CLI exit code (§20). A redacted-slot refusal (terminal, §12.3) keeps
   * the local file forever and is reported as a named gap.
   */
  async flushParts(): Promise<{ pending: number; terminal: number }> {
    // Capture off: nothing was spooled, nothing to upload — by design.
    if (this.deps.traceCapture === false) return { pending: 0, terminal: 0 };
    let pending = 0;
    for (const part of this.deps.spool.pendingParts()) {
      if (this.terminalParts.has(part.part)) continue;
      const bearer = this.bearerOf();
      try {
        const response = await this.fetch()(
          new URL(
            `/api/agent-sessions/${this.deps.sessionId}/parts`,
            this.deps.jentrixBaseUrl,
          ),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              part: part.part,
              body: this.deps.spool.readPart(part.part),
            }),
          },
        );
        if (response.ok) {
          const ack = (await response.json()) as { checksum?: string };
          const acked =
            typeof ack.checksum === "string" ? ack.checksum : part.checksum;
          // Record the ACKNOWLEDGED (stored) checksum into the manifest first,
          // then delete the spool file — never on anything but a genuine ack.
          this.ackedParts.set(part.part, acked);
          this.deps.spool.deleteAcknowledged(part.part, acked, { force: true });
          // The slot is spent server-side; new events open the next part.
          this.deps.spool.advancePast(part.part);
          continue;
        }
        if (response.status === 401) {
          void this.deps.onUnauthorized?.(bearer)?.catch(() => undefined);
        }
        const body = await response.text().catch(() => "");
        if (
          response.status === 409 &&
          body.includes("ARTIFACT_PART_REDACTED")
        ) {
          // Terminal slot: keep the local spool (operator deletion only) and
          // stop retrying — the summary names the gap.
          this.terminalParts.add(part.part);
          this.deps.log?.(
            `trace part ${part.part}: slot terminally redacted — local spool retained`,
          );
          continue;
        }
        pending += 1;
      } catch {
        pending += 1; // network loss: retry later, spool intact (AC22)
      }
    }
    return { pending, terminal: this.terminalParts.size };
  }

  /**
   * AGE-649 — push the session's FINAL RESPONSE as a typed artifact.
   *
   * Why this exists: with TRACE capture off (the MVP default) a closed session
   * keeps its telemetry and its typed artifacts, and nothing at all holds what
   * the agent concluded. The RUN_SUMMARY cannot carry it — that document is a
   * deterministic server projection and model prose is banned from it (M20.1
   * AC31) — so the output lands as its own artifact, on the same typed-push
   * boundary an operator's `jentrix push report` uses. One ingestion function,
   * both redaction passes, checksum after redaction.
   *
   * Ordering is load-bearing: `COMPLETED` is a SEALED status for typed pushes,
   * so this runs BEFORE `complete_agent_session`, never after.
   *
   * Absence stays absence. A session where the host observed no assistant text
   * (capture never bound, a Codex thread that only ran tools) gets NO artifact
   * rather than an empty one — the same rule the usage rollup follows for
   * tokens. Failure never fails the close: the artifact is a bonus record, and
   * losing it must not cost the operator their session completion.
   *
   * @returns the artifact id, or null when there was nothing to push.
   */
  async pushFinalResponse(): Promise<string | null> {
    const last = this.lastAssistantMessage;
    if (!last) return null;
    const body = this.finalResponseBody(last);
    const bearer = this.bearerOf();
    try {
      const response = await this.fetch()(
        new URL(
          `/api/agent-sessions/${this.deps.sessionId}/artifacts`,
          this.deps.jentrixBaseUrl,
        ),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            // `report` → REPORT → the Execution layer, which is the session's
            // own layer. No new push kind and no new ArtifactType: the seven
            // kinds are frozen vocabulary and this is a report the agent wrote.
            kind: "report",
            title: `Final response — session ${this.deps.sessionId.slice(-8)}`,
            body,
          }),
        },
      );
      if (response.ok) {
        const ack = (await response.json().catch(() => null)) as {
          artifactId?: string;
        } | null;
        return ack?.artifactId ?? null;
      }
      if (response.status === 401) {
        void this.deps.onUnauthorized?.(bearer)?.catch(() => undefined);
      }
      this.deps.log?.(
        `final response: not stored (HTTP ${response.status}) — the session's closing output was not captured`,
      );
      return null;
    } catch (error) {
      this.deps.log?.(
        `final response: not stored (${error instanceof Error ? error.message : "unknown"}) — the session's closing output was not captured`,
      );
      return null;
    }
  }

  /**
   * The stored document. Self-describing on purpose: a reader has to be able to
   * tell this apart from the RUN_SUMMARY sitting beside it, and has to know it
   * is verbatim provider output rather than anything the server derived.
   *
   * Bounded here as well as server-side, and a truncation SAYS so — an artifact
   * silently missing its tail is worse than one that names the cut.
   */
  private finalResponseBody(last: {
    text: string;
    at: string;
    sequence: number;
  }): string {
    const header = [
      `# Final response — session ${this.deps.sessionId}`,
      "",
      `The last assistant message this session's host observed before close (event ${last.sequence}, ${last.at}).`,
      "Verbatim provider output — redacted on this machine and again on arrival.",
      "This is model prose, not a server projection: the RUN_SUMMARY artifact is the deterministic record of what the session did.",
      "",
      "---",
      "",
    ].join("\n");
    const room = MAX_FINAL_RESPONSE_BYTES - Buffer.byteLength(header, "utf8");
    if (Buffer.byteLength(last.text, "utf8") <= room) return header + last.text;
    const notice = "\n\n[truncated — the response exceeded the artifact limit]";
    const kept = Buffer.from(last.text, "utf8")
      .subarray(0, Math.max(0, room - Buffer.byteLength(notice, "utf8")))
      .toString("utf8")
      // A byte-slice can cut a multi-byte character in half; drop the
      // replacement char it decodes to rather than storing mojibake.
      .replace(/�+$/, "");
    return header + kept + notice;
  }

  /** The §12.5 rollup over everything observed so far. */
  usageRollup() {
    const ranges = [...this.observedRanges];
    if (this.observingSince !== null) {
      ranges.push({ from: this.observingSince, to: this.now() });
    }
    const rollup = aggregateSessionUsage({
      receipts: this.receipts,
      observedRanges: ranges,
      providerTurns: [...this.providerTurns.values()],
      toolIntervals: [...this.toolIntervals.values()],
      namedGaps: [...this.namedGaps],
    });
    // The server's SessionUsageSchema bounds missingRanges to 200 entries of
    // ≤400 chars. An UNBOUNDED list (one entry per receipt-less turn — a
    // long session crosses 200 easily) made every usage-bearing heartbeat
    // fail schema validation SILENTLY: heartbeatAt froze while part uploads
    // kept landing, and the sweep interrupted a perfectly live session
    // (observed 2026-08-20, three sweeps in one run). Cap here at the source
    // — the tail collapses into one honest summary entry.
    if (rollup.missingRanges.length > 200) {
      const dropped = rollup.missingRanges.length - 199;
      rollup.missingRanges = [
        ...rollup.missingRanges.slice(0, 199),
        `…and ${dropped} more missing ranges (capped at the schema's 200)`,
      ];
    }
    rollup.missingRanges = rollup.missingRanges.map((r) => r.slice(0, 400));
    return rollup;
  }

  /**
   * Close the session: final flush, server-verified manifest from the ACKED
   * checksums, rollup, then `complete_agent_session` under CAS. Returns the
   * server's verdict plus the local pending count — the CLI exits non-zero
   * while anything is pending (§20).
   */
  async complete(opts: {
    outcome: "COMPLETED" | "INTERRUPTED" | "CANCELLED";
    end: { branch: string | null; head: string | null; dirty: boolean | null };
    captureError?: string | null;
    /**
     * JEN-167 — `session end --acknowledge-evidence-gaps`, relayed through the
     * end request. The host closes the session itself, so the operator's
     * acknowledgement has to reach the SERVER from here; it used to arrive
     * only via the CLI's fallback, which the refusal-kills-the-host bug made
     * the effective path.
     */
    acknowledgeEvidenceGaps?: boolean;
    /** CLI-counted commits in the session window (JEN-167); null = unknown. */
    commitCount?: number | null;
  }): Promise<{
    status: string;
    captureComplete: boolean;
    summaryArtifactId: string | null;
    /** AGE-649 — null when the host observed no assistant text to store. */
    finalResponseArtifactId: string | null;
    pendingParts: number;
  }> {
    const { pending } = await this.flushParts();
    // Evidence floor (PRD §4): the close path finalizes the skeleton with a
    // FORCED beat (the 30 s window would swallow a plain one) while the
    // session is still open — the heartbeat route only writes open sessions.
    // Also the close-time usage flush the Codex host used to make on its own.
    await this.flushUsageNow().catch(() => false);
    // AGE-649: BEFORE the completion call — `COMPLETED` seals the session
    // against typed pushes, so there is no "after" for this.
    const finalResponseArtifactId = await this.pushFinalResponse();
    const rollup = this.usageRollup();
    const current = (await this.deps.callTool("get_agent_session", {
      sessionId: this.deps.sessionId,
    })) as { updatedAt?: string };
    const traceOff = this.deps.traceCapture === false;
    // Capture-off (PRD §6): no manifest is submitted — captureComplete stays
    // false with an honest reason, never a vacuous "complete" over a
    // transcript that was deliberately not recorded.
    const manifest = traceOff
      ? undefined
      : {
          parts: [...this.ackedParts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([part, checksum]) => ({ part, checksum })),
        };
    // AGE-958: the healthy capture-off default is a STATUS, not an error —
    // the server records captureError null and derives OFF_BY_DESIGN; sending
    // prose here made every monitor watching `captureError != null` alert on
    // the designed path.
    const captureError =
      opts.captureError ??
      (traceOff
        ? null
        : pending > 0
          ? `capture pending: ${pending} trace part(s) not yet acknowledged`
          : this.unrecognizedEvents > 0
            ? `${this.unrecognizedEvents} provider event(s) had shapes this adapter does not observe`
            : null);
    const result = (await this.deps.callTool("complete_agent_session", {
      sessionId: this.deps.sessionId,
      outcome: opts.outcome,
      endBranch: opts.end.branch,
      endHead: opts.end.head,
      endDirty: opts.end.dirty,
      captureError,
      ...(opts.acknowledgeEvidenceGaps
        ? { acknowledgeEvidenceGaps: true }
        : {}),
      ...(typeof opts.commitCount === "number"
        ? { commitCount: opts.commitCount }
        : {}),
      ...(manifest ? { manifest } : {}),
      usage: {
        inputTokens: rollup.inputTokens,
        outputTokens: rollup.outputTokens,
        cacheReadTokens: rollup.cacheReadTokens,
        cacheCreationTokens: rollup.cacheCreationTokens,
        cacheCreation1hTokens: rollup.cacheCreation1hTokens,
        // TPM Slice 2 (AC2.6/AC2.7): the close corrects session TOTALS —
        // reasoning included, perModel deliberately NOT sent (the server
        // writes no segments at close; residuals stay disclosed).
        reasoningOutputTokens: rollup.reasoningOutputTokens,
        providerActiveDurationMs: rollup.providerActiveDurationMs,
        toolDurationMs: rollup.toolDurationMs,
        coverage: rollup.coverage,
        ...(rollup.missingRanges.length
          ? { missingRanges: rollup.missingRanges.slice(0, 200) }
          : {}),
      },
      expectedUpdatedAt: current.updatedAt,
    })) as {
      status?: string;
      captureComplete?: boolean;
      summaryArtifactId?: string | null;
    };
    // The rollup reached the server — the durable snapshot has done its job.
    try {
      unlinkSync(join(this.deps.spool.directory, "usage.json"));
    } catch {
      // Absent (no receipts) or unremovable — either way not worth failing.
    }
    return {
      status: result.status ?? opts.outcome,
      captureComplete: Boolean(result.captureComplete),
      summaryArtifactId: result.summaryArtifactId ?? null,
      finalResponseArtifactId,
      pendingParts: pending,
    };
  }
}
