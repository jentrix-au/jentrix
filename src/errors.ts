/**
 * MCP error envelope → process exit code + stderr/stdout text.
 *
 * PURE — no process, no I/O. This module is inside the dependency firewall:
 * it may import only `@modelcontextprotocol/sdk`, `node:` builtins, and its
 * sibling core modules (see test/firewall.test.ts). It currently needs none.
 */

/** Error codes emitted by the server's `safe()` wrapper (src/lib/mcp/errors.ts). */
export type McpErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "INTERNAL";

/** The JSON payload carried by every `isError: true` tool result. */
export interface McpErrorEnvelope {
  error: {
    code: McpErrorCode;
    message: string;
    hint?: string;
    retryAfterSeconds?: number;
    /** CONFLICT from a stale write: the entity's CURRENT state, for merging. */
    current?: unknown;
  };
}

/**
 * FROZEN exit-code table (plan README §4.4). Never renumber — agents script
 * against these. `OK` and `TRANSPORT` are not envelope codes: transport/auth
 * failures (HTTP 401 = dead token, connection refused, …) never produce an
 * envelope, they throw before one exists.
 */
export const EXIT_CODES = {
  OK: 0,
  INTERNAL: 1,
  INVALID_INPUT: 2,
  FORBIDDEN: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  RATE_LIMITED: 6,
  TRANSPORT: 7,
  /**
   * AGE-965: the operation SUCCEEDED but left recorded capture debt —
   * `jentrix session end` closed the session with `captureComplete: false`.
   * Its own code because 1 (a real failure) made "closed with a gap" and
   * "the close failed" indistinguishable to a script. Not an envelope code:
   * no server error occurred.
   */
  CAPTURE_INCOMPLETE: 8,
} as const;

const ENVELOPE_EXIT: Record<McpErrorCode, number> = {
  INTERNAL: EXIT_CODES.INTERNAL,
  INVALID_INPUT: EXIT_CODES.INVALID_INPUT,
  FORBIDDEN: EXIT_CODES.FORBIDDEN,
  NOT_FOUND: EXIT_CODES.NOT_FOUND,
  CONFLICT: EXIT_CODES.CONFLICT,
  RATE_LIMITED: EXIT_CODES.RATE_LIMITED,
};

export interface ExitDecision {
  code: number;
  stderr: string;
  /** CONFLICT only: `error.current` as JSON so a piped agent can merge+retry. */
  stdout?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse an unknown value as an MCP error envelope. Returns null when the
 * value is not envelope-shaped (unknown codes are preserved by
 * `envelopeToExit`'s fallback instead).
 */
export function parseErrorEnvelope(value: unknown): McpErrorEnvelope | null {
  if (!isRecord(value)) return null;
  const error = value.error;
  if (!isRecord(error)) return null;
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    return null;
  }
  if (!(error.code in ENVELOPE_EXIT)) return null;
  return value as unknown as McpErrorEnvelope;
}

/**
 * Extract the error envelope from a tool-call result (the SDK's
 * `CallToolResult` shape): `isError: true` with the envelope JSON in the
 * first text content block. Returns null for success results and for error
 * results that don't carry a parseable envelope.
 */
export function envelopeOfResult(result: unknown): McpErrorEnvelope | null {
  if (!isRecord(result) || result.isError !== true) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue;
    if (typeof block.text !== "string") continue;
    try {
      return parseErrorEnvelope(JSON.parse(block.text));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Map an error payload (an envelope, or anything else that came back from a
 * failed call) to the frozen exit code plus the exact stderr/stdout text.
 *
 * - stderr: `CODE: message` + ` (hint)` when the envelope carries one.
 * - CONFLICT: `error.current` (when present) is emitted as JSON on stdout so
 *   `stacks … || merge-and-retry` pipelines get the current state in one step.
 * - Non-envelope payloads exit 1 (INTERNAL/unknown).
 */
export function envelopeToExit(payload: unknown): ExitDecision {
  const envelope = parseErrorEnvelope(payload);
  if (!envelope) {
    return {
      code: EXIT_CODES.INTERNAL,
      stderr: `INTERNAL: unrecognized error payload: ${safeStringify(payload)}`,
    };
  }
  const { code, message, hint, current } = envelope.error;
  const decision: ExitDecision = {
    code: ENVELOPE_EXIT[code],
    stderr: hint ? `${code}: ${message} (${hint})` : `${code}: ${message}`,
  };
  if (code === "CONFLICT" && current !== undefined) {
    decision.stdout = JSON.stringify(current);
  }
  return decision;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** HTTP auth failures shared by CLI and host; MCP FORBIDDEN is separate. */
export function isUnauthorizedError(error: unknown): boolean {
  if (isRecord(error) && (error.code === 401 || error.status === 401))
    return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized|invalid_token|no authorization/i.test(message);
}

/** First text block, shared by MCP renderers and structured callers. */
export function firstResultText(result: unknown): string | null {
  if (!isRecord(result) || !Array.isArray(result.content)) return null;
  for (const block of result.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    )
      return block.text;
  }
  return null;
}
