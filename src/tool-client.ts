/** Structured MCP calls shared by handwritten commands. No command registration. */
import {
  EXIT_CODES,
  envelopeOfResult,
  envelopeToExit,
  firstResultText,
  type McpErrorCode,
  type McpErrorEnvelope,
} from "./errors";
import { withRateLimitRetry } from "./retry";

export interface SessionToolCaller {
  callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * STA-116 — the envelope CODE must survive into the thrown error, or every
 * caller reads RATE_LIMITED/INTERNAL as "does not exist". `code` is null when
 * the failure carried no parseable envelope (non-Jentrix server, protocol
 * text).
 */
export class ToolCallError extends Error {
  constructor(
    message: string,
    readonly code: McpErrorCode | null = null,
    readonly envelope: McpErrorEnvelope | null = null,
  ) {
    super(message);
  }
  get exitCode(): number {
    return this.code
      ? envelopeToExit({ error: { code: this.code, message: this.message } })
          .code
      : EXIT_CODES.INTERNAL;
  }
}

export async function callStructured(
  caller: SessionToolCaller,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Same RATE_LIMITED policy as the generic path (call.ts): a result carrying
  // a usable retryAfterSeconds sleeps and retries instead of surfacing.
  const result = await withRateLimitRetry(
    () => caller.callTool({ name, arguments: args }),
    {
      maxRetries: 2,
      maxWaitSeconds: 60,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    },
  );
  return structuredToolResult(result);
}

/** Parse an already retried MCP result; REST callers retain their own protocol. */
export function structuredToolResult(result: unknown): Record<string, unknown> {
  if (isRecord(result) && result.isError === true) {
    const envelope = envelopeOfResult(result);
    if (envelope) {
      throw new ToolCallError(
        envelope.error.message,
        envelope.error.code,
        envelope,
      );
    }
    const text = firstResultText(result);
    let message = text ?? "tool call failed";
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          isRecord(parsed) &&
          isRecord(parsed.error) &&
          typeof parsed.error.message === "string"
        )
          message = parsed.error.message;
      } catch {
        // Foreign/protocol error text stays available verbatim.
      }
    }
    throw new ToolCallError(message);
  }
  return isRecord(result) && isRecord(result.structuredContent)
    ? (result.structuredContent as Record<string, unknown>)
    : {};
}

export class UsageError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODES.INVALID_INPUT) {
    super(message);
    this.exitCode = exitCode;
  }
}
