/** Pure mapping from supported Codex lifecycle hook payloads to session events. */

import type { SessionEventKind } from "./session-events.js";

export interface MappedCodexHook {
  events: Array<{ kind: SessionEventKind; payload: unknown }>;
  modelId: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
      const events: MappedCodexHook["events"] = [
        {
          kind: "tool_call",
          payload: { name, input: payload.tool_input ?? null },
        },
      ];
      if ("tool_response" in payload) {
        events.push({
          kind: "tool_result",
          payload: { name, result: payload.tool_response },
        });
      }
      return { events, modelId };
    }
    case "Stop": {
      const message = text(payload.last_assistant_message);
      return {
        events: message
          ? [{ kind: "assistant_message", payload: { text: message } }]
          : [],
        modelId,
      };
    }
    default:
      return { events: [], modelId };
  }
}
