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
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

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
} from "../src/session/state";

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

// ---------------------------------------------------------------------------
// JEN-457 follow-up (GAP cmtp8sc5c002204l7gw4ow7ho) — the map is read, upserted
// and rewritten. Unlocked and non-atomic, that loses an entry when two sessions
// of one operator align at once (the documented use), and a reader mid-write
// parses a torn file as "never aligned". Both mutations now run under one lock
// and land by tmp+rename.
// ---------------------------------------------------------------------------

describe("marker atomicity (JEN-457)", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "jentrix-marker-atomic-"));
    return { configPath: join(root, "config.json"), repoRoot: root };
  };
  const marker = (sessionId: string) => ({
    sessionId,
    workspaceId: "ws_1",
    taskId: "task_1",
    capture: "off" as const,
    alignedAt: new Date().toISOString(),
  });

  it("leaves no temp or lock files behind", () => {
    const { configPath, repoRoot } = fixture();
    writeAlignmentMarker(configPath, repoRoot, marker("ses_a"), "prov_a");
    const dir = dirname(alignmentMarkerPath(configPath, repoRoot));
    const strays = readdirSync(dir).filter(
      (f) => f.endsWith(".tmp") || f.endsWith(".lock"),
    );
    assert.deepEqual(strays, [], `left behind: ${strays.join(", ")}`);
  });

  it("the file a reader sees is always complete JSON", () => {
    // tmp+rename means the marker path only ever holds a fully written file.
    const { configPath, repoRoot } = fixture();
    for (let i = 0; i < 25; i += 1) {
      writeAlignmentMarker(
        configPath,
        repoRoot,
        marker(`ses_${i}`),
        `prov_${i}`,
      );
      const raw = readFileSync(
        alignmentMarkerPath(configPath, repoRoot),
        "utf8",
      );
      JSON.parse(raw); // throws on a torn file
    }
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_24")?.sessionId,
      "ses_24",
    );
  });

  it("keeps EVERY session's entry when many are written in sequence", () => {
    const { configPath, repoRoot } = fixture();
    for (let i = 0; i < 10; i += 1) {
      writeAlignmentMarker(
        configPath,
        repoRoot,
        marker(`ses_${i}`),
        `prov_${i}`,
      );
    }
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        readAlignmentMarker(configPath, repoRoot, `prov_${i}`)?.sessionId,
        `ses_${i}`,
        `prov_${i} lost its entry`,
      );
    }
  });

  it("a stale lock is broken rather than wedging alignment forever", () => {
    const { configPath, repoRoot } = fixture();
    const lock = `${alignmentMarkerPath(configPath, repoRoot)}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    mkdirSync(lock);
    // Backdate it well past the staleness window (a crashed writer).
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    writeAlignmentMarker(configPath, repoRoot, marker("ses_after"), "prov_x");
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_x")?.sessionId,
      "ses_after",
      "a crashed writer's lock must not block every later alignment",
    );
  });

  it("clear removes only the ended session, and re-reads inside the lock", () => {
    const { configPath, repoRoot } = fixture();
    writeAlignmentMarker(configPath, repoRoot, marker("ses_a"), "prov_a");
    writeAlignmentMarker(configPath, repoRoot, marker("ses_b"), "prov_b");
    clearAlignmentMarker(configPath, repoRoot, "ses_a");
    assert.equal(readAlignmentMarker(configPath, repoRoot, "prov_a"), null);
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_b")?.sessionId,
      "ses_b",
      "a concurrent session's alignment must survive another session's end",
    );
  });

  it("clearing the last entry removes the file", () => {
    const { configPath, repoRoot } = fixture();
    writeAlignmentMarker(configPath, repoRoot, marker("ses_only"), "prov_only");
    clearAlignmentMarker(configPath, repoRoot, "ses_only");
    assert.equal(existsSync(alignmentMarkerPath(configPath, repoRoot)), false);
  });

  it("clearing a session nobody points at leaves the map intact", () => {
    const { configPath, repoRoot } = fixture();
    writeAlignmentMarker(configPath, repoRoot, marker("ses_a"), "prov_a");
    clearAlignmentMarker(configPath, repoRoot, "ses_nobody");
    assert.equal(
      readAlignmentMarker(configPath, repoRoot, "prov_a")?.sessionId,
      "ses_a",
    );
  });

  // THE ACTUAL RACE, in real processes. Everything above is sequential, and a
  // sequential test of a concurrency fix proves nothing — the sync
  // read-modify-write cannot even interleave inside one thread.
  //
  // Measured on the PRE-FIX logic (read → upsert → plain write) with eight
  // writers released on the same millisecond: 1, 6 and 7 of 8 entries survived
  // across three runs. Not the "tiny window" the gap report estimated — under
  // genuine simultaneity most sessions lose their alignment and every push
  // from them then resolves as unaligned.
  it("eight concurrent processes each keep their entry", () => {
    const { configPath, repoRoot } = fixture();
    const child = new URL("./fixtures/write-marker.mjs", import.meta.url)
      .pathname;
    const startAt = Date.now() + 500; // release them all together
    const kids = Array.from({ length: 8 }, (_, i) =>
      spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          child,
          configPath,
          repoRoot,
          `prov_${i}`,
          String(startAt),
        ],
        { stdio: "ignore" },
      ),
    );
    const done = kids.map(
      (k) =>
        new Promise<number>((resolve) =>
          k.on("exit", (code) => resolve(code ?? 1)),
        ),
    );
    return Promise.all(done).then((codes) => {
      assert.deepEqual(
        codes.filter((c) => c !== 0),
        [],
        "a writer exited non-zero",
      );
      for (let i = 0; i < 8; i += 1) {
        assert.equal(
          readAlignmentMarker(configPath, repoRoot, `prov_${i}`)?.sessionId,
          `prov_${i}`,
          `prov_${i} lost its entry to the race`,
        );
      }
      const dir = dirname(alignmentMarkerPath(configPath, repoRoot));
      assert.deepEqual(
        readdirSync(dir).filter(
          (f) => f.endsWith(".tmp") || f.endsWith(".lock"),
        ),
        [],
        "a crashed or contended writer left state behind",
      );
    });
  });
});
