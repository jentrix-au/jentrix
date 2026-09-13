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

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withRateLimitRetry } from "../retry.js";

import { withSemanticHeader } from "./semantic-header.js";
import {
  serializeSessionEvent,
  type SessionEvent,
  type SessionEventKind,
  type SessionProvider,
} from "./session-events.js";
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
  provider: SessionProvider;
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
  /**
   * JEN-456 — the host's shared RATE_LIMITED wait budget. Absent = no backoff
   * (every existing test constructs a bridge without one and keeps its exact
   * behaviour); `session-host.ts` creates one and hands the SAME object to
   * `sessionCallTool`, so the REST and MCP paths cannot each spend 60 seconds.
   */
  rateLimitBudget?: RateLimitBudget;
}

export const HEARTBEAT_MIN_INTERVAL_MS = 30_000;

/**
 * JEN-456 — the total time this host may spend WAITING OUT rate limits, across
 * every request it makes for the rest of its life.
 *
 * One budget for the whole host, not one per call, and this is the load-bearing
 * part: `jentrix session end` waits 90 s for the host to finish
 * (`waitForHostEnd`), and a close makes five requests (part flush, forced beat,
 * final response, `get_agent_session`, `complete_agent_session`). Five
 * independent 60-second backoffs would blow that window and the operator would
 * get the server-side fallback anyway — which is the failure being fixed. 60 s
 * shared leaves 30 s of headroom for the calls themselves.
 */
export const HOST_RATE_LIMIT_BUDGET_MS = 60_000;

/**
 * The remaining rate-limit wait, shared by every request path of one host — the
 * bridge's REST calls and `sessionCallTool`'s MCP calls alike. A wait that would
 * not fit is never taken (`withRateLimitRetry` returns the refusal instead), so
 * the host degrades to today's behaviour rather than hanging past its window.
 */
export interface RateLimitBudget {
  /** Seconds of waiting still allowed. Zero disables every retry. */
  remainingSeconds(): number;
  /** Record milliseconds actually spent waiting. */
  spend(ms: number): void;
}

export function createRateLimitBudget(
  totalMs: number = HOST_RATE_LIMIT_BUDGET_MS,
): RateLimitBudget {
  let remainingMs = Math.max(0, totalMs);
  return {
    remainingSeconds: () => remainingMs / 1000,
    spend: (ms) => {
      remainingMs = Math.max(0, remainingMs - Math.max(0, ms));
    },
  };
}

/**
 * Run `fn` under the ONE retry policy (`cli/src/retry.ts`), charging whatever it
 * waits to the host's shared budget. `retryAfterOf` is what makes the same
 * policy cover an HTTP 429 as well as a tool-call envelope.
 */
export async function withHostRateLimitRetry<T>(
  budget: RateLimitBudget | undefined,
  fn: () => Promise<T>,
  retryAfterOf?: (result: T) => number | null,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = () => Date.now(),
): Promise<T> {
  if (!budget) return fn();
  const before = now();
  try {
    return await withRateLimitRetry(fn, {
      // Bounded by the BUDGET, not by a count: two 30-second waits and one
      // 60-second wait are the same spend, and the spend is what matters.
      maxRetries: 4,
      maxWaitSeconds: budget.remainingSeconds(),
      sleep,
      now,
      ...(retryAfterOf ? { retryAfterOf } : {}),
    });
  } finally {
    budget.spend(now() - before);
  }
}

/**
 * The `Retry-After` a rate-limited REST response asks for, in seconds, or null
 * when the response is not a 429. A 429 without a usable header still retries
 * once after a conservative default — the server always sends the header
 * (`sessionRateLimitResponse`), and an old server that does not is exactly the
 * case where guessing beats giving up on the close.
 */
export function retryAfterOfResponse(response: {
  status: number;
  headers: { get(name: string): string | null };
}): number | null {
  if (response.status !== 429) return null;
  // `Number(null)` and `Number("")` are BOTH 0, so an ABSENT header would read
  // as "retry immediately" — a hot loop against a server already refusing.
  // Test the raw string first; only a present, parseable value is honoured.
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.trim() === "") return 5;
  const header = Number(raw);
  return Number.isFinite(header) && header >= 0 ? header : 5;
}

/**
 * JEN-294: how many of a previous host's missingRanges a restart carries
 * forward. Below the server's 200-entry cap on `missingRanges` (which the
 * rollup already enforces at the source) so the carried tail can never crowd
 * out this host's own gaps; a longer list is summarized, never silently cut.
 */
export const CARRIED_RANGES_MAX = 150;

export interface CapabilitySnapshot {
  provider: SessionProvider;
  providerVersion: string | null;
  /** Event classes this provider/mode can emit; the rest are not_observable. */
  observable: SessionEventKind[];
  notObservable: SessionEventKind[];
  /**
   * R05 — input/identity classes this adapter does NOT expose even when the
   * host does (e.g. Codex hooks carry no image attachments, no child-session
   * traversal). Named here so the coverage report can say "unsupported"
   * instead of nothing.
   */
  unsupported?: string[];
}

/**
 * R01 — what the host currently holds as the session's closing output, and
 * WHY it is or is not a turn-closing answer. The host never certifies an
 * explicit final deliverable; that is `jentrix push report --final`. Here
 * `state` is always "provisional" — the field exists so a reader compares it
 * with the explicit final's "final" rather than inferring from a title.
 */
export interface FinalOutputState {
  state: "provisional";
  /** True when the message closed its turn (no tool calls followed it). */
  turnClosing: boolean;
  /** Why it is NOT turn-closing, when it is not. */
  reason?: string;
  messageId?: string;
  turnId?: string;
  sequence: number;
  observedAt: string;
  /** sha256 over the redacted text — the identity a retry converges on. */
  checksum: string;
}

/** R01 — the durable delivery record for the host's provisional final output. */
export interface FinalOutputRecord {
  attemptId: string;
  messageId: string | null;
  turnId: string | null;
  sequence: number;
  checksum: string;
  /**
   * F03 (2026-09-12 review) — the REDACTED output itself, so a host process
   * started over this spool after a crash or a lost acknowledgement can
   * retry the SAME attempt without the in-memory message. Absent on records
   * written before the fix (those cannot be retried, and say so).
   */
  message?: {
    text: string;
    at: string;
    sequence: number;
    toolCalls: number;
    messageId?: string;
    turnId?: string;
  };
  /**
   * F03 (2026-09-13 review) — the EXACT serialized upload payload of this
   * attempt. A retry of an unfinished attempt re-sends these bytes verbatim
   * (same attempt id, same `supersedes`, same header), so the server's
   * content dedupe converges on one row; recomputing the payload on retry
   * dropped the predecessor and changed the bytes under the same attempt id.
   */
  body?: string;
  delivery: "pending" | "acked" | "failed" | "final-exists";
  artifactId: string | null;
  /** The previously acked artifact this attempt replaces, when content changed. */
  supersedes: string | null;
  reason: string | null;
  updatedAt: string;
  attempts: Array<{ attemptId: string; checksum: string; delivery: string; artifactId: string | null; at: string }>;
}

export interface FinalOutputDelivery {
  artifactId: string | null;
  attemptId: string | null;
  /**
   * acked — uploaded now; reused — the same message was acked earlier (a
   * refused-close retry); final-exists — the agent pushed an explicit final,
   * which is the current output; failed — upload failed (spool keeps the
   * pending record); none — no assistant text was observed.
   */
  delivery: "acked" | "reused" | "final-exists" | "failed" | "none";
  reason?: string;
  supersedes?: string | null;
}

/** R05 — what this session's capture did and did not cover, by class. */
export interface CoverageReport {
  observed: string[];
  unsupported: string[];
  omittedByConsent: string[];
  truncated: string[];
  failed: string[];
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
  /**
   * JEN-494 (AC1.6/D12) — one attempt, ever. The alignment snapshot is built
   * from `session.modelId` at align time, so a session aligned BEFORE its
   * first assistant entry carries `agent.modelId: null` for its whole life
   * while the producer says `claude-opus-5` (§4 G3, seen on JEN-486). Set
   * before the call, not after: a failing re-stamp must not retry every beat.
   */
  private alignmentModelRestamped = false;
  // The in-flight re-stamp (fire-and-forget from a heartbeat) — awaited by
  // `complete()` before it reads `updatedAt`, or the CAS on the close races it.
  private alignmentModelRestamp: Promise<void> | null = null;
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
    /** D12: the API message these blocks belong to, when the mapper named one. */
    messageId?: string;
    /** R01/R05: the provider turn, when the mapper named one (Codex Stop). */
    turnId?: string;
    /** R01: tool calls this message made — a message that calls tools is mid-turn. */
    toolCalls: number;
  } | null = null;
  /** R05 — event kinds actually observed, for the coverage report. */
  private readonly observedKinds = new Set<string>();
  /** R05/R07 — named truncations and failures the coverage report lists. */
  private readonly truncations = new Set<string>();
  private readonly failures = new Set<string>();
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

  /**
   * JEN-456 — every REST request the host makes, under the shared bounded
   * backoff. A 429 used to be a silent liveness loss (heartbeat), a lost
   * closing output (final response) or a retained spool (parts); now it waits
   * the server's own `Retry-After` and tries again, inside the 90 s the CLI's
   * `session end` allows. Said ONCE per distinct status, never every 30 s.
   */
  private async retrying(fn: () => Promise<Response>): Promise<Response> {
    return withHostRateLimitRetry(this.deps.rateLimitBudget, fn, (response) => {
      const retryAfter = retryAfterOfResponse(response);
      if (retryAfter !== null && !this.warnedHeartbeatStatuses.has(429)) {
        this.warnedHeartbeatStatuses.add(429);
        this.deps.log?.(
          `capture: rate limited (HTTP 429) — waiting ${retryAfter}s and retrying; the host's total wait is capped at ${HOST_RATE_LIMIT_BUDGET_MS / 1000}s`,
        );
      }
      return retryAfter;
    });
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
      // R05: the common identity/outcome/attachment fields ride the envelope
      // (ids are opaque tokens; attachments carry a kind and media type, never
      // bytes — nothing here needs the redactor, and the payload still gets it).
      ...(event.ids && Object.keys(event.ids).length ? { ids: event.ids } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.attachments?.length ? { attachments: event.attachments } : {}),
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
    this.persistSkeletonSnapshot();
    this.observedKinds.add(full.kind);
    if (full.kind === "assistant_message") {
      // Read off the REDACTED payload, so the text kept here has already been
      // through the local pass — exactly like a spooled part.
      const text = (full.payload as { text?: unknown })?.text;
      const rawMessageId = (full.payload as { messageId?: unknown })?.messageId;
      const messageId =
        typeof rawMessageId === "string" && rawMessageId.trim()
          ? rawMessageId.trim()
          : (full.ids?.messageId ?? undefined);
      const turnId = full.ids?.turnId;
      if (typeof text === "string" && text.trim().length > 0) {
        // JEN-494 (D12/G4): a streamed message is written as one transcript
        // entry per content block, so keeping "the last assistant_message"
        // stored the last BLOCK and filed a mid-turn fragment as the session's
        // final response. Blocks sharing a `message.id` are joined; an event
        // without one (Codex, an old transcript) keeps the last-wins rule.
        const continues =
          messageId !== undefined &&
          this.lastAssistantMessage?.messageId === messageId;
        // M2 (JEN-537): a plugin-ledger host reports the tool calls a
        // message made ON the message (OpenCode `finish: tool-calls`, Pi
        // `stopReason: toolUse`, counted by the plugin), because its tool
        // events reach the ledger BEFORE the message completes. A host fact,
        // never a guess: absent, the count starts at 0 as before.
        const reportedToolCalls = (full.payload as { toolCalls?: unknown })
          ?.toolCalls;
        this.lastAssistantMessage = {
          text: continues
            ? `${this.lastAssistantMessage!.text}\n${text}`
            : text,
          at: full.at,
          sequence: full.sequence,
          ...(messageId ? { messageId } : {}),
          ...(turnId ? { turnId } : {}),
          toolCalls: continues
            ? this.lastAssistantMessage!.toolCalls
            : typeof reportedToolCalls === "number" && reportedToolCalls > 0
              ? reportedToolCalls
              : 0,
        };
      }
    }
    if (full.kind === "tool_call") {
      // R01: a tool call made by the message we hold marks it MID-TURN — the
      // audit's "Now the card comments naming commit, test and before/after."
      // was exactly such a message, filed as a final response.
      const messageId = full.ids?.messageId;
      if (
        messageId &&
        this.lastAssistantMessage?.messageId === messageId
      ) {
        this.lastAssistantMessage.toolCalls += 1;
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
          // D12: the provider's own stamp beside the monotonic one, so a
          // rollout receipt can be matched against a turn interval replayed
          // from the same transcript clock.
          ...(Number.isFinite(Date.parse(full.at))
            ? { atWall: Date.parse(full.at) }
            : {}),
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

  /**
   * JEN-496 (D11) — the activity skeleton, beside `usage.json`.
   *
   * The skeleton is content-free metadata collected INDEPENDENTLY of TRACE,
   * and TRACE-off is the MVP default — so a capture-off session spools no
   * event parts at all and `jentrix session contact` would have had nothing
   * local to read on exactly the configuration everyone runs. One small file,
   * the same best-effort write as the usage snapshot, 0600 like every spool
   * file. Bounded by the skeleton's own 32 KB cap.
   *
   * Throttled to once a second: a skeleton snapshot per observed EVENT is a
   * write per transcript line, and nothing reads this file at that resolution.
   */
  private lastSkeletonWriteAt = 0;
  private persistSkeletonSnapshot(): void {
    if (!this.skeleton?.observedAnything) return;
    const now = this.now();
    if (now - this.lastSkeletonWriteAt < 1000) return;
    this.lastSkeletonWriteAt = now;
    try {
      writeFileSync(
        join(this.deps.spool.directory, "skeleton.json"),
        JSON.stringify({
          skeleton: this.skeletonSnapshot(),
          updatedAt: this.wall().toISOString(),
        }),
        { mode: 0o600 },
      );
    } catch {
      // Same rule as the usage snapshot: never fail capture over a record.
    }
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
    // Read ONCE: the re-stamp below is only sound if THIS beat carried the
    // model, because it is the beat that writes `session.modelId`, which is
    // what the rebuilt alignment snapshot reads.
    const sentModelId = this.observedModelId;
    try {
      const response = await this.retrying(() =>
        this.fetch()(
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
              ...(sentModelId ? { modelId: sentModelId } : {}),
              // control-room AC4.1: the LIVE usage receipt on the same beat.
              // Sent only once a receipt has actually been observed — an empty
              // rollup would overwrite the session's totals with nulls and
              // report UNAVAILABLE for a session that had already reported.
              ...(this.receipts.length > 0
                ? { usage: this.usageRollup() }
                : {}),
              // Evidence floor (PRD §4/D2): the bounded activity skeleton rides
              // the same beat (tolerant server parse — an old server strips the
              // unknown key). Sent only once something was observed: null column
              // means "never observed", never an empty object.
              ...(this.skeleton?.observedAnything
                ? { activitySkeleton: this.skeletonSnapshot() }
                : {}),
            }),
          },
        ),
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
      if (response.ok && sentModelId && !this.alignmentModelRestamp) {
        // Fire-and-forget: a re-stamp must never delay or fail a heartbeat —
        // but it is KEPT so the close can wait for it (below).
        this.alignmentModelRestamp = this.restampAlignmentModel(sentModelId);
      }
      return response.ok;
    } catch {
      // Offline: the sweep may interrupt server-side; reconnection resumes.
      return false;
    }
  }

  /**
   * AC1.6 — teach the ALIGNMENT what the producer already knows. Runs at most
   * once per host, after the first heartbeat that carried a model (that beat
   * is what set `session.modelId`, which `align_agent_session` copies into the
   * rebuilt snapshot). A same-task re-align: `taskId` is read back and passed
   * through unchanged, so this crosses no attribution boundary and needs no
   * usage flush. Silent on every failure — an unstamped alignment is the
   * status quo, and a host that dies re-stamping is not.
   */
  private async restampAlignmentModel(modelId: string): Promise<void> {
    if (this.alignmentModelRestamped) return;
    this.alignmentModelRestamped = true;
    try {
      const session = (await this.deps.callTool("get_agent_session", {
        sessionId: this.deps.sessionId,
      })) as {
        updatedAt?: unknown;
        taskId?: unknown;
        alignmentSnapshot?: { agent?: { modelId?: unknown } } | null;
      };
      const stamped = session.alignmentSnapshot?.agent?.modelId;
      // Already agrees (or names some other model the operator set): leave it.
      if (typeof stamped === "string" && stamped.trim()) return;
      // JEN-537: not aligned yet — nothing to teach, and the beat that got us
      // here is usually the flush `jentrix session align` requested a moment
      // before ITS OWN `align_agent_session`: a re-stamp write now would race
      // that align into CONFLICT (OpenCode, pack C). The align that follows
      // copies `session.modelId` — which this beat has just set — by itself.
      if (typeof session.taskId !== "string" || !session.taskId) return;
      if (typeof session.updatedAt !== "string") return;
      await this.deps.callTool("align_agent_session", {
        sessionId: this.deps.sessionId,
        taskId: typeof session.taskId === "string" ? session.taskId : null,
        expectedUpdatedAt: session.updatedAt,
      });
      this.deps.log?.(
        `alignment: model re-stamped as ${modelId} (it carried none at align time)`,
      );
    } catch {
      // A CAS race with an operator's own `jentrix session align`, an older
      // server, a revoked bearer: the alignment keeps the null it had.
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
        const response = await this.retrying(() =>
          this.fetch()(
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
          ),
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
   * R01 — the host's view of the closing output: WHICH message, whether it
   * closed its turn, and the identity a retry converges on. Null when no
   * assistant text was observed.
   */
  finalOutputState(): FinalOutputState | null {
    return this.finalOutputStateOf(this.lastAssistantMessage);
  }

  private finalOutputStateOf(
    last: NonNullable<FinalOutputRecord["message"]> | null,
  ): FinalOutputState | null {
    if (!last) return null;
    const turnClosing = last.toolCalls === 0;
    return {
      state: "provisional",
      turnClosing,
      ...(turnClosing
        ? {}
        : {
            reason: `the last observed assistant message made ${last.toolCalls} tool call(s) — a mid-turn progress note, not a turn-closing answer`,
          }),
      ...(last.messageId ? { messageId: last.messageId } : {}),
      ...(last.turnId ? { turnId: last.turnId } : {}),
      sequence: last.sequence,
      observedAt: last.at,
      checksum: createHash("sha256").update(last.text, "utf8").digest("hex"),
    };
  }

  private finalOutputPath(): string {
    return join(this.deps.spool.directory, "final-output.json");
  }

  private readFinalOutputRecord(): FinalOutputRecord | null {
    try {
      const parsed = JSON.parse(readFileSync(this.finalOutputPath(), "utf8")) as FinalOutputRecord;
      return parsed && typeof parsed.attemptId === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * F03 — the durable write is REPORTED when it fails: the upload still
   * proceeds (the output matters more than the record), but the close's
   * coverage names a record that will not survive a restart, instead of the
   * silence the review found.
   */
  private writeFinalOutputRecord(record: FinalOutputRecord): boolean {
    try {
      writeFileSync(this.finalOutputPath(), JSON.stringify(record), { mode: 0o600 });
      return true;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.failures.add(`final output record not durable (${why}) — a restarted host cannot retry this attempt`);
      this.deps.log?.(`final response: the durable record could not be written (${why}) — uploading anyway; a restarted host will not be able to retry this attempt`);
      return false;
    }
  }

  /**
   * AGE-649 / R01 — push the session's PROVISIONAL final output as a typed
   * artifact, DURABLY.
   *
   * Why this exists: with TRACE capture off (the MVP default) a closed session
   * keeps its telemetry and its typed artifacts, and nothing at all holds what
   * the agent concluded. The RUN_SUMMARY cannot carry it — that document is a
   * deterministic server projection and model prose is banned from it (M20.1
   * AC31) — so the output lands as its own artifact, on the same typed-push
   * boundary an operator's `jentrix push report` uses.
   *
   * R01 (JEN-528 finding 1) changed what it IS:
   *   • it is labelled `state: provisional` in a semantic header that names
   *     the provider message/turn identity and a finalization ATTEMPT id —
   *     the host observes; only `jentrix push report --final` certifies;
   *   • the pending→acked state lives in the spool (`final-output.json`)
   *     BEFORE the upload, so a crash or network loss leaves a visible pending
   *     record and a retry converges on the same attempt;
   *   • a refused-close retry of the SAME message re-uses the acked artifact
   *     (no second row); a CHANGED message uploads a replacement that names
   *     its predecessor (`supersedes`), so at most one current output exists;
   *   • an explicit final already on the session wins: the server answers
   *     FINAL_OUTPUT_EXISTS and the host records that instead of competing.
   *
   * Ordering is load-bearing: `COMPLETED` is a SEALED status for typed pushes,
   * so this runs BEFORE `complete_agent_session`, never after. Absence stays
   * absence: no observed assistant text means NO artifact and a declared
   * `missing` on the close — never an empty one.
   */
  async pushFinalResponse(): Promise<FinalOutputDelivery> {
    const prior = this.readFinalOutputRecord();
    // F03: a host started over this spool holds no message in memory. The
    // record IS the message then: an unfinished attempt (pending/failed —
    // the upload never acked, or the ack was lost before the record settled)
    // is retried with the SAME attempt id and the SAME bytes, so the server
    // converges on one artifact; an acked attempt is simply reused.
    let last = this.lastAssistantMessage;
    if (!last && prior) {
      if (prior.delivery === "acked" && prior.artifactId) {
        return { artifactId: prior.artifactId, attemptId: prior.attemptId, delivery: "reused", supersedes: prior.supersedes };
      }
      if (prior.message && (prior.delivery === "pending" || prior.delivery === "failed")) {
        last = prior.message;
        this.deps.log?.(
          `final response: retrying attempt ${prior.attemptId} from the durable record (delivery was ${prior.delivery})`,
        );
      } else if (prior.delivery === "pending" || prior.delivery === "failed") {
        const reason = `attempt ${prior.attemptId} was ${prior.delivery} and its record carries no output text (written before the durable-body fix) — cannot retry`;
        this.failures.add(`final output ${reason}`);
        return { artifactId: null, attemptId: prior.attemptId, delivery: "failed", reason };
      }
    }
    const state = this.finalOutputStateOf(last);
    if (!state || !last) {
      return { artifactId: null, attemptId: null, delivery: "none", reason: "no assistant text was observed by the host" };
    }
    if (prior && prior.checksum === state.checksum) {
      if (prior.delivery === "acked" && prior.artifactId) {
        return { artifactId: prior.artifactId, attemptId: prior.attemptId, delivery: "reused", supersedes: prior.supersedes };
      }
      if (prior.delivery === "final-exists" && prior.artifactId) {
        return { artifactId: prior.artifactId, attemptId: prior.attemptId, delivery: "final-exists" };
      }
    }
    const sameAttempt = prior && prior.checksum === state.checksum && (prior.delivery === "pending" || prior.delivery === "failed");
    const attemptId = sameAttempt ? prior!.attemptId : randomUUID();
    // A retried attempt keeps the predecessor it was first written with; a
    // NEW attempt replaces whatever was acked before it.
    const supersedes = sameAttempt
      ? prior!.supersedes
      : prior && prior.delivery === "acked" && prior.artifactId && prior.checksum !== state.checksum
        ? prior.artifactId
        : null;
    const now = this.wall().toISOString();
    const record: FinalOutputRecord = {
      attemptId,
      messageId: state.messageId ?? null,
      turnId: state.turnId ?? null,
      sequence: state.sequence,
      checksum: state.checksum,
      message: {
        text: last.text,
        at: last.at,
        sequence: last.sequence,
        toolCalls: last.toolCalls,
        ...(last.messageId ? { messageId: last.messageId } : {}),
        ...(last.turnId ? { turnId: last.turnId } : {}),
      },
      delivery: "pending",
      artifactId: null,
      supersedes,
      reason: null,
      updatedAt: now,
      attempts: [
        ...(prior?.attempts ?? []).slice(-20),
        { attemptId, checksum: state.checksum, delivery: "pending", artifactId: null, at: now },
      ],
    };
    // The payload is built ONCE per attempt and stored with the record: a
    // retry re-sends the stored bytes, never a rebuilt document.
    const body =
      sameAttempt && typeof prior!.body === "string"
        ? prior!.body
        : withSemanticHeader(
            {
              kind: "final-output",
              attemptId,
              ...(state.messageId ? { messageId: state.messageId } : {}),
              ...(state.turnId ? { turnId: state.turnId } : {}),
              sequence: state.sequence,
              observedAt: state.observedAt,
              state: "provisional",
              turnClosing: state.turnClosing,
              ...(state.reason ? { reason: state.reason } : {}),
              ...(supersedes ? { supersedes } : {}),
              producer: "session-host",
              provider: this.deps.provider,
            },
            this.finalResponseBody(last),
          );
    record.body = body;
    // Durable pending BEFORE the network: a crash here leaves a record that
    // says exactly what was about to be delivered — bytes included.
    this.writeFinalOutputRecord(record);
    const settle = (patch: Partial<FinalOutputRecord>): void => {
      const at = this.wall().toISOString();
      const attempts = record.attempts.map((a) =>
        a.attemptId === attemptId ? { ...a, delivery: patch.delivery ?? a.delivery, artifactId: patch.artifactId ?? a.artifactId, at } : a,
      );
      this.writeFinalOutputRecord({ ...record, ...patch, attempts, updatedAt: at });
    };
    const bearer = this.bearerOf();
    try {
      const response = await this.retrying(() =>
        this.fetch()(
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
              title: `Final response (provisional) — session ${this.deps.sessionId.slice(-8)}`,
              body,
            }),
          },
        ),
      );
      const ack = (await response.json().catch(() => null)) as {
        artifactId?: string;
        error?: string;
        detail?: string;
        currentFinalArtifactId?: string;
      } | null;
      if (response.ok && ack?.artifactId) {
        settle({ delivery: "acked", artifactId: ack.artifactId });
        return { artifactId: ack.artifactId, attemptId, delivery: "acked", supersedes };
      }
      if (response.status === 401) {
        void this.deps.onUnauthorized?.(bearer)?.catch(() => undefined);
      }
      const message = `${ack?.error ?? ""} ${ack?.detail ?? ""}`;
      if (response.status === 409 && message.includes("FINAL_OUTPUT_EXISTS")) {
        const current = ack?.currentFinalArtifactId ?? null;
        settle({ delivery: "final-exists", artifactId: current });
        this.deps.log?.(
          `final response: an explicit final output already exists on this session (${current ?? "id unknown"}) — the host's provisional copy was not stored`,
        );
        return { artifactId: current, attemptId, delivery: "final-exists" };
      }
      const reason = `not stored (HTTP ${response.status}${message.trim() ? ` ${message.trim()}` : ""})`;
      settle({ delivery: "failed", reason });
      this.failures.add(`final output ${reason}`);
      this.deps.log?.(
        `final response: ${reason} — the session's closing output was not preserved; the pending record is kept in the spool for a retry`,
      );
      return { artifactId: null, attemptId, delivery: "failed", reason };
    } catch (error) {
      const reason = `not stored (${error instanceof Error ? error.message : "unknown"})`;
      settle({ delivery: "failed", reason });
      this.failures.add(`final output ${reason}`);
      this.deps.log?.(
        `final response: ${reason} — the session's closing output was not preserved; the pending record is kept in the spool for a retry`,
      );
      return { artifactId: null, attemptId, delivery: "failed", reason };
    }
  }

  /**
   * The stored document under the semantic header. Self-describing on
   * purpose: a reader has to be able to tell this apart from the RUN_SUMMARY
   * sitting beside it, and has to know it is verbatim provider output rather
   * than anything the server derived.
   *
   * Bounded here as well as server-side, and a truncation SAYS so (R07) — an
   * artifact silently missing its tail is worse than one that names the cut.
   */
  private finalResponseBody(last: {
    text: string;
    at: string;
    sequence: number;
    toolCalls: number;
  }): string {
    const header = [
      `# Final response (provisional) — session ${this.deps.sessionId}`,
      "",
      `The last assistant message this session's host observed before close (event ${last.sequence}, ${last.at}).`,
      last.toolCalls > 0
        ? `It made ${last.toolCalls} tool call(s) after this text, so it is a MID-TURN progress note, not a turn-closing answer.`
        : "It closed its turn (no tool calls followed it).",
      "Verbatim provider output — redacted on this machine and again on arrival. Provisional: an explicit `jentrix push report --final` is the certified deliverable.",
      "This is model prose, not a server projection: the RUN_SUMMARY artifact is the deterministic record of what the session did.",
      "",
      "---",
      "",
    ].join("\n");
    const room = MAX_FINAL_RESPONSE_BYTES - Buffer.byteLength(header, "utf8") - 512;
    const originalBytes = Buffer.byteLength(last.text, "utf8");
    if (originalBytes <= room) return header + last.text;
    const notice = (retained: number) =>
      `\n\n[truncated: the response was ${originalBytes} bytes; ${retained} retained by the ${MAX_FINAL_RESPONSE_BYTES / 1024 / 1024} MiB artifact limit — the complete text remains in the local provider transcript]`;
    const kept = Buffer.from(last.text, "utf8")
      .subarray(0, Math.max(0, room - Buffer.byteLength(notice(originalBytes), "utf8")))
      .toString("utf8")
      // A byte-slice can cut a multi-byte character in half; drop the
      // replacement char it decodes to rather than storing mojibake.
      .replace(/�+$/, "");
    this.truncations.add(`final output truncated to ${Buffer.byteLength(kept, "utf8")} of ${originalBytes} bytes`);
    return header + kept + notice(Buffer.byteLength(kept, "utf8"));
  }

  /**
   * R05 — the coverage classes for this session, by name: what was observed,
   * what this adapter cannot observe, what consent withheld (TRACE off), what
   * a cap cut, and what failed. Reported on the close so a reader never
   * infers completeness from a green token-receipt coverage.
   */
  coverageReport(pendingParts = 0): CoverageReport {
    const traceOff = this.deps.traceCapture === false;
    const skeleton = this.skeleton?.observedAnything ? this.skeletonSnapshot() : null;
    const truncated = [...this.truncations];
    if (skeleton?.truncated) truncated.push("activity skeleton coalesced at its caps");
    if (skeleton?.filesTouched && skeleton.filesTouched.totalExact === false) {
      truncated.push("files-touched total is a floor (overflow identity cap)");
    }
    const failed = [...this.failures];
    if (pendingParts > 0) failed.push(`${pendingParts} trace part(s) not acknowledged`);
    return {
      observed: [...this.observedKinds].sort(),
      unsupported: [
        ...(this.capability?.notObservable ?? []),
        ...(this.capability?.unsupported ?? []),
      ],
      omittedByConsent: traceOff
        ? ["prompt bodies", "tool arguments and results", "assistant message bodies", "transcript parts"]
        : [],
      truncated,
      failed,
    };
  }

  /**
   * D12 — the skeleton with the provider-turn count folded in. One place, so
   * every submission path reports the same `turns`.
   */
  private skeletonSnapshot() {
    this.skeleton?.noteProviderTurns(this.providerTurns.size);
    return this.skeleton?.snapshot();
  }

  /** Flush the spool-side skeleton past its throttle (close, forced beat). */
  flushSkeletonSnapshot(): void {
    this.lastSkeletonWriteAt = 0;
    this.persistSkeletonSnapshot();
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
   * JEN-457 — call `complete_agent_session`, and if THIS server does not know
   * `captureOff`, drop it and close anyway.
   *
   * The server rejects unknown parameters outright (`INVALID_INPUT: Unknown
   * parameter "captureOff" for this tool`), and the CLI is released separately
   * from the app — so a client carrying the field would fail every capture-off
   * close against a deployment that has not caught up. Losing the close is far
   * worse than losing the declaration: without it the server falls back to the
   * alignment snapshot, which is exactly the behaviour that server already has.
   *
   * Deliberately NOT a generic strip-and-retry: only this one field, only on
   * the error that names it. Anything else is a real refusal and propagates.
   */
  private async completeWithFallback(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // The optional close fields a server may predate, oldest first. R01/R05
    // (finalOutput, coverage) join captureOff under the SAME rule: only the
    // named field, only on the error that names it, at most once each.
    const optional = [
      "captureOff",
      "finalOutput",
      "coverage",
      "endTreeDigest",
      "uncommittedPatchArtifactId",
    ] as const;
    let current = args;
    for (let round = 0; round <= optional.length; round += 1) {
      try {
        return await this.deps.callTool("complete_agent_session", current);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const named = optional.find((field) => field in current && message.includes(field));
        if (!named) throw error;
        const { [named]: _dropped, ...rest } = current;
        current = rest;
        this.deps.log?.(
          named === "captureOff"
            ? "capture: this server does not accept `captureOff` — closing without it (the capture-off verdict falls back to the alignment snapshot)"
            : `close: this server predates \`${named}\` — closing without it; ${named === "finalOutput" ? "the final-output acknowledgement" : named === "coverage" ? "the coverage report" : "the tree binding"} is recorded locally only`,
        );
      }
    }
    return this.deps.callTool("complete_agent_session", current);
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
    /**
     * F02 — the scoped digest of the working tree at THIS close (a clean
     * tree has one too; null = the checkout could not be read) and the
     * attested uncommitted patch `session end --preserve-uncommitted` pushed.
     */
    endTreeDigest?: string | null;
    uncommittedPatchArtifactId?: string | null;
  }): Promise<{
    status: string;
    captureComplete: boolean;
    summaryArtifactId: string | null;
    /** AGE-649 — null when the host observed no assistant text to store. */
    finalResponseArtifactId: string | null;
    /** R01 — how the closing output was delivered, for the host's log line. */
    finalOutput: FinalOutputDelivery;
    pendingParts: number;
  }> {
    const { pending } = await this.flushParts();
    // Evidence floor (PRD §4): the close path finalizes the skeleton with a
    // FORCED beat (the 30 s window would swallow a plain one) while the
    // session is still open — the heartbeat route only writes open sessions.
    // Also the close-time usage flush the Codex host used to make on its own.
    await this.flushUsageNow().catch(() => false);
    // JEN-537 (Pi native trial): that forced beat is often the FIRST to carry
    // a model on a host that learns it late (Pi: at `turn_end`), so it starts
    // the alignment re-stamp — a write that moves `updatedAt`. Wait for it
    // before reading the row below, or the close's CAS lands on a stale
    // `expectedUpdatedAt` and the session falls back to a server-side close
    // without this host's coverage and final-output declaration.
    await this.alignmentModelRestamp;
    this.flushSkeletonSnapshot();
    // AGE-649: BEFORE the completion call — `COMPLETED` seals the session
    // against typed pushes, so there is no "after" for this. R01: durable,
    // identity-bearing, idempotent across a refused-close retry.
    const finalOutput = await this.pushFinalResponse();
    const finalResponseArtifactId = finalOutput.artifactId;
    const preserved =
      finalOutput.artifactId !== null &&
      (finalOutput.delivery === "acked" ||
        finalOutput.delivery === "reused" ||
        finalOutput.delivery === "final-exists");
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
    const completeArgs: Record<string, unknown> = {
      sessionId: this.deps.sessionId,
      outcome: opts.outcome,
      endBranch: opts.end.branch,
      endHead: opts.end.head,
      endDirty: opts.end.dirty,
      captureError,
      // JEN-457: say so explicitly rather than leaving the server to infer
      // capture-off from an alignment snapshot a never-aligned session lacks.
      ...(traceOff ? { captureOff: true } : {}),
      ...(opts.acknowledgeEvidenceGaps
        ? { acknowledgeEvidenceGaps: true }
        : {}),
      ...(typeof opts.commitCount === "number"
        ? { commitCount: opts.commitCount }
        : {}),
      ...(manifest ? { manifest } : {}),
      // F02 / R04: bind the close to the tree — additive, dropped on a server
      // that predates them (completeWithFallback).
      ...(opts.endTreeDigest ? { endTreeDigest: opts.endTreeDigest } : {}),
      ...(opts.uncommittedPatchArtifactId
        ? { uncommittedPatchArtifactId: opts.uncommittedPatchArtifactId }
        : {}),
      // R01: the completion claim references the ACKNOWLEDGED current output
      // of THIS attempt, or declares the gap — never silence.
      finalOutput: preserved
        ? {
            artifactId: finalOutput.artifactId,
            ...(finalOutput.attemptId ? { attemptId: finalOutput.attemptId } : {}),
          }
        : { missing: finalOutput.reason ?? finalOutput.delivery },
      // R05: coverage by class, beside the token-receipt coverage below.
      coverage: this.coverageReport(pending),
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
    };
    const result = (await this.completeWithFallback(completeArgs)) as {
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
    // A successful close retires the durable final-output record: the
    // server holds the acknowledged artifact, and a NEXT session's host must
    // not inherit this one's attempt.
    try {
      unlinkSync(this.finalOutputPath());
    } catch {
      // absent — nothing was pushed, or a retry will find nothing to reuse
    }
    return {
      status: result.status ?? opts.outcome,
      captureComplete: Boolean(result.captureComplete),
      summaryArtifactId: result.summaryArtifactId ?? null,
      finalResponseArtifactId,
      finalOutput,
      pendingParts: pending,
    };
  }
}
