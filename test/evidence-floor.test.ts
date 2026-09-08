/**
 * Session evidence floor (session-evidence PRD §5, D4) — the CLI-attested
 * bodies: the `session end` delivery patch (stat-first truncation, dirty-tree
 * note) and the `push log --from-cmd` capture (command + exit code opener,
 * tail-biased truncation).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAttestedDiffBody,
  MAX_ATTESTED_DIFF_BYTES,
} from "../src/session/end";
import {
  fromCmdLogBody,
  MAX_FROM_CMD_OUTPUT_BYTES,
} from "../src/commands/push";
import type { GitRunner } from "../src/repo";

function gitStub(
  answers: Record<string, { code: number; stdout: string }>,
): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    return answers[key] ?? { code: 1, stdout: "" };
  };
}

test("buildAttestedDiffBody: full patch under the cap, commit count in the header", async () => {
  const git = gitStub({
    "rev-list --count aaa..bbb": { code: 0, stdout: "2\n" },
    "log --patch --stat aaa..bbb": {
      code: 0,
      stdout: "commit bbb\n--- a/x.ts\n+++ b/x.ts\n+added\n",
    },
  });
  const built = await buildAttestedDiffBody(git, "/repo", "aaa", "bbb", false);
  assert.ok(built);
  assert.equal(built.commitCount, 2);
  assert.match(built.body, /Range: aaa\.\.bbb · 2 commit\(s\)/);
  assert.match(built.body, /\+added/);
  assert.ok(!built.body.includes("Uncommitted delta"));
});

test("buildAttestedDiffBody: over-cap patch truncates STAT-FIRST and declares it", async () => {
  const git = gitStub({
    "rev-list --count aaa..bbb": { code: 0, stdout: "3\n" },
    "log --patch --stat aaa..bbb": {
      code: 0,
      stdout: "x".repeat(MAX_ATTESTED_DIFF_BYTES + 1),
    },
    "log --stat aaa..bbb": {
      code: 0,
      stdout: "commit bbb\n x.ts | 4000 +++\n",
    },
  });
  const built = await buildAttestedDiffBody(git, "/repo", "aaa", "bbb", false);
  assert.ok(built);
  assert.match(built.body, /truncated stat-first/);
  assert.match(built.body, /x\.ts \| 4000/);
  assert.ok(Buffer.byteLength(built.body, "utf8") <= MAX_ATTESTED_DIFF_BYTES);
});

test("JEN-171: the dirty stat is RETURNED, never embedded in the attested body", async () => {
  const git = gitStub({
    "rev-list --count aaa..bbb": { code: 0, stdout: "1\n" },
    "log --patch --stat aaa..bbb": { code: 0, stdout: "commit bbb\n" },
    "diff --stat HEAD": { code: 0, stdout: " y.ts | 2 +-\n" },
  });
  const built = await buildAttestedDiffBody(git, "/repo", "aaa", "bbb", true);
  assert.ok(built);
  assert.equal(built.uncommitted, "y.ts | 2 +-");
  assert.ok(!built.body.includes("Uncommitted delta"));
  assert.ok(!built.body.includes("y.ts"));
});

test("JEN-171: the body is a pure function of the RANGE — tree churn cannot change it", async () => {
  // The exact shape of the bug: a refused `session end`, then the tree moves
  // while the operator complies, then the retry regenerates the body. Two
  // different dirty trees, one range → identical bytes, so the server's
  // content dedupe lands ONE attested DIFF instead of two.
  const range = {
    "rev-list --count aaa..bbb": { code: 0, stdout: "1\n" },
    "log --patch --stat aaa..bbb": { code: 0, stdout: "commit bbb\n+one\n" },
  };
  const first = await buildAttestedDiffBody(
    gitStub({
      ...range,
      "diff --stat HEAD": { code: 0, stdout: " y.ts | 2 +-\n" },
    }),
    "/repo",
    "aaa",
    "bbb",
    true,
  );
  const retry = await buildAttestedDiffBody(
    gitStub({
      ...range,
      "diff --stat HEAD": {
        code: 0,
        stdout: " y.ts | 2 +-\n z.ts | 9 +++++++++\n",
      },
    }),
    "/repo",
    "aaa",
    "bbb",
    true,
  );
  assert.ok(first && retry);
  assert.equal(first.body, retry.body);
  // …and the fact itself is not lost — each call still reports its own tree.
  assert.notEqual(first.uncommitted, retry.uncommitted);
});

test("JEN-171: a clean tree reports no uncommitted delta", async () => {
  const git = gitStub({
    "rev-list --count aaa..bbb": { code: 0, stdout: "1\n" },
    "log --patch --stat aaa..bbb": { code: 0, stdout: "commit bbb\n" },
  });
  const built = await buildAttestedDiffBody(git, "/repo", "aaa", "bbb", false);
  assert.ok(built);
  assert.equal(built.uncommitted, null);
});

test("buildAttestedDiffBody: an empty range (rebase/reset) is null — nothing to attest", async () => {
  const git = gitStub({
    "rev-list --count aaa..bbb": { code: 0, stdout: "0\n" },
  });
  assert.equal(
    await buildAttestedDiffBody(git, "/repo", "aaa", "bbb", false),
    null,
  );
});

test("fromCmdLogBody opens with the command and exit code", () => {
  const body = fromCmdLogBody("pnpm test", 0, "all green\n");
  assert.ok(body.startsWith("$ pnpm test\nexit code: 0\n\n"));
  assert.match(body, /all green/);
});

test("fromCmdLogBody keeps the TAIL and declares the head cut", () => {
  const output = `${"early\n".repeat(20_000)}THE VERDICT LINE\n`;
  const body = fromCmdLogBody("pnpm test", 1, output);
  assert.match(body, /exit code: 1/);
  assert.match(
    body,
    /\[head truncated: output exceeded 64 KB — tail retained\]/,
  );
  assert.match(body, /THE VERDICT LINE/);
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_FROM_CMD_OUTPUT_BYTES + 256);
});
