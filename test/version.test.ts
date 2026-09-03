import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CLI_VERSION } from "../src/client";
import { loadSurface } from "../src/surface";
import { formatVersion } from "../src/version";

/**
 * `jentrix --version` contract (C4.3): the version line carries the CLI semver
 * PLUS the surface size and its generation date, degrading gracefully when the
 * manifest is missing. `formatVersion` is pure, so every branch is covered
 * here without spawning the binary; a separate assertion pins it against the
 * real checked-in manifest so a surface change is visible in the version line.
 */

const SEMVER = /^\d+\.\d+\.\d+$/;

describe("formatVersion — composition", () => {
  it("includes semver, tool count, and the surface-file day when all are known", () => {
    const line = formatVersion({
      version: "0.1.0",
      toolCount: 134,
      surfaceFileMtime: "2026-07-06T09:34:00.000Z",
    });
    assert.equal(line, "0.1.0 (surface: 134 tools, file dated 2026-07-06)");
    // The three facts the stage requires are all present.
    assert.match(line, /\b0\.1\.0\b/);
    assert.match(line, /\b134 tools\b/);
    assert.match(line, /file dated 2026-07-06/);
    // Honesty: it must NOT claim the surface was "generated" on that date —
    // the mtime is the file's write time, not a generation proof (SVR R1-3).
    assert.doesNotMatch(line, /generated/);
  });

  it("renders count only when the date is unavailable", () => {
    assert.equal(
      formatVersion({
        version: "0.1.0",
        toolCount: 134,
        surfaceFileMtime: null,
      }),
      "0.1.0 (surface: 134 tools)",
    );
  });

  it("renders date only when the count is unavailable", () => {
    assert.equal(
      formatVersion({
        version: "0.1.0",
        toolCount: null,
        surfaceFileMtime: "2026-07-06T00:00:00.000Z",
      }),
      "0.1.0 (surface: file dated 2026-07-06)",
    );
  });

  it("falls back to a bare semver when neither count nor date is known", () => {
    assert.equal(
      formatVersion({
        version: "0.1.0",
        toolCount: null,
        surfaceFileMtime: null,
      }),
      "0.1.0",
    );
  });

  it("drops a malformed surfaceFileMtime instead of echoing it", () => {
    const line = formatVersion({
      version: "0.1.0",
      toolCount: 5,
      surfaceFileMtime: "not-a-date",
    });
    assert.equal(line, "0.1.0 (surface: 5 tools)");
    assert.doesNotMatch(line, /not-a-date/);
  });

  it("drops a non-finite tool count", () => {
    assert.equal(
      formatVersion({
        version: "0.1.0",
        toolCount: NaN,
        surfaceFileMtime: null,
      }),
      "0.1.0",
    );
  });

  it("normalizes the file instant to a UTC calendar day", () => {
    // A late-evening UTC instant stays on its own UTC day (no local-tz shift).
    const line = formatVersion({
      version: "9.9.9",
      toolCount: 1,
      surfaceFileMtime: "2026-01-15T23:59:59.999Z",
    });
    assert.match(line, /file dated 2026-01-15/);
  });
});

describe("formatVersion — against the real manifest", () => {
  const manifest = loadSurface(
    readFileSync(new URL("../surface.json", import.meta.url), "utf8"),
  );

  it("CLI_VERSION is a valid semver", () => {
    assert.match(CLI_VERSION, SEMVER);
  });

  it("CLI constant matches its package", () => {
    // The release tag pins the CLI: the constant must match this package's
    // own package.json. The runner is semver-decoupled and, since open-client
    // S2, released and checked from its own workflow — nothing in this package
    // reads agents/.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    assert.equal(CLI_VERSION, pkg.version);
  });

  it("the version line names the CLI semver and the real tool count", () => {
    const line = formatVersion({
      version: CLI_VERSION,
      toolCount: manifest.generatedForToolCount,
      surfaceFileMtime: null,
    });
    assert.ok(
      line.startsWith(`${CLI_VERSION} `),
      `expected line to start with the semver, got: ${line}`,
    );
    assert.match(
      line,
      new RegExp(`\\b${manifest.generatedForToolCount} tools\\b`),
    );
    // Sanity: the manifest really is the product surface, not a stub.
    assert.ok(manifest.generatedForToolCount >= 50);
  });
});
