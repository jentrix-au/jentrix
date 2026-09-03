/**
 * TPM Slice 2 (task-performance-monitoring PRD §6, AC2.5) — flush-before-
 * align: `jentrix align --task <other>` asks the live host (via the
 * end-request.json idiom) to post a usage receipt on the OLD alignment
 * before the server closes its interval. The marker survives until the host
 * has a server-ACKNOWLEDGED beat, so a surviving marker honestly means "not
 * flushed" and the CLI's disclosure names the one-beat-window bound.
 *
 * The frozen alignment question set (cli/test/align-questions.test.ts) is
 * untouched — the flush is command ORDERING, not a question.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { requestUsageFlush } from "../src/commands/session";

test("writes flush-request.json and reports true once the host deletes it (acked beat)", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-align-flush-"));
  mkdirSync(join(spoolRoot, "ses_1")); // the live host owns this dir
  const path = join(spoolRoot, "ses_1", "flush-request.json");
  let polls = 0;
  const acked = await requestUsageFlush(
    {
      spoolRoot,
      sleep: async () => {
        polls += 1;
        // The marker must already exist BEFORE the first wait — the flush
        // request precedes the align submit, which is the whole ordering.
        assert.ok(existsSync(path) || polls > 2);
        if (polls === 2) unlinkSync(path); // the host acks by deleting
      },
    },
    "ses_1",
  );
  assert.equal(acked, true);
  assert.equal(polls, 2);
});

test("the marker carries a timestamp, not instructions", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-align-flush-"));
  mkdirSync(join(spoolRoot, "ses_1")); // the live host owns this dir
  const path = join(spoolRoot, "ses_1", "flush-request.json");
  await requestUsageFlush(
    { spoolRoot, sleep: async () => unlinkSync(path) },
    "ses_1",
  );
  // Re-request to inspect the body before deletion.
  let body: Record<string, unknown> | null = null;
  await requestUsageFlush(
    {
      spoolRoot,
      sleep: async () => {
        body = JSON.parse(readFileSync(path, "utf8")) as Record<
          string,
          unknown
        >;
        unlinkSync(path);
      },
    },
    "ses_1",
  );
  assert.ok(body !== null);
  assert.match(String((body as Record<string, unknown>).requestedAt), /T/);
});

test("a host that never acks times out to false — the disclosure's honest arm", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-align-flush-"));
  mkdirSync(join(spoolRoot, "ses_1")); // the live host owns this dir
  const acked = await requestUsageFlush(
    { spoolRoot, sleep: async () => undefined },
    "ses_1",
    600, // bounded wait shrunk for the test; the real default is 6 s
  );
  assert.equal(acked, false);
  // The unacked marker SURVIVES — a later host beat may still honor it.
  assert.ok(existsSync(join(spoolRoot, "ses_1", "flush-request.json")));
});

test("an unwritable spool dir reports false instead of throwing", async () => {
  const acked = await requestUsageFlush(
    { spoolRoot: "/dev/null/nope", sleep: async () => undefined },
    "ses_1",
    100,
  );
  assert.equal(acked, false);
});

// ---------------------------------------------------------------------------
// Client-runtime v2 D6 (§12.5) — the WIDENED trigger. The wizard flushed only
// when a task was ALREADY aligned (`session.taskId && session.taskId !==
// next`), so the unaligned→first-task boundary never flushed and pre-align
// spend was silently charged to the first task. The rule is any BUCKET
// change: null↔task and task↔task flush; a same-task settings update never
// does.
// ---------------------------------------------------------------------------

import { alignChangesBucket } from "../src/commands/session";

test("D6: every bucket change flushes — including unaligned→first-task — and same-task never does", () => {
  // The defect boundary: first alignment of a fresh session.
  assert.equal(alignChangesBucket(null, "task_1"), true);
  // Task switch.
  assert.equal(alignChangesBucket("task_1", "task_2"), true);
  // Back to session-level.
  assert.equal(alignChangesBucket("task_1", null), true);
  // Same-task settings update: owner/budget/label changes must NOT fragment
  // attribution with a flush cycle.
  assert.equal(alignChangesBucket("task_1", "task_1"), false);
  // Unaligned → unaligned (pure settings on a session-level session).
  assert.equal(alignChangesBucket(null, null), false);
});
