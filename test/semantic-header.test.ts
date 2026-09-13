import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSemanticHeader,
  renderSemanticHeader,
  stripSemanticHeader,
  withSemanticHeader,
} from "../src/session-host/semantic-header.js";

// R08 — the versioned semantic header: one source for machine metadata and
// the Markdown a human reads. The pinned corpus below is MIRRORED by the
// server's parser test; a shape that changes here changes there.

export const CORPUS: Array<{ header: Record<string, unknown>; rendered: string }> = [
  {
    header: { kind: "final-output", attemptId: "a1", messageId: "msg_2", state: "provisional", turnClosing: true, sequence: 7 },
    rendered: "```jentrix\nschema: 1\nkind: final-output\nattemptId: a1\nmessageId: msg_2\nstate: provisional\nturnClosing: true\nsequence: 7\n```",
  },
  {
    header: { kind: "verification-receipt", command: "pnpm test:mvp", exitCode: 0, gateFamilies: ["test"], repo: null },
    rendered: "```jentrix\nschema: 1\nkind: verification-receipt\ncommand: pnpm test:mvp\nexitCode: 0\ngateFamilies: [\"test\"]\nrepo: null\n```",
  },
];

test("renders and parses the pinned corpus byte for byte", () => {
  for (const { header, rendered } of CORPUS) {
    assert.equal(renderSemanticHeader(header as never), rendered);
    const parsed = parseSemanticHeader(`${rendered}\n\nbody`);
    assert.deepEqual(parsed, { schema: 1, ...header });
  }
});

test("a string that looks like JSON round-trips as a string", () => {
  const rendered = renderSemanticHeader({ kind: "checkpoint", nextAction: "true", note: " padded " });
  const parsed = parseSemanticHeader(rendered);
  assert.equal(parsed?.nextAction, "true");
  assert.equal(parsed?.note, " padded ");
});

test("no header, an unclosed fence, or a fence without schema/kind parses to null", () => {
  assert.equal(parseSemanticHeader("# Just Markdown\n\ntext"), null);
  assert.equal(parseSemanticHeader("```jentrix\nschema: 1\nkind: x\n"), null);
  assert.equal(parseSemanticHeader("```jentrix\nkind: x\n```"), null);
  assert.equal(parseSemanticHeader(""), null);
});

test("stripSemanticHeader returns the body under the header, and the body untouched without one", () => {
  const body = withSemanticHeader({ kind: "checkpoint", boundary: "handoff" }, "# Title\n\nfirst paragraph");
  assert.equal(stripSemanticHeader(body), "# Title\n\nfirst paragraph");
  assert.equal(stripSemanticHeader("plain"), "plain");
});

test("a receipt keeps its legacy opener first and the header is still found within the first lines", () => {
  const body = `$ pnpm test\nexit code: 0\n\n${renderSemanticHeader({ kind: "verification-receipt", exitCode: 0 })}\n\nok`;
  const parsed = parseSemanticHeader(body);
  assert.equal(parsed?.kind, "verification-receipt");
  assert.equal(stripSemanticHeader(body), "$ pnpm test\nexit code: 0\n\nok");
});
