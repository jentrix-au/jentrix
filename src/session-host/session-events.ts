/**
 * M20.1 §12.1 — the observable-event envelope (version 1). An EVIDENCE
 * serialization, not a workflow state machine: adapters map only observable
 * provider event SHAPES onto it; consumers rely on the small common envelope
 * and treat provider-native detail as opaque versioned payload.
 */

export const SESSION_EVENT_VERSION = 1 as const;

export type SessionEventKind =
  | "session"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "command"
  | "file_change"
  | "plan"
  | "usage"
  | "error";

/**
 * R05 (prds/opencode-pi-plugins-prd.md §4.1) — the COMMON typed identity and
 * outcome fields every adapter fills when its host exposes them. The opaque
 * `payload` keeps the provider's own shape (an extension, never the
 * contract); these three are what a consumer may correlate on without
 * knowing which host produced the event. Absent = the host did not expose
 * it, which the capability snapshot's coverage names — never a silent gap.
 */
export interface SessionEventIds {
  /** The provider turn (Codex `turn_id`; a Claude turn id when known). */
  turnId?: string;
  /** The API/provider message this event belongs to (Claude `message.id`). */
  messageId?: string;
  /** The tool call this call/result pairs on (Claude `tool_use_id`, Codex call id). */
  toolCallId?: string;
  /** The parent session for child/sidechain work, when the host names one. */
  parentSessionId?: string;
}

export type SessionEventOutcome = "ok" | "error" | "cancelled";

export interface SessionEventAttachment {
  kind: "image" | "document" | "file" | "other";
  mediaType?: string;
  /** A reference the host gave (path/id) — never the bytes. */
  ref?: string;
}

export interface SessionEvent {
  version: typeof SESSION_EVENT_VERSION;
  /** Monotonic per-session sequence, assigned by the local bridge. */
  sequence: number;
  /** UTC ISO timestamp for display/audit (durations use the monotonic clock). */
  at: string;
  provider: "claude" | "codex";
  providerEventId?: string;
  kind: SessionEventKind;
  /** R05 — common correlation ids, when the host exposed them. */
  ids?: SessionEventIds;
  /** R05 — the result state of a tool/turn, when the host exposed it. */
  outcome?: SessionEventOutcome;
  /** R05 — non-text input the host carried (image-only prompts, files). */
  attachments?: SessionEventAttachment[];
  payload: unknown;
}

export const SESSION_EVENT_KINDS: readonly SessionEventKind[] = [
  "session",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "command",
  "file_change",
  "plan",
  "usage",
  "error",
];

/** One NDJSON line (the spool/TRACE serialization). Deterministic key order. */
export function serializeSessionEvent(event: SessionEvent): string {
  return `${JSON.stringify({
    version: event.version,
    sequence: event.sequence,
    at: event.at,
    provider: event.provider,
    ...(event.providerEventId
      ? { providerEventId: event.providerEventId }
      : {}),
    kind: event.kind,
    ...(event.ids && Object.keys(event.ids).length ? { ids: event.ids } : {}),
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.attachments?.length ? { attachments: event.attachments } : {}),
    payload: event.payload,
  })}\n`;
}

/** Parse one spool line back; null for anything that is not a v1 envelope. */
export function parseSessionEvent(line: string): SessionEvent | null {
  try {
    const parsed = JSON.parse(line) as SessionEvent;
    if (
      parsed?.version !== SESSION_EVENT_VERSION ||
      typeof parsed.sequence !== "number" ||
      typeof parsed.at !== "string" ||
      (parsed.provider !== "claude" && parsed.provider !== "codex") ||
      !SESSION_EVENT_KINDS.includes(parsed.kind)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
