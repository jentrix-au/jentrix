/**
 * M20.1 §15.1 — Claude Code capture: a PURE, DETERMINISTIC mapper from the
 * transcript entries the SUPPORTED hook surface names (`transcript_path` is a
 * documented lifecycle-hook payload) onto the v1 SessionEvent envelope.
 *
 * Only OBSERVABLE shapes are mapped — visible user/assistant messages, tool
 * calls/results, and usage receipts. Anything unrecognized maps to null and
 * is counted by the capability snapshot rather than guessed at (§15.3). No
 * semantic classification happens here (frozen decision 19).
 */

import type { TimingLine } from "./session-claude-timing.js";
import type { SessionEvent } from "./session-events.js";
import { SESSION_EVENT_VERSION } from "./session-events.js";

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeTranscriptEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  /** True on subagent (sidechain) entries — not the operator's own turn. */
  isSidechain?: boolean;
  /** True on host-synthesized user entries (command wrappers, caveats). */
  isMeta?: boolean;
  /** True on the post-compaction continuation entry — synthetic, not typed. */
  isCompactSummary?: boolean;
  message?: {
    role?: string;
    /**
     * control-room AC2.1 — the model the provider ACTUALLY ran, as Claude Code
     * stamps it on every assistant entry. Free: the host already tails this
     * file, and nothing else in the record knows which model produced the work.
     */
    model?: string;
    content?: ClaudeContentBlock[] | string;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
      /**
       * Model-catalog PRD D7: the cache-write TTL split, per entry. The two
       * sum to `cache_creation_input_tokens`; the 1-hour tier bills 2× input
       * where the 5-minute tier bills 1.25×, and Claude Code's default is
       * 1-hour. Absent on older transcripts.
       */
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      /** Thinking tokens — a subset of `output_tokens`, when reported. */
      output_tokens_details?: { thinking_tokens?: number };
    };
  };
}

export interface MappedTranscriptLine {
  events: Array<Omit<SessionEvent, "sequence">>;
  /** True when the line held a shape this adapter does not observe. */
  unrecognized: boolean;
  /**
   * The model this line names, when it named one (assistant entries only).
   * Reported, never accumulated — this mapper stays pure and per-line; the
   * bridge decides what "the session's model" is.
   */
  modelId?: string;
  /**
   * control-room AC3.7 — what this line contributes to interval timing.
   * Reported per line for the same reason as `modelId`: pairing is cross-line
   * state, and it lives in ClaudeTimingTracker, not in this mapper.
   */
  timing?: TimingLine;
}

function baseEvent(
  entry: ClaudeTranscriptEntry,
  kind: SessionEvent["kind"],
  payload: unknown,
  idSuffix = "",
): Omit<SessionEvent, "sequence"> {
  return {
    version: SESSION_EVENT_VERSION,
    at: entry.timestamp ?? new Date(0).toISOString(),
    provider: "claude",
    ...(entry.uuid ? { providerEventId: `${entry.uuid}${idSuffix}` } : {}),
    kind,
    payload,
  };
}

function textOf(content: ClaudeContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Map ONE transcript JSONL line. Deterministic; never throws. */
export function mapClaudeTranscriptLine(line: string): MappedTranscriptLine {
  let entry: ClaudeTranscriptEntry;
  try {
    entry = JSON.parse(line) as ClaudeTranscriptEntry;
  } catch {
    return { events: [], unrecognized: true };
  }
  if (entry?.type !== "user" && entry?.type !== "assistant") {
    // summary/meta/system lines are not observable conversation events.
    return { events: [], unrecognized: false };
  }
  const events: Array<Omit<SessionEvent, "sequence">> = [];
  const content = entry.message?.content;

  if (entry.type === "user") {
    const blocks = Array.isArray(content) ? content : [];
    const toolResults = blocks.filter((b) => b.type === "tool_result");
    for (const block of toolResults) {
      events.push(
        baseEvent(
          entry,
          "tool_result",
          {
            toolUseId: block.tool_use_id ?? null,
            isError: Boolean(block.is_error),
            content: block.content ?? null,
          },
          `:result:${block.tool_use_id ?? ""}`,
        ),
      );
    }
    const text = textOf(content);
    if (text) {
      events.push(baseEvent(entry, "user_message", { text }));
    }
    return {
      events,
      unrecognized: false,
      ...timingOf(entry, {
        toolEnds: toolResults
          .map((block) => block.tool_use_id)
          .filter((id): id is string => typeof id === "string"),
      }),
    };
  }

  // assistant
  const modelId =
    typeof entry.message?.model === "string" && entry.message.model.trim()
      ? entry.message.model.trim()
      : undefined;
  const blocks = Array.isArray(content) ? content : [];
  const text = textOf(content);
  if (text) {
    events.push(baseEvent(entry, "assistant_message", { text }));
  }
  for (const block of blocks) {
    if (block.type === "tool_use") {
      events.push(
        baseEvent(
          entry,
          "tool_call",
          {
            toolUseId: block.id ?? null,
            name: block.name ?? null,
            input: block.input ?? null,
          },
          `:tool:${block.id ?? ""}`,
        ),
      );
    }
  }
  const usage = entry.message?.usage;
  if (
    usage &&
    (typeof usage.input_tokens === "number" ||
      typeof usage.cache_creation_input_tokens === "number" ||
      typeof usage.cache_read_input_tokens === "number" ||
      typeof usage.output_tokens === "number")
  ) {
    // Claude reports PER-TURN usage — a delta receipt keyed by the entry uuid.
    // Anthropic's input_tokens EXCLUDES cache tokens (siblings, not a subset —
    // unlike OpenAI's cached_input_tokens), so total input is the three summed.
    // The cache split rides along (AGE-938) — but only when the entry actually
    // carried a cache field, so an old transcript format stays "unreported"
    // rather than claiming a measured zero.
    const hasCacheFields =
      typeof usage.cache_read_input_tokens === "number" ||
      typeof usage.cache_creation_input_tokens === "number";
    events.push(
      baseEvent(
        entry,
        "usage",
        {
          kind: "delta",
          inputTokens:
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens ?? 0,
          ...(hasCacheFields
            ? {
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
              }
            : {}),
          // Model-catalog PRD D7: the 1-hour SUBSET of the cache writes,
          // exactly as the entry states it. Absent → absent (an old transcript
          // stays "unreported"), never a fabricated 0 — the same rule as the
          // cache fields above. A receipt without it prices every write at
          // the 5-minute rate, which PRICING_BASIS discloses.
          ...(typeof usage.cache_creation?.ephemeral_1h_input_tokens === "number"
            ? {
                cacheCreation1hTokens:
                  usage.cache_creation.ephemeral_1h_input_tokens,
              }
            : {}),
          // ...and the thinking tokens the same entry reports, a subset of
          // output. Capture-only: costOf keeps ignoring reasoning (TPM D7).
          ...(typeof usage.output_tokens_details?.thinking_tokens === "number"
            ? {
                reasoningOutputTokens:
                  usage.output_tokens_details.thinking_tokens,
              }
            : {}),
          // TPM Slice 2 (AC2.4): the model that produced THIS receipt — the
          // same entry stamps both, which is what makes per-model grouping a
          // grouped receipt rather than an estimate.
          ...(modelId ? { modelId } : {}),
        },
        ":usage",
      ),
    );
  }
  return {
    events,
    unrecognized: false,
    ...(modelId ? { modelId } : {}),
    ...timingOf(entry, {
      toolStarts: blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => block.id)
        .filter((id): id is string => typeof id === "string"),
    }),
  };
}

/**
 * The timing contribution of one entry, or nothing when the entry carries no
 * parseable timestamp. An unparseable timestamp yields NO interval rather than
 * an epoch-zero one — a fabricated 56-year duration is worse than a named gap.
 */
function timingOf(
  entry: ClaudeTranscriptEntry,
  parts: { toolStarts?: string[]; toolEnds?: string[] },
): { timing: TimingLine } | Record<string, never> {
  const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(at)) return {};
  return {
    timing: {
      at,
      id: entry.uuid ?? String(at),
      role: entry.type === "assistant" ? "assistant" : "user",
      ...(parts.toolStarts?.length ? { toolStarts: parts.toolStarts } : {}),
      ...(parts.toolEnds?.length ? { toolEnds: parts.toolEnds } : {}),
    },
  };
}

/**
 * Taxonomy AC5.1 (D9) — the session's OPENING user prompt: the first
 * HUMAN-AUTHORED user entry with visible text, read from the transcript's own
 * head (the transcript begins at session start even when capture attached
 * later). Host-synthesized user entries are skipped — `isMeta`, the
 * post-compaction continuation (`isCompactSummary`), and slash-command
 * wrappers (`<command-…>` / `<local-command-…>` markup, which sometimes
 * carries no flag) — because a session opened with `/jentrix-align` would
 * otherwise file the align boilerplate as its input and satisfy readiness
 * check 1 with it. Null when no such entry exists yet — the caller retries
 * while the transcript grows and files nothing on a session whose transcript
 * never appears. Pure and deterministic; never throws.
 */
export function openingPromptOf(transcript: string): string | null {
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let entry: ClaudeTranscriptEntry;
    try {
      entry = JSON.parse(line) as ClaudeTranscriptEntry;
    } catch {
      continue;
    }
    if (entry?.type !== "user" || entry.isSidechain) continue;
    if (entry.isMeta || entry.isCompactSummary) continue;
    const text = textOf(entry.message?.content);
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("<command-") ||
      trimmed.startsWith("<local-command-")
    )
      continue;
    return text;
  }
  return null;
}
