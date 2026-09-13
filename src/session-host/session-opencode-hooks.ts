/**
 * Pure mapping from the OpenCode plugin's ledger lines to session events
 * (M2, JEN-537). `@jentrix/plugin-opencode` runs INSIDE OpenCode and appends
 * one NDJSON line per observed host hook/event to the provider ledger
 * (`~/.config/stacks/opencode-sessions/hooks.ndjson`, the same file shape
 * `appendHookEvent` writes); the watch host reads it exactly as it reads the
 * Codex ledger and maps each line here. The event NAMES reuse the lifecycle
 * vocabulary the host already understands (SessionStart, UserPromptSubmit,
 * PostToolUse, Stop, PreCompact, PostCompact, SessionEnd) plus `TurnStart`/
 * `TurnEnd` (intervals) and `Usage` (one receipt per `step-finish` part).
 *
 * Token semantics come from the S0b native proof (reports/plugin-sync-
 * 2026-09-12/m2-s0b-native-proof.md in task-manager): OpenCode 1.18.9 reports
 * `tokens.input` WITHOUT the cached prompt and `tokens.output` WITHOUT the
 * reasoning tokens (both subtracted from the provider's totals), one
 * `step-finish` part per assistant message and `message.tokens` equal to
 * that single step. The receipt therefore ADDS cache and reasoning back so
 * `inputTokens`/`outputTokens` carry the same totals the Claude mapper
 * carries (cache and reasoning are disjoint SUBSETS of them), and never
 * reads `message.tokens` on top of the step-finish part. A part the plugin
 * marks `inherited` (replayed history on a fork: new ids, original
 * timestamps) yields no receipt — the receipt hazard S0b recorded.
 */

import type {
  SessionEventIds,
  SessionEventKind,
  SessionEventOutcome,
} from "./session-events.js";

export interface MappedPluginHook {
  events: Array<{
    kind: SessionEventKind;
    payload: unknown;
    ids?: SessionEventIds;
    outcome?: SessionEventOutcome;
    providerEventId?: string;
    /** The provider's own wall-clock stamp for the event, when it carried one. */
    at?: string;
  }>;
  modelId: string | null;
  /** A provider turn boundary the host pairs into an interval. */
  turn: { id: string; phase: "started" | "completed"; at: number } | null;
}

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

/** `providerID/modelID` as OpenCode names a model; the bridge groups receipts by it. */
export function openCodeModelIdOf(model: unknown): string | null {
  if (!model || typeof model !== "object") return null;
  const m = model as { providerID?: unknown; modelID?: unknown };
  const provider = text(m.providerID);
  const id = text(m.modelID);
  return id ? (provider ? `${provider}/${id}` : id) : null;
}

const LIFECYCLE = new Set([
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
]);

/**
 * The opening prompt of ONE session from a plugin ledger (OpenCode or Pi):
 * the first `UserPromptSubmit` the plugin wrote for that session id that was
 * typed by the operator — never a prompt the plugin itself injected for a
 * workflow command (`injected: true`). Reads the whole ledger, like the
 * Claude path reads the whole transcript, because the opening prompt
 * precedes the attach offset the watch host tails from.
 */
export function ledgerOpeningPromptOf(
  body: string,
  sessionId: string,
): string | null {
  for (const raw of body.split("\n")) {
    if (!raw.trim()) continue;
    let line: { event?: unknown; payload?: Record<string, unknown> };
    try {
      line = JSON.parse(raw) as typeof line;
    } catch {
      continue; // a truncated tail line is not a verdict
    }
    if (line.event !== "UserPromptSubmit") continue;
    const payload = line.payload ?? {};
    if (payload.session_id !== sessionId || payload.injected === true) continue;
    const prompt = text(payload.prompt);
    if (prompt) return prompt;
  }
  return null;
}

export function mapOpenCodeHook(
  event: string,
  payload: Record<string, unknown>,
): MappedPluginHook {
  const modelId = openCodeModelIdOf(payload.model);
  const sessionId = text(payload.session_id);
  const turnId = text(payload.turn_id);
  const messageId = text(payload.message_id);
  const wall = wallOf(payload);
  const withAt = wall.at ? { at: wall.at } : {};
  if (LIFECYCLE.has(event)) {
    return {
      events: [
        {
          kind: "session",
          payload: {
            lifecycle: event,
            sessionId,
            ...(text(payload.reason) ? { reason: payload.reason } : {}),
            ...(text(payload.parent_session_id)
              ? { parentSessionId: payload.parent_session_id }
              : {}),
          },
          ...(text(payload.parent_session_id)
            ? { ids: { parentSessionId: payload.parent_session_id as string } }
            : {}),
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
    const ids: SessionEventIds = {
      ...(turnId ? { turnId } : {}),
      ...(messageId ? { messageId } : {}),
    };
    return {
      events: prompt
        ? [
            {
              kind: "user_message",
              payload: {
                text: prompt,
                ...(text(payload.agent) ? { agent: payload.agent } : {}),
                ...(payload.injected === true ? { injected: true } : {}),
              },
              ...(Object.keys(ids).length ? { ids } : {}),
              ...(messageId ? { providerEventId: `oc:msg:${messageId}` } : {}),
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
      | { error?: unknown; output?: unknown; title?: unknown }
      | undefined;
    const outcome: SessionEventOutcome | undefined =
      response === undefined
        ? undefined
        : response && typeof response === "object" && response.error
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
        ...(toolCallId ? { providerEventId: `oc:tool:${toolCallId}:call` } : {}),
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
          ? { providerEventId: `oc:tool:${toolCallId}:result` }
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
                ...(text(payload.finish) ? { finish: payload.finish } : {}),
                // The plugin counts the message's tool parts (S0b: tool
                // events precede the message's completion in the ledger).
                ...(count(payload.tool_calls) !== null
                  ? { toolCalls: payload.tool_calls }
                  : {}),
              },
              ...(Object.keys(ids).length ? { ids } : {}),
              ...(messageId ? { providerEventId: `oc:msg:${messageId}:stop` } : {}),
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
    const tokens = payload.tokens as
      | {
          input?: unknown;
          output?: unknown;
          reasoning?: unknown;
          cache?: { read?: unknown; write?: unknown };
        }
      | undefined;
    const input = count(tokens?.input);
    const output = count(tokens?.output);
    const partId = text(payload.part_id);
    if (input === null || output === null || !partId) {
      return { events: [], modelId, turn: null };
    }
    const cacheRead = count(tokens?.cache?.read);
    const cacheWrite = count(tokens?.cache?.write);
    const reasoning = count(tokens?.reasoning);
    return {
      events: [
        {
          kind: "usage",
          payload: {
            kind: "delta",
            // OpenCode subtracts the cached prompt from `input` and the
            // reasoning tokens from `output` (S0b); the receipt carries the
            // provider totals, with both as disjoint subsets.
            inputTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
            outputTokens: output + (reasoning ?? 0),
            ...(cacheRead !== null ? { cacheReadTokens: cacheRead } : {}),
            ...(cacheWrite !== null ? { cacheCreationTokens: cacheWrite } : {}),
            ...(reasoning !== null ? { reasoningOutputTokens: reasoning } : {}),
            ...(modelId ? { modelId } : {}),
            ...(turnId ? { turnId } : {}),
            ...(messageId ? { messageId } : {}),
            ...(text(payload.finish) ? { finish: payload.finish } : {}),
            ...(payload.compaction === true ? { compaction: true } : {}),
          },
          ...(turnId || messageId
            ? { ids: { ...(turnId ? { turnId } : {}), ...(messageId ? { messageId } : {}) } }
            : {}),
          providerEventId: `oc:part:${partId}`,
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
