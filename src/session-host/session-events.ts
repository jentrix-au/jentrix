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

export interface SessionEvent {
  version: typeof SESSION_EVENT_VERSION;
  /** Monotonic per-session sequence, assigned by the local bridge. */
  sequence: number;
  /** UTC ISO timestamp for display/audit (durations use the monotonic clock). */
  at: string;
  provider: "claude" | "codex";
  providerEventId?: string;
  kind: SessionEventKind;
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
