/**
 * JEN-496 (hardening PRD S3, D5/D6/D11) — the three evidence forms.
 *
 * Across the two JEN-484 runs: five DECISION memos with no basis (four of them
 * pushed AFTER `session end` refused on E3, because the refusal taught the
 * agent to push memos until the count matched), gates claimed in prose with
 * zero LOGs, and a GAP filed about a spec the session never opened. Each is a
 * shape the CLI can refuse before it reaches the record.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  normalizeBasisFlags,
  runPush,
  type PushDeps,
} from "../src/commands/push";
import {
  contactVerdicts,
  parsePathsFlag,
  pathsMatch,
  pathsNamedIn,
  readContactEvidence,
  renderContact,
  unreadPathsNamedIn,
} from "../src/session/contact";
import { bashPathTokens } from "../src/session-host/session-skeleton";

const SESSION = "ses_evidence_1";

function deps(overrides: Partial<PushDeps> = {}): PushDeps & {
  out: string[];
  err: string[];
  bodies: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const bodies: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "jentrix-evidence-"));
  const base: PushDeps = {
    env: {},
    cwd: () => dir,
    configPath: join(dir, "config.json"),
    resolveTarget: () => ({
      token: "tm_test_token_abcdefghijklmnop",
      url: "http://localhost:3000/api/mcp",
    }),
    ensureInstallationId: () => "install-1234",
    connect: async () => {
      throw new Error("these paths never open an MCP connection");
    },
    git: async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { code: 0, stdout: `${dir}\n` };
      }
      if (args[0] === "remote")
        return { code: 0, stdout: "git@github.com:acme/app.git\n" };
      if (args[0] === "symbolic-ref") return { code: 0, stdout: "main\n" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n" };
      return { code: 0, stdout: "" };
    },
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    isInteractive: false,
    readLine: async () => "",
    runSessionHost: async () => 0,
    spawnSessionHostDetached: () => -1,
    spoolRoot: join(dir, "spool"),
    resolveSessionHost: () => null,
    fetchImpl: (async (_url: URL | string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({ artifactId: "art_1", type: "GAP", deduped: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
    ...overrides,
  };
  return Object.assign(base, { out, err, bodies });
}

/** A spooled skeleton naming the paths this session is said to have opened. */
function spoolSkeleton(d: PushDeps, paths: string[]): void {
  mkdirSync(join(d.spoolRoot, SESSION), { recursive: true });
  writeFileSync(
    join(d.spoolRoot, SESSION, "skeleton.json"),
    JSON.stringify({
      skeleton: { filesTouched: { total: paths.length, paths } },
      updatedAt: "2026-09-09T07:00:00.000Z",
    }),
  );
}

describe("D5 — a decision names its basis or says why not (AC3.1)", () => {
  it("refuses with neither, naming BOTH flags", async () => {
    const d = deps();
    const code = await runPush(
      "decision",
      undefined,
      { session: SESSION, readStdin: async () => "memo" } as never,
      { ...d, readStdin: async () => "memo" },
    );
    assert.equal(code, 2);
    const said = d.err.join("\n");
    assert.match(said, /--basis <artifact-id-or-url>/);
    assert.match(said, /--no-basis/);
  });

  it("refuses BOTH together", async () => {
    const d = deps({ readStdin: async () => "memo" });
    const code = await runPush(
      "decision",
      undefined,
      { session: SESSION, basis: ["https://x/y"], noBasis: "also" },
      d,
    );
    assert.equal(code, 2);
    assert.match(d.err.join("\n"), /not both/);
  });

  it("refuses an EMPTY reason — a blank line is not a stated reason", async () => {
    const d = deps({ readStdin: async () => "memo" });
    const code = await runPush(
      "decision",
      undefined,
      { session: SESSION, noBasis: "   " },
      d,
    );
    assert.equal(code, 2);
    assert.match(d.err.join("\n"), /--no-basis needs the reason/);
  });

  it("--no-basis writes the block parseBasisRefs can read", async () => {
    const d = deps({ readStdin: async () => "the memo body" });
    const code = await runPush(
      "decision",
      undefined,
      { session: SESSION, noBasis: "read the ops core myself; nothing filed" },
      d,
    );
    assert.equal(code, 0);
    const sent = JSON.parse(d.bodies[0]!) as { body: string };
    assert.equal(
      sent.body,
      "Based on:\n- none — read the ops core myself; nothing filed\n\nthe memo body",
    );
  });

  it("--no-basis is refused on any other kind", async () => {
    const d = deps({ readStdin: async () => "x" });
    const code = await runPush(
      "report",
      undefined,
      { session: SESSION, noBasis: "why" },
      d,
    );
    assert.equal(code, 2);
    assert.match(d.err.join("\n"), /only applies to `jentrix push decision`/);
  });

  it("commander's --no- collision is normalized at its edge", () => {
    // `--no-basis "reason"` arrives as a STRING on `basis`; `--basis a --basis b`
    // as an array. Both land on one attribute and commander cannot rename them.
    assert.deepEqual(normalizeBasisFlags({ basis: "why" as never }), {
      basis: [],
      noBasis: "why",
    });
    assert.deepEqual(normalizeBasisFlags({ basis: ["a", "b"] }), {
      basis: ["a", "b"],
    });
  });
});

describe("D6 — an un-attested LOG says so (AC3.2)", () => {
  it("warns on stderr and pushes anyway, exit 0 with the id", async () => {
    const d = deps({ readStdin: async () => "pnpm test — green, honest" });
    const code = await runPush("log", undefined, { session: SESSION }, d);
    assert.equal(code, 0);
    assert.match(
      d.err.join("\n"),
      /UNATTESTED LOG — a pasted body is a claim, not evidence; use --from-cmd/,
    );
    assert.match(d.out.join("\n"), /art_1/);
    // Never marked attested — that flag is the CLI's own capture, not a claim.
    assert.equal(
      (JSON.parse(d.bodies[0]!) as { attested?: boolean }).attested,
      undefined,
    );
  });

  it("--from-cmd changes nothing about the warning: it is not printed", async () => {
    const d = deps({
      runCommand: async () => ({ code: 0, output: "ok\n" }),
    });
    const code = await runPush(
      "log",
      undefined,
      { session: SESSION, fromCmd: "true" },
      d,
    );
    assert.equal(code, 0);
    assert.doesNotMatch(d.err.join("\n"), /UNATTESTED/);
    assert.equal(
      (JSON.parse(d.bodies[0]!) as { attested?: boolean }).attested,
      true,
    );
  });
});

describe("D11 — code contact (AC3.3/AC3.4)", () => {
  it("the Bash tokenizer sees a `sed` read and refuses a glob", () => {
    assert.deepEqual(bashPathTokens("sed -n 1,60p tests/e2e/x.spec.ts"), [
      "tests/e2e/x.spec.ts",
    ]);
    assert.deepEqual(bashPathTokens("cat src/a.ts && grep -n foo src/b.ts"), [
      "src/a.ts",
      "src/b.ts",
    ]);
    // The declared ceiling: globs, variables and bare directories are not paths.
    assert.deepEqual(
      bashPathTokens("ls *.ts && cat $FILE && grep -rn x src/"),
      [],
    );
  });

  it("a path is matched by suffix in both directions, never by substring", () => {
    assert.equal(pathsMatch("~/repo/src/a.ts", "src/a.ts"), true);
    assert.equal(pathsMatch("src/a.ts", "/abs/root/src/a.ts"), true);
    assert.equal(pathsMatch("xsrc/a.ts", "src/a.ts"), false);
  });

  it("contact answers opened / never opened from the spooled skeleton", () => {
    const d = deps();
    spoolSkeleton(d, ["~/repo/tests/e2e/x.spec.ts", "src/lib/zip.ts"]);
    const evidence = readContactEvidence(d.spoolRoot, SESSION);
    const verdicts = contactVerdicts(
      evidence,
      parsePathsFlag("tests/e2e/x.spec.ts, src/lib/zip.ts, src/other.ts"),
    );
    assert.deepEqual(
      verdicts.map((v) => [v.path, v.opened]),
      [
        ["tests/e2e/x.spec.ts", true],
        ["src/lib/zip.ts", true],
        ["src/other.ts", false],
      ],
    );
    assert.match(renderContact(evidence, verdicts), /2 distinct path\(s\)/);
  });

  it("with no skeleton at all, the answer SAYS it is absence, not evidence", () => {
    const d = deps();
    const verdicts = contactVerdicts(null, ["src/a.ts"]);
    assert.equal(verdicts[0]!.opened, false);
    assert.match(
      renderContact(readContactEvidence(d.spoolRoot, SESSION), verdicts),
      /'never opened' by absence, not by evidence/,
    );
  });

  it("a capped path list is disclosed — 'never opened' is then not provable", () => {
    const d = deps();
    mkdirSync(join(d.spoolRoot, SESSION), { recursive: true });
    writeFileSync(
      join(d.spoolRoot, SESSION, "skeleton.json"),
      JSON.stringify({
        skeleton: {
          filesTouched: { total: 900, paths: ["a/b.ts"], listTruncated: true },
        },
        updatedAt: "2026-09-09T07:00:00.000Z",
      }),
    );
    const evidence = readContactEvidence(d.spoolRoot, SESSION);
    assert.equal(evidence!.truncated, true);
    assert.match(
      renderContact(evidence, contactVerdicts(evidence, ["src/z.ts"])),
      /the observed path list was CAPPED/,
    );
  });

  it("prose paths are found, and only in-checkout ones are held against a gap", () => {
    const body =
      "The spec `tests/e2e/x.spec.ts` still asserts toBe(1); see https://example.com/a/b.html too.";
    assert.deepEqual(pathsNamedIn(body).sort(), ["tests/e2e/x.spec.ts"]);
    // Not in the checkout ⇒ never held against the author.
    assert.deepEqual(
      unreadPathsNamedIn(body, null, () => false),
      [],
    );
    assert.deepEqual(
      unreadPathsNamedIn(body, null, () => true),
      ["tests/e2e/x.spec.ts"],
    );
  });

  it("push gap refuses an unopened in-checkout path, and passes after the read (AC3.4)", async () => {
    const gap =
      "tests/e2e/x.spec.ts still asserts toBe(1) and would need flipping.";

    const refused = deps({
      readStdin: async () => gap,
      existsInCheckout: () => true,
    });
    assert.equal(
      await runPush("gap", undefined, { session: SESSION }, refused),
      2,
    );
    assert.match(
      refused.err.join("\n"),
      /never opened: tests\/e2e\/x\.spec\.ts/,
    );
    assert.match(refused.err.join("\n"), /read it or drop the path/);
    assert.deepEqual(refused.bodies, [], "nothing was sent");

    // …and the SAME push after one read of the file.
    const allowed = deps({
      readStdin: async () => gap,
      existsInCheckout: () => true,
    });
    spoolSkeleton(allowed, ["tests/e2e/x.spec.ts"]);
    assert.equal(
      await runPush("gap", undefined, { session: SESSION }, allowed),
      0,
    );
    assert.equal(allowed.bodies.length, 1);
  });
});
