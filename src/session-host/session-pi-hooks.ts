/**
 * Pure mapping from the Pi extension's ledger lines to session events (M2,
 * JEN-537). `@jentrix/plugin-pi` runs INSIDE Pi and appends one NDJSON line
 * per observed extension event to the provider ledger
 * (`~/.config/stacks/pi-sessions/hooks.ndjson`); the watch host maps each
 * line here. Same vocabulary as the OpenCode ledger.
 *
 * Token semantics from the S0b native proof: Pi 0.85.1 reports
 * `usage.input` WITHOUT the cached prompt and `usage.output` INCLUDING the
 * reasoning tokens (`usage.reasoning` is a separate subset), one `usage`
 * per finalised assistant message whose session ENTRY id is only known at
 * `turn_end` (the extension resolves it there), plus one `usage` on each
 * compaction / branch-summary entry. The receipt id is the entry id, so a
 * fork (which copies entries with their ORIGINAL ids) can never recharge
 * inherited history: those entries produce no live event, and a replayed
 * id dedupes.
 */

import type { MappedPluginHook } from "./session-opencode-hooks.js";
import type { SessionEventIds, SessionEventOutcome } from "./session-events.js";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function wallOf(payload: Record<string, unknown>): {
  at?: string;
  ms: number | null;
} {
  const raw = payload.at_wall;
  const ms =
    typeof raw === "number" && Number.isFinite(raw)
      ? raw
      : typeof raw === "string" && Number.isFinite(Date.parse(raw))
        ? Date.parse(raw)
        : null;
  return ms === null ? { ms: null } : { at: new Date(ms).toISOString(), ms };
}

/** `provider/model` as Pi names a model. */
export function piModelIdOf(payload: Record<string, unknown>): string | null {
  const model = text(payload.model);
  if (!model) return null;
  const provider = text(payload.provider);
  return model.includes("/") || !provider ? model : `${provider}/${model}`;
}

const LIFECYCLE = new Set([
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
]);

export function mapPiHook(
  event: string,
  payload: Record<string, unknown>,
): MappedPluginHook {
  const modelId = piModelIdOf(payload);
  const sessionId = text(payload.session_id);
  const turnId = text(payload.turn_id);
  const messageId = text(payload.message_id);
  const wall = wallOf(payload);
  const withAt = wall.at ? { at: wall.at } : {};
  if (LIFECYCLE.has(event)) {
    const parent = text(payload.parent_session_file);
    return {
      events: [
        {
          kind: "session",
          payload: {
            lifecycle: event,
            sessionId,
            ...(text(payload.reason) ? { reason: payload.reason } : {}),
            ...(text(payload.session_file)
              ? { sessionFile: payload.session_file }
              : {}),
            ...(parent ? { parentSessionFile: parent } : {}),
          },
          ...withAt,
        },
      ],
      modelId,
      turn: null,
    };
  }
  if (event === "TurnStart" || event === "TurnEnd") {
    return {
      events: [],
      modelId,
      turn:
        turnId && wall.ms !== null
          ? {
              id: turnId,
              phase: event === "TurnStart" ? "started" : "completed",
              at: wall.ms,
            }
          : null,
    };
  }
  if (event === "UserPromptSubmit") {
    const prompt = text(payload.prompt);
    return {
      events: prompt
        ? [
            {
              kind: "user_message",
              payload: {
                text: prompt,
                ...(text(payload.source) ? { source: payload.source } : {}),
                ...(payload.injected === true ? { injected: true } : {}),
              },
              ...(turnId ? { ids: { turnId } } : {}),
              ...withAt,
            },
          ]
        : [],
      modelId,
      turn: null,
    };
  }
  if (event === "PostToolUse") {
    const name = text(payload.tool_name) ?? "unknown";
    const toolCallId = text(payload.tool_use_id);
    const ids: SessionEventIds = {
      ...(toolCallId ? { toolCallId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(messageId ? { messageId } : {}),
    };
    const withIds = Object.keys(ids).length ? { ids } : {};
    const response = payload.tool_response as
      | { isError?: unknown }
      | undefined;
    const outcome: SessionEventOutcome | undefined =
      response === undefined
        ? undefined
        : response && typeof response === "object" && response.isError === true
          ? "error"
          : "ok";
    const events: MappedPluginHook["events"] = [
      {
        kind: "tool_call",
        payload: {
          name,
          input: payload.tool_input ?? null,
          ...(toolCallId ? { toolCallId } : {}),
        },
        ...withIds,
        ...(toolCallId ? { providerEventId: `pi:tool:${toolCallId}:call` } : {}),
        ...withAt,
      },
    ];
    if ("tool_response" in payload) {
      events.push({
        kind: "tool_result",
        payload: {
          name,
          result: payload.tool_response,
          ...(toolCallId ? { toolCallId } : {}),
        },
        ...withIds,
        ...(outcome ? { outcome } : {}),
        ...(toolCallId
          ? { providerEventId: `pi:tool:${toolCallId}:result` }
          : {}),
        ...withAt,
      });
    }
    return { events, modelId, turn: null };
  }
  if (event === "Stop") {
    const message = text(payload.last_assistant_message);
    const ids: SessionEventIds = {
      ...(turnId ? { turnId } : {}),
      ...(messageId ? { messageId } : {}),
    };
    return {
      events: message
        ? [
            {
              kind: "assistant_message",
              payload: {
                text: message,
                ...(messageId ? { messageId } : {}),
                ...(text(payload.stop_reason)
                  ? { stopReason: payload.stop_reason }
                  : {}),
                // The extension counts the message's toolCall blocks.
                ...(count(payload.tool_calls) !== null
                  ? { toolCalls: payload.tool_calls }
                  : {}),
              },
              ...(Object.keys(ids).length ? { ids } : {}),
              ...(messageId ? { providerEventId: `pi:entry:${messageId}:stop` } : {}),
              ...withAt,
            },
          ]
        : [],
      modelId,
      turn: null,
    };
  }
  if (event === "Usage") {
    if (payload.inherited === true) return { events: [], modelId, turn: null };
    const usage = payload.usage as
      | {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
          reasoning?: unknown;
        }
      | undefined;
    const input = count(usage?.input);
    const output = count(usage?.output);
    const entryId = text(payload.entry_id) ?? messageId;
    if (input === null || output === null || !entryId) {
      return { events: [], modelId, turn: null };
    }
    const cacheRead = count(usage?.cacheRead);
    const cacheWrite = count(usage?.cacheWrite);
    const reasoning = count(usage?.reasoning);
    return {
      events: [
        {
          kind: "usage",
          payload: {
            kind: "delta",
            // Pi subtracts the cached prompt from `input` (added back here as a
            // subset) and already INCLUDES reasoning in `output` (S0b).
            inputTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
            outputTokens: output,
            ...(cacheRead !== null ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite !== null ? { cacheCreationTokens: cacheWrite } : {}),
            ...(reasoning !== null ? { reasoningOutputTokens: reasoning } : {}),
            ...(modelId ? { modelId } : {}),
            ...(turnId ? { turnId } : {}),
            messageId: entryId,
            ...(text(payload.kind) ? { entryKind: payload.kind } : {}),
          },
          ids: { messageId: entryId, ...(turnId ? { turnId } : {}) },
          providerEventId: `pi:entry:${entryId}:usage`,
          ...withAt,
        },
      ],
      modelId,
      turn: null,
    };
  }
  if (event === "Error") {
    return {
      events: [
        {
          kind: "error",
          payload: {
            name: text(payload.name) ?? "unknown",
            ...(text(payload.message) ? { message: payload.message } : {}),
          },
          outcome: "error",
          ...withAt,
        },
      ],
      modelId,
      turn: null,
    };
  }
  return { events: [], modelId, turn: null };
}
