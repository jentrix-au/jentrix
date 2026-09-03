/**
 * M20.1 §15.2 — Codex capture: a PURE, DETERMINISTIC mapper from the
 * SUPPORTED SDK/app-server thread event stream (the same `runStreamed` events
 * the runner's provider adapter consumes) onto the v1 SessionEvent envelope.
 * Watch mode also maps token receipts from the rollout path supplied by the
 * provider's trusted lifecycle hook. Only observable shapes are mapped;
 * unrecognized events surface through the capability snapshot, never through
 * guessing (§15.3).
 */

import type { SessionEvent } from "./session-events.js";
import { SESSION_EVENT_VERSION } from "./session-events.js";

interface CodexThreadEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    changes?: unknown;
    name?: string;
    arguments?: unknown;
    result?: unknown;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    /** TPM Slice 2 (AC2.7): subset of output_tokens, when reported. */
    reasoning_output_tokens?: number;
  };
  /** TPM Slice 2 (AC2.4): app-server turn context — names the model PER TURN. */
  model?: string;
  turn_context?: { model?: string };
  error?: { message?: string };
}

export interface MappedCodexEvent {
  event: Omit<SessionEvent, "sequence"> | null;
  /** The provider thread id when this event carries it (thread.started). */
  threadId?: string;
  /**
   * TPM Slice 2 (AC2.4): the model this event names, when it names one (a
   * turn_context event). Reported, never accumulated — the host decides what
   * "the current model" is, exactly like the Claude mapper's per-line report.
   */
  modelId?: string;
  unrecognized: boolean;
}

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

/** Map one Codex thread event. Deterministic; never throws. */
export function mapCodexThreadEvent(raw: unknown): MappedCodexEvent {
  const event = (raw ?? {}) as CodexThreadEvent;
  switch (event.type) {
    case "thread.started":
      return {
        event: make("session", { threadId: event.thread_id ?? null }),
        ...(event.thread_id ? { threadId: event.thread_id } : {}),
        unrecognized: false,
      };
    case "turn.started":
      return { event: null, unrecognized: false };
    case "turn_context": {
      // TPM Slice 2 (AC2.4): the model can change mid-session and this event
      // is where the runtime says so. Observable-shape mapping only — when
      // the SDK stream never emits it, nothing here fires and Codex receipts
      // stay in the null-model bucket, disclosed rather than guessed.
      const model = (event.turn_context?.model ?? event.model)?.trim();
      return {
        event: null,
        ...(model ? { modelId: model } : {}),
        unrecognized: false,
      };
    }
    case "turn.completed":
      // OpenAI's input_tokens INCLUDES cached (cached_input_tokens is a
      // subset → cacheReadTokens). Codex has no cache-creation concept, so
      // that field is never emitted here (unreported, not zero) — AGE-938.
      return {
        event: event.usage
          ? make("usage", {
              kind: "delta",
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
              ...(typeof event.usage.cached_input_tokens === "number"
                ? { cacheReadTokens: event.usage.cached_input_tokens }
                : {}),
              // TPM Slice 2 (AC2.7): mapped only when present — never 0.
              ...(typeof event.usage.reasoning_output_tokens === "number"
                ? {
                    reasoningOutputTokens: event.usage.reasoning_output_tokens,
                  }
                : {}),
            })
          : null,
        unrecognized: false,
      };
    case "turn.failed":
      return {
        event: make("error", {
          message: event.error?.message ?? "turn failed",
        }),
        unrecognized: false,
      };
    case "item.completed": {
      const item = event.item ?? {};
      const id = item.id;
      switch (item.type) {
        case "agent_message":
          return {
            event: make("assistant_message", { text: item.text ?? "" }, id),
            unrecognized: false,
          };
        case "command_execution":
          return {
            event: make(
              "command",
              {
                command: item.command ?? null,
                exitCode: item.exit_code ?? null,
                output: item.aggregated_output ?? null,
              },
              id,
            ),
            unrecognized: false,
          };
        case "file_change":
          return {
            event: make("file_change", { changes: item.changes ?? null }, id),
            unrecognized: false,
          };
        case "mcp_tool_call":
          return {
            event: make(
              "tool_call",
              {
                name: item.name ?? null,
                input: item.arguments ?? null,
                status: item.status ?? null,
              },
              id,
            ),
            unrecognized: false,
          };
        case "reasoning":
          // Hidden reasoning is deliberately NOT captured (PRD §5 non-goal).
          return { event: null, unrecognized: false };
        default:
          return { event: null, unrecognized: true };
      }
    }
    default:
      return { event: null, unrecognized: true };
  }
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
