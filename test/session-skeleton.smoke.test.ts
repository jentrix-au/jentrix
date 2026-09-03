/**
 * Session evidence floor (PRD §4/D2) — the v1 activity skeleton accumulator:
 * counts by kind and tool name, files-touched with exact totals under a capped
 * list, hourly buckets, and the declared 32 KB coalescing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_SKELETON_BYTES, SessionSkeleton } from "../src/session-host/session-skeleton.js";
import type { SessionEvent } from "../src/session-host/session-events.js";

function event(
  kind: SessionEvent["kind"],
  payload: unknown,
  at = "2026-08-26T10:00:00.000Z",
): SessionEvent {
  return { version: 1, sequence: 0, at, provider: "claude", kind, payload };
}

test("accumulates counts, tools, files, turns, and hourly buckets", () => {
  const skeleton = new SessionSkeleton("claude");
  assert.equal(skeleton.observedAnything, false);
  skeleton.observe(event("user_message", { text: "hi" }));
  skeleton.observe(
    event(
      "tool_call",
      { name: "Edit", input: { file_path: "~/repo/a.ts" } },
      "2026-08-26T11:05:00.000Z",
    ),
  );
  skeleton.observe(
    event("tool_call", { name: "Edit", input: { file_path: "~/repo/b.ts" } }),
  );
  skeleton.observe(
    event("file_change", { changes: [{ path: "~/repo/a.ts", kind: "edit" }] }),
  );
  skeleton.observe(event("usage", { kind: "delta", inputTokens: 1 }));
  const snap = skeleton.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.turns, 1);
  assert.equal(snap.eventCounts.tool_call, 2);
  assert.equal(snap.toolCounts.Edit, 2);
  // a.ts touched twice (tool_call + file_change) stays ONE distinct path.
  assert.equal(snap.filesTouched.total, 2);
  assert.deepEqual([...snap.filesTouched.paths].sort(), [
    "~/repo/a.ts",
    "~/repo/b.ts",
  ]);
  assert.equal(snap.firstEventAt, "2026-08-26T10:00:00.000Z");
  assert.equal(snap.hourlyBuckets["2026-08-26T10"], 4);
  assert.equal(snap.hourlyBuckets["2026-08-26T11"], 1);
  assert.equal(snap.truncated, undefined);
});

test("never records bodies, argv, or URLs", () => {
  const skeleton = new SessionSkeleton("claude");
  skeleton.observe(
    event("tool_call", {
      name: "WebFetch",
      input: { url: "https://example.com/secret", file_path: "https://x.y/z" },
    }),
  );
  skeleton.observe(event("assistant_message", { text: "the whole answer" }));
  const json = JSON.stringify(skeleton.snapshot());
  assert.ok(!json.includes("example.com"));
  assert.ok(!json.includes("the whole answer"));
  assert.equal(skeleton.snapshot().filesTouched.total, 0);
});

test("stays under 32 KB and DECLARES coalescing (file-list tail drops first)", () => {
  const skeleton = new SessionSkeleton("codex");
  for (let i = 0; i < 5000; i++) {
    skeleton.observe(
      event("tool_call", {
        name: `tool-${i % 150}`,
        input: {
          file_path: `~/repo/${"very-long-directory-name/".repeat(8)}segment-${i}/file-${i}.generated.ts`,
        },
      }),
    );
  }
  const snap = skeleton.snapshot();
  const bytes = Buffer.byteLength(JSON.stringify(snap), "utf8");
  assert.ok(bytes <= MAX_SKELETON_BYTES, `serialized ${bytes} bytes`);
  assert.equal(snap.truncated, true);
  // Counts stay exact even though the path list was cut.
  assert.equal(snap.eventCounts.tool_call, 5000);
  assert.equal(snap.filesTouched.total, 5000); // 300 tracked + 4700 overflow, exact
  assert.ok(snap.filesTouched.paths.length < 300);
  // Tool names beyond the distinct cap coalesce into "(other)".
  assert.ok((snap.toolCounts["(other)"] ?? 0) > 0);
});
