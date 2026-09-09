/**
 * Execute one tool call given an MCP `Client`: call → RATE_LIMITED retry →
 * envelope detection → render / exit decision.
 *
 * Transport-agnostic by construction: this module NEVER constructs a client
 * or transport — production hands it a Streamable-HTTP client (C1.2), tests
 * hand it a stub or an `InMemoryTransport` client (C3.1), and nothing here
 * can tell the difference. Inside the dependency firewall: only
 * `@modelcontextprotocol/sdk` + sibling core modules.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  EXIT_CODES,
  envelopeOfResult,
  envelopeToExit,
  isUnauthorizedError,
  firstResultText,
} from "./errors";
import { renderResult } from "./render";
import { withRateLimitRetry, type RetryOptions } from "./retry";

/** The one capability this module needs from the SDK client. */
export type ToolCaller = Pick<Client, "callTool">;

export interface CallOptions {
  /** `--json`: stable JSON on stdout instead of the human renderer. */
  json: boolean;
  retry: RetryOptions;
}

/** What the process edge (main.ts, C1.2) does with a finished call. */
export interface CallOutcome {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export async function callTool(
  client: ToolCaller,
  name: string,
  args: Record<string, unknown>,
  options: CallOptions,
): Promise<CallOutcome> {
  let result: unknown;
  try {
    result = await withRateLimitRetry(
      () => client.callTool({ name, arguments: args }),
      options.retry,
    );
  } catch (e) {
    return transportOutcome(e);
  }

  const envelope = envelopeOfResult(result);
  if (envelope) {
    const decision = envelopeToExit(envelope);
    return {
      exitCode: decision.code,
      stderr: decision.stderr,
      ...(decision.stdout !== undefined ? { stdout: decision.stdout } : {}),
    };
  }
  if (isRecord(result) && result.isError === true) {
    // isError without a parseable envelope (non-Jentrix server, protocol-level
    // failure text): unknown error → exit 1 with whatever text we have.
    return {
      exitCode: EXIT_CODES.INTERNAL,
      stderr: `INTERNAL: tool call failed: ${firstResultText(result) ?? "no error detail"}`,
    };
  }

  return {
    exitCode: EXIT_CODES.OK,
    stdout: renderSuccess(result, options, name),
  };
}

function renderSuccess(
  result: unknown,
  options: CallOptions,
  tool: string,
): string {
  if (isRecord(result) && result.structuredContent !== undefined) {
    return renderResult(result.structuredContent, {
      json: options.json,
      tool,
    });
  }
  // No structuredContent (foreign server / non-P2.2 tool): pass the text
  // content through untouched rather than inventing structure.
  return firstResultText(result) ?? "";
}

function transportOutcome(e: unknown): CallOutcome {
  const message = e instanceof Error ? e.message : String(e);
  const unauthorized = isUnauthorizedError(e);
  const hint = unauthorized
    ? " — token rejected (HTTP 401): the token is invalid, expired, or revoked; set a valid STACKS_TOKEN"
    : "";
  return {
    exitCode: EXIT_CODES.TRANSPORT,
    stderr: `TRANSPORT: ${message}${hint}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
