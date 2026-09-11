import assert from "node:assert/strict";
import { test } from "node:test";

import {
  relatedArtifactsOf,
  relatedNoticeOf,
  renderRelatedEvidence,
} from "../src/session/related-evidence";

// Semantic recall (cli 0.10.0, PRD D13 / AC5.2 / AC5.3): one renderer for the
// align disclosure and `task context`.

const HIT = {
  id: "art_7",
  title: "Learning: the reaper releases the lease before the retry",
  type: "LEARNING",
  createdAt: "2026-09-10T10:00:00.000Z",
  taskId: "task_3",
  taskKey: "ACM-11",
  sessionId: "ses_0",
  similarity: 0.8412,
  snippet:
    "The reaper released the lease before the retry,\n  so the second attempt claimed a stage that was already committed.",
  truncated: false,
};

test("an absent field (older server) renders NOTHING; an empty one renders 'none' with the reason", () => {
  assert.equal(relatedArtifactsOf({ alignment: {} }), null);
  assert.deepEqual(renderRelatedEvidence(null), []);
  assert.deepEqual(renderRelatedEvidence([]), ["Related evidence: none"]);
  assert.deepEqual(
    renderRelatedEvidence(
      relatedArtifactsOf({ relatedArtifacts: [] }),
      relatedNoticeOf({
        relatedArtifactsNotice:
          "This task has no embedding yet — embeddings are generated every ~5 minutes. Retry shortly.",
      }),
    ),
    [
      "Related evidence: none — This task has no embedding yet — embeddings are generated every ~5 minutes. Retry shortly.",
    ],
  );
  assert.equal(relatedNoticeOf({ relatedArtifactsNotice: "  " }), undefined);
});

test("hits render as kind · id · title · similarity · card, snippet folded beneath", () => {
  const hits = relatedArtifactsOf({ relatedArtifacts: [HIT] });
  assert.equal(hits?.length, 1);
  assert.deepEqual(renderRelatedEvidence(hits), [
    "Related evidence (1):",
    "  LEARNING       art_7  Learning: the reaper releases the lease before the retry  ·  84%  ·  on ACM-11",
    "    The reaper released the lease before the retry, so the second attempt claimed a stage that was already committed.",
  ]);
});

test("a truncated artifact says so, a session-level artifact has no card, a long snippet is bounded", () => {
  const lines = renderRelatedEvidence([
    {
      ...HIT,
      id: "art_8",
      taskKey: null,
      taskId: null,
      truncated: true,
      snippet: "word ".repeat(80),
    },
  ]);
  assert.match(lines[1]!, /art_8 .*·  84%  ·  \(tail not embedded\)$/);
  assert.doesNotMatch(lines[1]!, /on /);
  assert.ok(lines[2]!.length <= 4 + 160);
  assert.ok(lines[2]!.endsWith("…"));
});

test("malformed rows are tolerated field by field, never thrown on", () => {
  const hits = relatedArtifactsOf({
    relatedArtifacts: [{ id: "x", similarity: "high" }, "junk", null],
  });
  assert.deepEqual(hits, [
    {
      id: "x",
      title: "",
      type: "",
      createdAt: "",
      taskId: null,
      taskKey: null,
      sessionId: null,
      similarity: 0,
      snippet: null,
      truncated: false,
    },
  ]);
});
