/** Pure mapping from supported Codex lifecycle hook payloads to session events. */

import type {
  SessionEventIds,
  SessionEventKind,
  SessionEventOutcome,
} from "./session-events.js";

export interface MappedCodexHook {
  events: Array<{
    kind: SessionEventKind;
    payload: unknown;
    /** R05 — common correlation ids read off the hook payload. */
    ids?: SessionEventIds;
    outcome?: SessionEventOutcome;
  }>;
  modelId: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * R05 — the tool-call identity Codex stamps on a PostToolUse payload. Codex
 * has used `tool_use_id`, `call_id` and `id` across releases; the first
 * present one wins and the raw payload keeps whichever it carried.
 */
function toolCallIdOf(payload: Record<string, unknown>): string | null {
  return (
    text(payload.tool_use_id) ?? text(payload.call_id) ?? text(payload.id)
  );
}

/** ok/error from the tool response's exit code or error field, when present. */
function toolOutcomeOf(response: unknown): SessionEventOutcome | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as { exit_code?: unknown; error?: unknown; cancelled?: unknown };
  if (r.cancelled === true) return "cancelled";
  if (typeof r.exit_code === "number") return r.exit_code === 0 ? "ok" : "error";
  if (r.error) return "error";
  return "ok";
}

export function mapCodexHook(
  event: string,
  payload: Record<string, unknown>,
): MappedCodexHook {
  const modelId = text(payload.model);
  switch (event) {
    case "SessionStart":
    case "SessionEnd":
    case "PreCompact":
    case "PostCompact":
      return {
        events: [
          {
            kind: "session",
            payload: {
              lifecycle: event,
              sessionId: payload.session_id ?? null,
            },
          },
        ],
        modelId,
      };
    case "UserPromptSubmit": {
      const prompt = text(payload.prompt);
      return {
        events: prompt
          ? [{ kind: "user_message", payload: { text: prompt } }]
          : [],
        modelId,
      };
    }
    case "PostToolUse": {
      const name = text(payload.tool_name) ?? "unknown";
      const toolCallId = toolCallIdOf(payload);
      const turnId = text(payload.turn_id);
      const ids: SessionEventIds = {
        ...(toolCallId ? { toolCallId } : {}),
        ...(turnId ? { turnId } : {}),
      };
      const withIds = Object.keys(ids).length ? { ids } : {};
      const events: MappedCodexHook["events"] = [
        {
          kind: "tool_call",
          payload: {
            name,
            input: payload.tool_input ?? null,
            // The correlation id also stays in the provider payload so a
            // reader of the raw shape sees what Codex actually sent.
            ...(toolCallId ? { toolCallId } : {}),
          },
          ...withIds,
        },
      ];
      if ("tool_response" in payload) {
        const outcome = toolOutcomeOf(payload.tool_response);
        events.push({
          kind: "tool_result",
          payload: {
            name,
            result: payload.tool_response,
            ...(toolCallId ? { toolCallId } : {}),
          },
          ...withIds,
          ...(outcome ? { outcome } : {}),
        });
      }
      return { events, modelId };
    }
    case "Stop": {
      const message = text(payload.last_assistant_message);
      const turnId = text(payload.turn_id);
      return {
        events: message
          ? [
              {
                kind: "assistant_message",
                payload: { text: message },
                ...(turnId ? { ids: { turnId } } : {}),
              },
            ]
          : [],
        modelId,
      };
    }
    default:
      return { events: [], modelId };
  }
}
