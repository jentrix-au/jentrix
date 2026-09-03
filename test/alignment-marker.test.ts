/**
 * mvp-hardening Slice 6 / AC14 — the alignment marker is keyed by PROVIDER
 * session id.
 *
 * Two Claude Code sessions in one checkout used to share a single flat marker:
 * the second `align` overwrote it and both sessions' pushes then resolved to
 * whichever wrote last, filing artifacts under the wrong session. A v1 (flat)
 * file must still READ, and must be migrated in place on the next WRITE —
 * never rewritten on read.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  alignmentMarkerPath,
  clearAlignmentMarker,
  LEGACY_MARKER_KEY,
  parseAlignmentMarkerFile,
  readAlignmentMarker,
  removeAlignmentMarkerEntry,
  resolveAlignmentMarker,
  upsertAlignmentMarker,
  writeAlignmentMarker,
  type AlignmentMarker,
} from "../src/commands/session";

function scratch(): { configPath: string; repoRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "stacks-marker-"));
  return { configPath: join(dir, "config.json"), repoRoot: dir };
}

function marker(overrides: Partial<AlignmentMarker> = {}): AlignmentMarker {
  return {
    sessionId: "ses_1",
    workspaceId: "ws_1",
    projectId: "proj_1",
    taskId: "task_1",
    capture: "off",
    alignedAt: "2026-08-12T10:00:00.000Z",
    ...overrides,
  };
}

describe("alignment marker — pure shape handling", () => {
  it("parses a v1 flat file into a v2 map reachable only through `latest`", () => {
    const file = parseAlignmentMarkerFile(marker());
    assert.equal(file?.version, 2);
    assert.equal(file?.latest, LEGACY_MARKER_KEY);
    assert.equal(file?.sessions[LEGACY_MARKER_KEY]?.sessionId, "ses_1");
    // A v1 entry cannot say whose it is, so a session that CAN name itself
    // never claims it — that is the same inheritance, one entry older.
    assert.equal(resolveAlignmentMarker(file, "prov_a"), null);
    // A legacy entry cannot prove who is asking; unnamed callers fail closed.
    assert.equal(resolveAlignmentMarker(file, null), null);
  });

  it("rejects junk without throwing", () => {
    for (const junk of [null, 42, "nope", {}, { version: 2, sessions: {} }]) {
      assert.equal(parseAlignmentMarkerFile(junk), null);
    }
  });

  it("resolves each provider session's own entry and never a sibling's", () => {
    let file = upsertAlignmentMarker(
      null,
      "prov_a",
      marker({ sessionId: "ses_a" }),
    );
    file = upsertAlignmentMarker(
      file,
      "prov_b",
      marker({ sessionId: "ses_b" }),
    );
    assert.equal(resolveAlignmentMarker(file, "prov_a")?.sessionId, "ses_a");
    assert.equal(resolveAlignmentMarker(file, "prov_b")?.sessionId, "ses_b");
    // A provider session with no entry has NO alignment — inheriting the
    // newest one is what made a checkout behave as if it held exactly one.
    assert.equal(resolveAlignmentMarker(file, "prov_zz"), null);
    // …and an unnamed caller always refuses: one foreign entry caused STA-74.
    assert.equal(resolveAlignmentMarker(file, null), null);
    const alone = upsertAlignmentMarker(
      null,
      "prov_a",
      marker({ sessionId: "ses_a" }),
    );
    assert.equal(resolveAlignmentMarker(alone, null), null);
  });

  it("drops a migrated v1 entry describing the SAME session, keeps a different one", () => {
    const v1 = parseAlignmentMarkerFile(marker({ sessionId: "ses_1" }))!;
    const same = upsertAlignmentMarker(
      v1,
      "prov_a",
      marker({ sessionId: "ses_1" }),
    );
    assert.deepEqual(Object.keys(same.sessions), ["prov_a"]);

    const other = upsertAlignmentMarker(
      v1,
      "prov_a",
      marker({ sessionId: "ses_2" }),
    );
    assert.deepEqual(Object.keys(other.sessions).sort(), [
      LEGACY_MARKER_KEY,
      "prov_a",
    ]);
    assert.equal(other.latest, "prov_a");
  });

  it("removes only the entries pointing at the ended session", () => {
    let file = upsertAlignmentMarker(
      null,
      "prov_a",
      marker({ sessionId: "ses_a" }),
    );
    file = upsertAlignmentMarker(
      file,
      "prov_b",
      marker({ sessionId: "ses_b" }),
    );
    const left = removeAlignmentMarkerEntry(file, "ses_b")!;
    assert.deepEqual(Object.keys(left.sessions), ["prov_a"]);
    assert.equal(left.latest, "prov_a", "latest repoints to what survives");
    assert.equal(removeAlignmentMarkerEntry(left, "ses_a"), null);
  });
});

describe("alignment marker — on disk", () => {
  it("two aligned provider sessions in one checkout keep their own (AC14)", () => {
    const { configPath, repoRoot } = scratch();
    writeAlignmentMarker(
      configPath,
      repoRoot,
      marker({ sessionId: "ses_a", taskId: "task_a" }),
      "prov_a",
    );
    writeAlignmentMarker(
      configPath,
      repoRoot,
      marker({ sessionId: "ses_b", taskId: "task_b" }),
      "prov_b",
    );
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_a")?.taskId,
      "task_a",
      "the second align must not overwrite the first session's alignment",
    );
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_b")?.taskId,
      "task_b",
    );
  });

  it("a v1 file stays unreadable and is migrated in place on the next write (AC14)", () => {
    const { configPath, repoRoot } = scratch();
    const path = alignmentMarkerPath(configPath, repoRoot);
    // The flat shape a shipped 0.4.x CLI left behind, written by hand.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker({ sessionId: "ses_v1" })));

    // Reading does NOT rewrite it. A v1 entry cannot prove who is asking, so
    // both unnamed and named callers fail closed.
    assert.equal(readAlignmentMarker(configPath, repoRoot), null);
    assert.equal(readAlignmentMarker(configPath, repoRoot, "prov_a"), null);
    assert.equal(
      JSON.parse(readFileSync(path, "utf8")).version,
      undefined,
      "a read must never rewrite the file",
    );

    // The next write migrates it.
    writeAlignmentMarker(
      configPath,
      repoRoot,
      marker({ sessionId: "ses_v2" }),
      "prov_a",
    );
    const migrated = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(migrated.version, 2);
    assert.equal(migrated.latest, "prov_a");
    assert.equal(migrated.sessions.prov_a.sessionId, "ses_v2");
  });

  it("clearing one session leaves a concurrent session's alignment intact", () => {
    const { configPath, repoRoot } = scratch();
    writeAlignmentMarker(
      configPath,
      repoRoot,
      marker({ sessionId: "ses_a" }),
      "prov_a",
    );
    writeAlignmentMarker(
      configPath,
      repoRoot,
      marker({ sessionId: "ses_b" }),
      "prov_b",
    );
    clearAlignmentMarker(configPath, repoRoot, "ses_a");
    // The ENDED session's key resolves to nothing — not to whatever its
    // neighbour is aligned to, which would file its late pushes there.
    assert.equal(readAlignmentMarker(configPath, repoRoot, "prov_a"), null);
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_b")?.sessionId,
      "ses_b",
    );
    // The last one out removes the file.
    clearAlignmentMarker(configPath, repoRoot, "ses_b");
    assert.equal(existsSync(alignmentMarkerPath(configPath, repoRoot)), false);
  });

  it("clearing an unrelated session is a no-op", () => {
    const { configPath, repoRoot } = scratch();
    writeAlignmentMarker(
      configPath,
      repoRoot,
      marker({ sessionId: "ses_a" }),
      "prov_a",
    );
    clearAlignmentMarker(configPath, repoRoot, "ses_zzz");
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_a")?.sessionId,
      "ses_a",
    );
  });
});
