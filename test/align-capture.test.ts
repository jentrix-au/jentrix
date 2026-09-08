import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  captureSourceLabel,
  captureSubmission,
  decideCaptureMode,
  skeletonSubmission,
} from "../src/session/host-control";
import {
  isHostCapturing,
  type LocalHostMarker,
  readLiveHostMarker,
} from "../src/session/host-control";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AGE-956 — the capture consent contract: a re-align with no flag NEVER flips
 * the record, and "capturing" is read from the live host's actual state,
 * never from the existence of a host marker.
 */

describe("decideCaptureMode", () => {
  const table: Array<{
    requested: boolean | undefined;
    liveCapturing: boolean;
    want: "off" | "on";
  }> = [
    { requested: undefined, liveCapturing: false, want: "off" },
    { requested: undefined, liveCapturing: true, want: "on" },
    { requested: true, liveCapturing: false, want: "on" },
    { requested: true, liveCapturing: true, want: "on" },
    { requested: false, liveCapturing: false, want: "off" },
    { requested: false, liveCapturing: true, want: "off" },
  ];
  for (const row of table) {
    it(`requested=${String(row.requested)} liveCapturing=${row.liveCapturing} → ${row.want}`, () => {
      assert.equal(
        decideCaptureMode(row.requested, row.liveCapturing),
        row.want,
      );
    });
  }
});

describe("isHostCapturing", () => {
  const deps = { spoolRoot: "/spool" };
  const marker = (overrides: LocalHostMarker = {}): LocalHostMarker => ({
    pid: 1,
    mode: "watch",
    ...overrides,
  });

  it("stamped captureTrace is authoritative — both values", () => {
    assert.equal(
      isHostCapturing(deps, "s1", marker({ captureTrace: true }), () => []),
      true,
    );
    assert.equal(
      isHostCapturing(
        deps,
        "s1",
        marker({ captureTrace: false }),
        // Even with part files present: the stamp wins (an older capture's
        // leftovers must not make a capture-off host read as capturing).
        () => ["part-000001.ndjson"],
      ),
      false,
    );
  });

  it("legacy marker (no stamp): part files are the capture evidence", () => {
    assert.equal(
      isHostCapturing(deps, "s1", marker(), () => [
        "host.json",
        "part-000001.ndjson",
      ]),
      true,
    );
    assert.equal(
      isHostCapturing(deps, "s1", marker(), () => ["host.json", "usage.json"]),
      false,
    );
  });

  it("legacy marker + unreadable spool → not capturing (fail toward the promise)", () => {
    assert.equal(
      isHostCapturing(deps, "s1", marker(), () => {
        throw new Error("ENOENT");
      }),
      false,
    );
  });
});

/**
 * Capture settings (capture-settings PRD §5, D3/D4) — the tri-state
 * submission. An OMITTED field is the only way the server ever reaches the
 * account default, and a live host must always send what it is actually doing.
 */
describe("captureSubmission (tri-state)", () => {
  const table: Array<{
    requested: boolean | undefined;
    liveHost: boolean;
    liveCapturing: boolean;
    want: "off" | "on" | undefined;
  }> = [
    // No flag, no host: OMIT — the server resolves the account default.
    {
      requested: undefined,
      liveHost: false,
      liveCapturing: false,
      want: undefined,
    },
    // No flag, live host: send what the host is ACTUALLY doing, both ways —
    // a default must never flip a live session's record or overclaim.
    { requested: undefined, liveHost: true, liveCapturing: false, want: "off" },
    { requested: undefined, liveHost: true, liveCapturing: true, want: "on" },
    // A flag always sends, host or no host — exactly as today.
    { requested: true, liveHost: false, liveCapturing: false, want: "on" },
    { requested: false, liveHost: false, liveCapturing: false, want: "off" },
    { requested: false, liveHost: true, liveCapturing: true, want: "off" },
  ];
  for (const row of table) {
    it(`requested=${String(row.requested)} liveHost=${row.liveHost} liveCapturing=${row.liveCapturing} → ${String(row.want)}`, () => {
      assert.equal(
        captureSubmission(row.requested, row.liveHost, row.liveCapturing),
        row.want,
      );
    });
  }
});

describe("skeletonSubmission (tri-state)", () => {
  it("omits with no flag; either flag sends", () => {
    assert.equal(skeletonSubmission(undefined), undefined);
    assert.equal(skeletonSubmission(true), "on");
    assert.equal(skeletonSubmission(false), "off");
  });
});

describe("captureSourceLabel", () => {
  it("corrects the live-host observation the server reads as a flag", () => {
    assert.equal(captureSourceLabel(undefined, true, "(flag)"), "(live host)");
  });

  it("passes the server's own word through everywhere else", () => {
    assert.equal(captureSourceLabel(true, true, "(flag)"), "(flag)");
    assert.equal(captureSourceLabel(false, false, "(flag)"), "(flag)");
    assert.equal(
      captureSourceLabel(undefined, false, "(your default)"),
      "(your default)",
    );
    assert.equal(
      captureSourceLabel(undefined, false, "(built-in)"),
      "(built-in)",
    );
  });

  it("claims nothing when the server supplied nothing (older server)", () => {
    assert.equal(captureSourceLabel(undefined, false, undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// JEN-457 — a live host still SENDS its observed capture state (the snapshot is
// a consent record of collection actually happening), but the DISCLOSURE now
// names the operator's own reason instead of the messenger. `connect` resolves
// the mode through the server's chain before launching, and stamps that
// provenance on the host marker.
// ---------------------------------------------------------------------------

describe("captureSourceLabel — host provenance (JEN-457)", () => {
  it("prefers the live host's own recorded source over the generic label", () => {
    assert.equal(
      captureSourceLabel(undefined, true, "(flag)", "(built-in)"),
      "(built-in)",
    );
    assert.equal(
      captureSourceLabel(undefined, true, "(flag)", "(your default)"),
      "(your default)",
    );
  });

  it("falls back to (live host) for a host started by an older CLI", () => {
    assert.equal(
      captureSourceLabel(undefined, true, "(flag)", undefined),
      "(live host)",
    );
  });

  it("an explicit flag still reports the SERVER's label, host or not", () => {
    assert.equal(
      captureSourceLabel(true, true, "(flag)", "(your default)"),
      "(flag)",
    );
    assert.equal(captureSourceLabel(false, false, "(flag)"), "(flag)");
  });

  it("no host, no flag: the server's word, unchanged", () => {
    assert.equal(
      captureSourceLabel(undefined, false, "(your default)"),
      "(your default)",
    );
  });
});

/**
 * JEN-474 — the default pid probe under a process sandbox. `kill(pid, 0)` on
 * a live host started from another sandbox instance throws EPERM (the process
 * exists; this caller may not signal it). Reading that as "dead" made align
 * launch a second host and skip its flush, and made end complete server-side
 * without ever asking the live host for its manifest.
 */
describe("readLiveHostMarker default probe (JEN-474)", () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "jentrix-liveness-"));
  mkdirSync(join(spoolRoot, "s1"));
  writeFileSync(
    join(spoolRoot, "s1", "host.json"),
    JSON.stringify({ pid: 4242, mode: "watch", provider: "codex" }),
  );
  const withKill = (code: string, fn: () => void) => {
    const real = process.kill;
    process.kill = ((pid: number) => {
      assert.equal(pid, 4242);
      throw Object.assign(new Error(code), { code });
    }) as typeof process.kill;
    try {
      fn();
    } finally {
      process.kill = real;
    }
  };

  it("EPERM means the host EXISTS — the marker is live", () => {
    withKill("EPERM", () => {
      assert.equal(readLiveHostMarker({ spoolRoot }, "s1")?.pid, 4242);
    });
  });

  it("ESRCH means no such process — the marker is stale", () => {
    withKill("ESRCH", () => {
      assert.equal(readLiveHostMarker({ spoolRoot }, "s1"), null);
    });
  });
});
