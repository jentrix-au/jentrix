import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXIT_CODES,
  envelopeOfResult,
  envelopeToExit,
  parseErrorEnvelope,
  type McpErrorCode,
} from "../src/errors";

describe("EXIT_CODES (frozen table — README §4.4, never renumber)", () => {
  it("matches the frozen exit-code table exactly", () => {
    // Frozen = never RENUMBERED. The table is append-only: 8 joined in 0.4.18
    // (AGE-965) for a successful `session end` carrying recorded capture debt,
    // which used to be indistinguishable from a failed close on 1.
    assert.deepEqual(EXIT_CODES, {
      OK: 0,
      INTERNAL: 1,
      INVALID_INPUT: 2,
      FORBIDDEN: 3,
      NOT_FOUND: 4,
      CONFLICT: 5,
      RATE_LIMITED: 6,
      TRANSPORT: 7,
      CAPTURE_INCOMPLETE: 8,
    });
  });
});

function envelope(
  code: McpErrorCode,
  extra: Record<string, unknown> = {},
): { error: Record<string, unknown> } {
  return {
    error: { code, message: `${code.toLowerCase()} happened`, ...extra },
  };
}

describe("envelopeToExit", () => {
  // Table-driven: every envelope code → its frozen exit code.
  const table: [McpErrorCode, number][] = [
    ["INTERNAL", 1],
    ["INVALID_INPUT", 2],
    ["FORBIDDEN", 3],
    ["NOT_FOUND", 4],
    ["CONFLICT", 5],
    ["RATE_LIMITED", 6],
  ];
  for (const [code, exitCode] of table) {
    it(`${code} → exit ${exitCode}`, () => {
      const decision = envelopeToExit(envelope(code));
      assert.equal(decision.code, exitCode);
      assert.ok(decision.stderr.startsWith(`${code}: `));
    });
  }

  it("includes the hint on stderr when present", () => {
    const decision = envelopeToExit(
      envelope("NOT_FOUND", { hint: "Call list_workspaces first." }),
    );
    assert.equal(
      decision.stderr,
      "NOT_FOUND: not_found happened (Call list_workspaces first.)",
    );
  });

  it("omits the hint parenthetical when absent", () => {
    const decision = envelopeToExit(envelope("FORBIDDEN"));
    assert.equal(decision.stderr, "FORBIDDEN: forbidden happened");
    assert.equal(decision.stdout, undefined);
  });

  it("CONFLICT emits error.current as JSON on stdout", () => {
    const current = { id: "task_1", updatedAt: "2026-06-21T00:00:00.000Z" };
    const decision = envelopeToExit(envelope("CONFLICT", { current }));
    assert.equal(decision.code, 5);
    assert.equal(decision.stdout, JSON.stringify(current));
  });

  it("CONFLICT without current has no stdout", () => {
    const decision = envelopeToExit(envelope("CONFLICT"));
    assert.equal(decision.code, 5);
    assert.equal(decision.stdout, undefined);
  });

  it("non-envelope payload → exit 1 (INTERNAL/unknown)", () => {
    for (const payload of [null, 42, "boom", {}, { error: "nope" }, []]) {
      const decision = envelopeToExit(payload);
      assert.equal(decision.code, 1);
      assert.match(decision.stderr, /^INTERNAL: unrecognized error payload/);
    }
  });

  it("unknown error code → exit 1", () => {
    const decision = envelopeToExit({
      error: { code: "TEAPOT", message: "short and stout" },
    });
    assert.equal(decision.code, 1);
  });
});

describe("parseErrorEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = parseErrorEnvelope(
      envelope("RATE_LIMITED", { retryAfterSeconds: 30 }),
    );
    assert.equal(parsed?.error.code, "RATE_LIMITED");
    assert.equal(parsed?.error.retryAfterSeconds, 30);
  });

  it("rejects unknown codes and malformed shapes", () => {
    assert.equal(
      parseErrorEnvelope({ error: { code: "NOPE", message: "x" } }),
      null,
    );
    assert.equal(parseErrorEnvelope({ error: { code: "CONFLICT" } }), null);
    assert.equal(parseErrorEnvelope("CONFLICT"), null);
  });
});

describe("envelopeOfResult", () => {
  it("extracts the envelope from an isError tool result", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(envelope("FORBIDDEN")) }],
    };
    assert.equal(envelopeOfResult(result)?.error.code, "FORBIDDEN");
  });

  it("returns null for success results", () => {
    const result = {
      content: [{ type: "text", text: '{"id":"task_9"}' }],
      structuredContent: { id: "task_9" },
    };
    assert.equal(envelopeOfResult(result), null);
  });

  it("returns null for isError results without a parseable envelope", () => {
    assert.equal(
      envelopeOfResult({
        isError: true,
        content: [{ type: "text", text: "not json" }],
      }),
      null,
    );
    assert.equal(envelopeOfResult({ isError: true, content: [] }), null);
  });
});
