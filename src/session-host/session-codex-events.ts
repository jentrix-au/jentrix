/**
 * Codex rollout telemetry and opening-prompt provenance for watch mode.
 * Only the exact rollout supplied by trusted provider context is consumed.
 * Hook lifecycle mapping lives in session-codex-hooks.ts.
 */

import type { SessionEvent } from "./session-events.js";
import { SESSION_EVENT_VERSION } from "./session-events.js";

function make(
  kind: SessionEvent["kind"],
  payload: unknown,
  providerEventId?: string,
): Omit<SessionEvent, "sequence"> {
  return {
    version: SESSION_EVENT_VERSION,
    at: new Date(0).toISOString(), // stamped by the bridge at observation time
    provider: "codex",
    ...(providerEventId ? { providerEventId } : {}),
    kind,
    payload,
  };
}

interface CodexRolloutLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    model?: string;
    turn_id?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
  };
}

const CODEX_INJECTED_USER_CONTEXT = [
  "<recommended_plugins>",
  "# AGENTS.md instructions",
  "<environment_context>",
];

/** Return the first operator prompt, excluding Codex's injected user context. */
export function codexOpeningPromptOf(rollout: string): string | null {
  for (const rawLine of rollout.split("\n")) {
    try {
      const line = JSON.parse(rawLine) as CodexRolloutLine;
      if (
        line.type !== "response_item" ||
        line.payload?.type !== "message" ||
        line.payload.role !== "user"
      ) {
        continue;
      }
      const text = (line.payload.content ?? [])
        .filter((block) => block.type === "input_text")
        .map((block) => block.text?.trim() ?? "")
        .filter(
          (block) =>
            block &&
            !CODEX_INJECTED_USER_CONTEXT.some((prefix) =>
              block.startsWith(prefix),
            ),
        );
      if (text.length > 0) return text.join("\n\n");
    } catch {
      // Rollouts are append-only JSONL; malformed or partial lines are inert.
    }
  }
  return null;
}

export interface MappedCodexRolloutLine {
  event: Omit<SessionEvent, "sequence"> | null;
  modelId: string | null;
  turn: {
    id: string;
    phase: "started" | "completed";
    at: number;
  } | null;
}

function reportedToken(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Map provider-reported rollout telemetry; transcript content is ignored. */
export function mapCodexRolloutLine(rawLine: string): MappedCodexRolloutLine {
  try {
    const line = JSON.parse(rawLine) as CodexRolloutLine;
    const modelId = line.payload?.model?.trim() || null;
    const turnId = line.payload?.turn_id?.trim() || null;
    const at = Date.parse(line.timestamp ?? "");
    if (line.type === "turn_context") {
      return { event: null, modelId, turn: null };
    }
    if (
      line.type === "event_msg" &&
      turnId &&
      Number.isFinite(at) &&
      (line.payload?.type === "task_started" ||
        line.payload?.type === "task_complete")
    ) {
      return {
        event: null,
        modelId: null,
        turn: {
          id: turnId,
          phase: line.payload.type === "task_started" ? "started" : "completed",
          at,
        },
      };
    }
    const usage = line.payload?.info?.last_token_usage;
    const inputTokens = reportedToken(usage?.input_tokens);
    const outputTokens = reportedToken(usage?.output_tokens);
    if (
      line.type !== "event_msg" ||
      line.payload?.type !== "token_count" ||
      inputTokens === null ||
      outputTokens === null
    ) {
      return { event: null, modelId: null, turn: null };
    }
    const cacheReadTokens = reportedToken(usage?.cached_input_tokens);
    const cacheCreationTokens = reportedToken(usage?.cache_write_input_tokens);
    const reasoningOutputTokens = reportedToken(usage?.reasoning_output_tokens);
    return {
      event: {
        ...make(
          "usage",
          {
            kind: "delta",
            inputTokens,
            outputTokens,
            ...(cacheReadTokens !== null ? { cacheReadTokens } : {}),
            ...(cacheCreationTokens !== null ? { cacheCreationTokens } : {}),
            ...(reasoningOutputTokens !== null
              ? { reasoningOutputTokens }
              : {}),
          },
          typeof line.ordinal === "number"
            ? `rollout:${line.ordinal}`
            : line.timestamp,
        ),
        ...(line.timestamp ? { at: line.timestamp } : {}),
      },
      modelId: null,
      turn: null,
    };
  } catch {
    return { event: null, modelId: null, turn: null };
  }
}

/** Last provider-reported model before a watch host starts tailing the file. */
export function lastCodexRolloutModelOf(rollout: string): string | null {
  let modelId: string | null = null;
  for (const rawLine of rollout.split("\n")) {
    modelId = mapCodexRolloutLine(rawLine).modelId ?? modelId;
  }
  return modelId;
}
