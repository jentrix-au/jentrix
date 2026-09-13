import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// plugin-sync G07 — TEST THE GUARD. `pnpm check:plugin-sync` is copied with
// the tree it reads into a fixture, mutated one defect at a time, and must go
// red for each with a diagnostic that names the defect; the unmutated fixture
// must go green. Every case is a shape the guard exists to refuse: an omitted
// host, an edited generated workflow, a common fix applied to one adapter, a
// shared change mislabelled unaffected, a dropped required check, stale packed
// metadata, and a replayed (stale) verification.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Copy just what the guard reads (no node_modules, no dist). */
function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jentrix-plugin-sync-"));
  for (const rel of [
    "plugins",
    "scripts",
    "package.json",
    "contract.json",
    ".github",
    "src/session-host",
    "src/session",
    "src/commands",
    "src/main.ts",
    "src/session-host-main.ts",
    // The whole test tree: every impact record's evidence must resolve.
    "test",
  ]) {
    const from = path.join(root, rel);
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    cpSync(from, path.join(dir, rel), { recursive: true });
  }
  return dir;
}

const RECORD = "plugins/changes/2026-09-12-jen-533-sync-guard.json";

/** A shared path the guard's own record names, plus the record itself. */
const CHANGED = `scripts/check-plugin-sync.mjs,${RECORD}`;

function run(
  dir: string,
  extra: string[] = [],
): { code: number; out: string } {
  // `--changed` is read first-wins, so an explicit one in `extra` must lead.
  const changed = extra.includes("--changed") ? [] : ["--changed", CHANGED];
  try {
    const out = execFileSync(
      process.execPath,
      [
        path.join(dir, "scripts/check-plugin-sync.mjs"),
        "--root",
        dir,
        "--skip-tests",
        ...extra,
        ...changed,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const readJson = (dir: string, rel: string) =>
  JSON.parse(readFileSync(path.join(dir, rel), "utf8")) as Record<
    string,
    unknown
  >;
const writeJson = (dir: string, rel: string, value: unknown) =>
  writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);

describe("plugin-sync guard (G07 — the guard is itself tested)", () => {
  it("the valid candidate passes with --skip-tests", () => {
    const dir = fixture();
    try {
      const result = run(dir);
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /plugin-sync OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omitting an official host from an impact record fails (G02)", () => {
    const dir = fixture();
    try {
      const record = readJson(dir, RECORD) as { hosts: Record<string, unknown> };
      delete record.hosts.codex;
      writeJson(dir, RECORD, record);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /host codex has no disposition/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dropping a PLANNED host from the registry fails (G02: the all-host matrix shrank)", () => {
    const dir = fixture();
    try {
      // The record still names pi; the registry no longer knows it — an
      // impact record for an unknown host is as wrong as a missing one.
      const registry = readJson(dir, "plugins/registry.json") as {
        hosts: Record<string, unknown>;
      };
      delete registry.hosts.pi;
      writeJson(dir, "plugins/registry.json", registry);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /names unknown host pi/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a hand-edited generated workflow fails the packaged-resource digest (G05) and generation (G03)", () => {
    const dir = fixture();
    try {
      const file = path.join(dir, "plugins/claude/commands/jentrix-end.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\nEdited by hand.\n`);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /resourceDigest .* stale generated resources/);
      // Without --skip-tests the generator check refuses it too.
      const full = execFileSyncSafe(process.execPath, [
        path.join(dir, "scripts/generate-workflows.mjs"),
        "--check",
      ]);
      assert.match(full, /Stale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a common fix declared for one adapter only fails (G04: adapter-fix-applied without that adapter changing)", () => {
    const dir = fixture();
    try {
      const record = readJson(dir, RECORD) as {
        hosts: Record<string, { disposition: string; evidence?: string[] }>;
      };
      record.hosts.codex = {
        disposition: "adapter-fix-applied",
        evidence: ["test/plugin-parity.test.ts"],
      };
      writeJson(dir, RECORD, record);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(
        result.out,
        /host codex is adapter-fix-applied but the diff touched none of its adapter\/owned paths/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a shared change labelled verified-unaffected with no evidence fails (G02)", () => {
    const dir = fixture();
    try {
      const record = readJson(dir, RECORD) as {
        hosts: Record<string, unknown>;
      };
      record.hosts.claude = { disposition: "verified-unaffected" };
      writeJson(dir, RECORD, record);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /verified-unaffected with no executable evidence/);
      assert.match(result.out, /verified-unaffected with no rationale/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a plugin-relevant change with no impact record in the diff fails (G04)", () => {
    const dir = fixture();
    try {
      const result = run(dir, [
        "--changed",
        "src/session-host/session-bridge.ts",
      ]);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /NO impact record added or modified/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removing a required check from ci.yml fails (G04)", () => {
    const dir = fixture();
    try {
      const file = path.join(dir, ".github/workflows/ci.yml");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace("pnpm check:plugin-sync", "true"),
      );
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /no longer runs required check "pnpm check:plugin-sync"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stale package metadata (a behaviour revision that moved without a repack) fails (G05)", () => {
    const dir = fixture();
    try {
      const registry = readJson(dir, "plugins/registry.json");
      registry.behaviorRevision = "2099.01.01-1";
      writeJson(dir, "plugins/registry.json", registry);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /behaviorRevision "2026\.\d\d\.\d\d-\d+" != registry 2099\.01\.01-1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F06: a plugin cliRange that excludes the train's CLI fails (G05)", () => {
    const dir = fixture();
    try {
      const pkg = readJson(dir, "plugins/claude/package.json") as { jentrix: Record<string, unknown> };
      pkg.jentrix.cliRange = ">=99.0.0 <100.0.0";
      writeJson(dir, "plugins/claude/package.json", pkg);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /plugins\/claude\/package\.json: cliRange ">=99\.0\.0 <100\.0\.0" does not include @jentrix\/cli \d+\.\d+\.\d+ of this train/);
      // An unparseable range is refused too — a typo must not pass.
      pkg.jentrix.cliRange = "latest";
      writeJson(dir, "plugins/claude/package.json", pkg);
      assert.match(run(dir).out, /cliRange "latest" does not include/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F06: a semantic schema revision that drifts from the registry fails (G05) — on a plugin, and between the registry and the header module", () => {
    const dir = fixture();
    try {
      const pkg = readJson(dir, "plugins/codex/package.json") as { jentrix: Record<string, unknown> };
      pkg.jentrix.semanticSchemaRevision = 2;
      writeJson(dir, "plugins/codex/package.json", pkg);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /plugins\/codex\/package\.json: semanticSchemaRevision 2 != registry 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const drift = fixture();
    try {
      const registry = readJson(drift, "plugins/registry.json");
      registry.semanticSchemaRevision = 2;
      writeJson(drift, "plugins/registry.json", registry);
      const result = run(drift);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /semantic-header\.ts declares schema 1 but the registry says 2/);
      assert.match(result.out, /package\.json: semanticSchemaRevision 1 != registry 2/);
    } finally {
      rmSync(drift, { recursive: true, force: true });
    }
  });

  it("F06: a CLI serverApiRange that excludes the contract's API release fails (G05)", () => {
    const dir = fixture();
    try {
      const pkg = readJson(dir, "package.json") as { jentrix: Record<string, unknown> };
      pkg.jentrix.serverApiRange = "^9.0.0";
      writeJson(dir, "package.json", pkg);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /package\.json: serverApiRange "\^9\.0\.0" does not include the API release the CLI's contract pins \(\d+\.\d+\.\d+\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a planned host with a package on disk is refused until enrolled (G01)", () => {
    const dir = fixture();
    try {
      mkdirSync(path.join(dir, "plugins/opencode"), { recursive: true });
      writeJson(dir, "plugins/opencode/package.json", {
        name: "@jentrix/plugin-opencode",
        version: "0.0.0",
      });
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /planned host opencode has a package on disk/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a mixed or incomplete packed set is refused (G05 --packed)", () => {
    const dir = fixture();
    const packed = mkdtempSync(path.join(tmpdir(), "jentrix-packed-"));
    try {
      // An empty pack dir: no tarball for any package.
      const result = run(dir, ["--packed", packed]);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /no tarball for cli/);
      assert.match(result.out, /no tarball for claude/);
      assert.match(result.out, /no tarball for codex/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(packed, { recursive: true, force: true });
    }
  });

  it("a replayed verification citing a test that does not exist fails (G02: stale evidence)", () => {
    const dir = fixture();
    try {
      const record = readJson(dir, RECORD) as {
        hosts: Record<string, { disposition: string; evidence?: string[] }>;
      };
      record.hosts.claude.evidence = ["test/removed-long-ago.test.ts"];
      writeJson(dir, RECORD, record);
      const result = run(dir);
      assert.notEqual(result.code, 0);
      assert.match(result.out, /cites evidence test\/removed-long-ago\.test\.ts which does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function execFileSyncSafe(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}
