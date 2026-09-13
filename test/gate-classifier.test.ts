import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyGateCommand,
  familyOfScriptName,
  scriptBodyProblem,
  type ReviewedGate,
} from "../src/session-host/gate-classifier.js";

// F01 (2026-09-12 review) — the gate classifier's PINNED CORPUS, mirrored
// byte for byte by the server's `src/lib/gate-classifier.test.ts`. A verdict
// that changes here changes there; the receipt and the evidence floor must
// agree on every line below. `scripts` is the package.json the command ran
// in: an object resolves names, `null` is "no package.json" (the server's
// legacy path), and a name missing from the object is "no such script".

export const CORPUS: Array<{
  command: string;
  scripts?: Record<string, string> | null;
  reviewed?: ReviewedGate[];
  allowlisted: boolean;
  families?: string[];
  source?: string;
  gateId?: string;
  scriptResolved?: boolean;
  reason?: string;
}> = [
  // the review's two reproductions
  { command: "node -e \"console.log('test')\"", allowlisted: false, reason: "not a gate runner" },
  { command: "node -e \"process.exit(1)\" test || node -e \"process.exit(0)\"", allowlisted: false, reason: "`||` hides" },
  // package scripts bind by NAME and carry the body
  { command: "pnpm test:mvp", scripts: { "test:mvp": "STACKS_UNIT_LANE=product vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "cd /x && CI=true pnpm typecheck", scripts: { typecheck: "tsc --noEmit" }, allowlisted: false, reason: "changes the execution directory" },
  { command: "pnpm typecheck && pnpm lint && pnpm test", scripts: { typecheck: "tsc --noEmit", lint: "eslint", test: "vitest run" }, allowlisted: true, families: ["typecheck", "lint", "test"], source: "script" },
  { command: "npm test", scripts: { test: "node --import tsx --test \"test/*.test.ts\"" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "npm run test:e2e", scripts: { "test:e2e": "node scripts/run-e2e.mjs" }, allowlisted: true, families: ["e2e"], source: "script" },
  { command: "yarn lint", scripts: { lint: "eslint ." }, allowlisted: true, families: ["lint"], source: "script" },
  { command: "bun run test", scripts: { test: "bun test" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "pnpm test", scripts: { test: "echo ok" }, allowlisted: false, reason: "only echoes, exits or evaluates inline code" },
  { command: "pnpm test", scripts: { test: "node -e \"console.log('test')\"" }, allowlisted: false, reason: "only echoes, exits or evaluates inline code" },
  { command: "pnpm test", scripts: {}, allowlisted: false, reason: "declares no script \"test\"" },
  { command: "pnpm docs:check", scripts: { "docs:check": "node --import tsx scripts/docs-check.ts" }, allowlisted: false, reason: "names no gate family" },
  { command: "pnpm -r test", scripts: { test: "vitest run" }, allowlisted: false, reason: "flag before the script name" },
  { command: "npm ci", scripts: { ci: "vitest" }, allowlisted: false, reason: "not a script invocation" },
  // the legacy name-only path (no package.json readable at all)
  { command: "pnpm test:mvp", scripts: null, allowlisted: true, families: ["test"], source: "script", scriptResolved: false },
  // composition other than && hides the exit status
  { command: "pnpm test:mvp || true", scripts: { "test:mvp": "vitest run" }, allowlisted: false, reason: "`||` hides" },
  { command: "pnpm test | tail -40", scripts: { test: "vitest run" }, allowlisted: false, reason: "`|` (a pipe) hides" },
  { command: "pnpm typecheck; pnpm test", scripts: { typecheck: "tsc", test: "vitest" }, allowlisted: false, reason: "`;` hides" },
  { command: "pnpm test &", scripts: { test: "vitest" }, allowlisted: false, reason: "`&` (a background job) hides" },
  { command: "pnpm test 2>&1", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  // runners fix their own family; anything else is not a gate
  { command: "vitest run --coverage", allowlisted: true, families: ["test"], source: "runner" },
  { command: "npx vitest run", allowlisted: true, families: ["test"], source: "runner" },
  { command: "pnpm exec tsc -p tsconfig.json --noEmit", allowlisted: true, families: ["typecheck"], source: "runner" },
  { command: "node --test test/*.test.ts", allowlisted: true, families: ["test"], source: "runner" },
  { command: "playwright test", allowlisted: true, families: ["e2e"], source: "runner" },
  { command: "playwright show-report", allowlisted: false, reason: "not a gate runner" },
  { command: "prettier --check .", allowlisted: true, families: ["lint"], source: "runner" },
  { command: "prettier --write .", allowlisted: false, reason: "not a gate runner" },
  { command: "python -m pytest -q", allowlisted: true, families: ["test"], source: "runner" },
  { command: "uv run pytest", allowlisted: true, families: ["test"], source: "runner" },
  { command: "cargo test --all", allowlisted: true, families: ["test"], source: "runner" },
  { command: "go test ./...", allowlisted: true, families: ["test"], source: "runner" },
  { command: "tsc --noEmit && vitest run", allowlisted: true, families: ["typecheck", "test"], source: "runner" },
  { command: "pnpm typecheck && vitest run", scripts: { typecheck: "tsc" }, allowlisted: true, families: ["typecheck", "test"], source: "mixed" },
  { command: "node scripts/run.mjs", allowlisted: false, reason: "not a gate runner" },
  { command: "make test", allowlisted: false, reason: "not a gate runner" },
  { command: "echo tests green", allowlisted: false, reason: "not a gate runner" },
  { command: "true", allowlisted: false, reason: "not a gate runner" },
  { command: "bash -c 'pnpm lint'", scripts: { lint: "eslint" }, allowlisted: true, families: ["lint"], source: "script" },
  { command: "", allowlisted: false, reason: "empty command" },
  { command: "cd /repo", allowlisted: false, reason: "changes the execution directory" },
  // 2026-09-13 review F01: operators glued to words, help/version/listing modes
  { command: "node --test 'fail.test.mjs' ||true", allowlisted: false, reason: "`||` hides" },
  { command: "node --test 'fail.test.mjs'|cat", allowlisted: false, reason: "`|` (a pipe) hides" },
  { command: "node --test --help", allowlisted: false, reason: "prints and exits" },
  { command: "node --test fail.test.mjs;true", allowlisted: false, reason: "`;` hides" },
  { command: "vitest --version", allowlisted: false, reason: "prints and exits" },
  { command: "vitest -v", allowlisted: false, reason: "prints and exits" },
  { command: "pytest -v", allowlisted: true, families: ["test"], source: "runner" },
  { command: "jest --listTests", allowlisted: false, reason: "prints and exits" },
  { command: "pytest --collect-only -q", allowlisted: false, reason: "prints and exits" },
  { command: "pnpm test -- --help", scripts: { test: "vitest run" }, allowlisted: false, reason: "prints and exits" },
  { command: "npm test -- --version", scripts: { test: "vitest run" }, allowlisted: false, reason: "prints and exits" },
  { command: "cargo help test", allowlisted: false, reason: "prints and exits" },
  { command: "$(echo pnpm) test", scripts: { test: "vitest run" }, allowlisted: false, reason: "command substitution" },
  { command: "pnpm test \"$(true)\"", scripts: { test: "vitest run" }, allowlisted: false, reason: "command substitution" },
  { command: "pnpm test `true`", scripts: { test: "vitest run" }, allowlisted: false, reason: "command substitution" },
  { command: "(pnpm test)", scripts: { test: "vitest run" }, allowlisted: false, reason: "subshell" },
  { command: "{ pnpm test; }", scripts: { test: "vitest run" }, allowlisted: false, reason: "brace grouping" },
  { command: "pnpm test\npnpm lint", scripts: { test: "vitest run", lint: "eslint" }, allowlisted: false, reason: "newline" },
  { command: "! pnpm test", scripts: { test: "vitest run" }, allowlisted: false, reason: "negation" },
  { command: "pnpm test \\\n  --run", scripts: { test: "vitest run" }, allowlisted: false, reason: "line continuation" },
  { command: "bash -c 'pnpm test || true'", scripts: { test: "vitest run" }, allowlisted: false, reason: "`||` hides" },
  { command: "bash -c 'pnpm test' extra", scripts: { test: "vitest run" }, allowlisted: false, reason: "runs only as" },
  { command: "pnpm test # run the suite", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "pnpm test >out.txt 2>&1", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "pnpm test &>/tmp/out.log", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "env CI=true pnpm test", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  { command: "env -u DEBUG -i CI=1 vitest run", allowlisted: true, families: ["test"], source: "runner" },
  { command: "pnpm test 'it \"quotes\" fine'", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  // 2026-09-13 review F02a: a gate must run in the checkout the receipt describes
  { command: "cd /tmp/b && node --test pass.test.mjs", allowlisted: false, reason: "changes the execution directory" },
  { command: "pushd ../b && pnpm test", scripts: { test: "vitest run" }, allowlisted: false, reason: "changes the execution directory" },
  { command: "sh -c 'cd /x && pnpm test'", scripts: { test: "vitest run" }, allowlisted: false, reason: "changes the execution directory" },
  { command: "node --test /abs/path/fail.test.mjs", allowlisted: false, reason: "reaches outside the checkout" },
  { command: "node --test ../b/pass.test.mjs", allowlisted: false, reason: "reaches outside the checkout" },
  { command: "tsc -p ../b/tsconfig.json", allowlisted: false, reason: "reaches outside the checkout" },
  { command: "vitest run --root=../b", allowlisted: false, reason: "reaches outside the checkout" },
  { command: "pytest ~/other/tests", allowlisted: false, reason: "reaches outside the checkout" },
  { command: "npm run test --prefix ../b", scripts: { test: "vitest run" }, allowlisted: false, reason: "reaches outside the checkout" },
  { command: "npm run test --prefix b", scripts: { test: "vitest run" }, allowlisted: false, reason: "another directory or package" },
  { command: "pnpm test --filter other", scripts: { test: "vitest run" }, allowlisted: false, reason: "another directory or package" },
  { command: "tsc -p tsconfig.mvp.json --noEmit", allowlisted: true, families: ["typecheck"], source: "runner" },
  { command: "vitest run src/x.test.ts ./test/y.test.ts", allowlisted: true, families: ["test"], source: "runner" },
  { command: "pnpm test --reporter=dot", scripts: { test: "vitest run" }, allowlisted: true, families: ["test"], source: "script" },
  // reviewed wrappers: the exact reviewed line, nothing else
  { command: "./scripts/gates.sh", reviewed: [{ id: "mvp-gates", command: "./scripts/gates.sh", families: ["typecheck", "test"] }], allowlisted: true, families: ["typecheck", "test"], source: "reviewed", gateId: "mvp-gates" },
  { command: "./scripts/gates.sh --skip-tests", reviewed: [{ id: "mvp-gates", command: "./scripts/gates.sh", families: ["typecheck", "test"] }], allowlisted: false, reason: "not a gate runner" },
];

export function contextOf(entry: { scripts?: Record<string, string> | null; reviewed?: ReviewedGate[] }) {
  return {
    reviewed: entry.reviewed ?? [],
    resolveScript:
      entry.scripts === null
        ? () => undefined
        : (_manager: string, name: string) => {
            const body = entry.scripts?.[name];
            return typeof body === "string" ? { body } : null;
          },
  };
}

describe("gate classifier — pinned corpus (mirrored by the server)", () => {
  for (const entry of CORPUS) {
    it(`${JSON.stringify(entry.command)} → ${entry.allowlisted ? entry.families!.join("+") : "refused"}`, () => {
      const verdict = classifyGateCommand(entry.command, contextOf(entry));
      assert.equal(verdict.allowlisted, entry.allowlisted, verdict.reason ?? "");
      if (entry.allowlisted) {
        assert.deepEqual(verdict.families, entry.families);
        assert.equal(verdict.source, entry.source);
        assert.equal(verdict.gateId, entry.gateId ?? null);
        assert.equal(verdict.scriptResolved, entry.scriptResolved ?? true);
        assert.equal(verdict.reason, null);
      } else {
        assert.deepEqual(verdict.families, []);
        assert.ok(verdict.reason?.includes(entry.reason!), `reason ${JSON.stringify(verdict.reason)} lacks ${JSON.stringify(entry.reason)}`);
      }
    });
  }

  it("script bindings carry the resolved body for the receipt", () => {
    const verdict = classifyGateCommand("pnpm typecheck && pnpm test", contextOf({ scripts: { typecheck: "tsc --noEmit", test: "vitest run" } }));
    assert.deepEqual(verdict.scripts, [
      { manager: "pnpm", name: "typecheck", body: "tsc --noEmit" },
      { manager: "pnpm", name: "test", body: "vitest run" },
    ]);
  });

  it("family of a script name: e2e beats test, unrelated names bind nothing", () => {
    assert.equal(familyOfScriptName("test:e2e"), "e2e");
    assert.equal(familyOfScriptName("test:mvp"), "test");
    assert.equal(familyOfScriptName("typecheck:mvp"), "typecheck");
    assert.equal(familyOfScriptName("lint:fix"), "lint");
    assert.equal(familyOfScriptName("build"), null);
  });

  it("a script body needs one substantive command; composition inside committed code is the repository's business", () => {
    assert.equal(scriptBodyProblem("rm -rf .next && tsc -p tsconfig.mvp.json --noEmit; code=$?; prisma generate >/dev/null; exit $code"), null);
    assert.equal(scriptBodyProblem("vitest run || true"), null);
    assert.match(scriptBodyProblem("exit 0")!, /only echoes/);
    assert.match(scriptBodyProblem("bash -c 'echo hi'")!, /only echoes/);
    assert.match(scriptBodyProblem("   ")!, /empty/);
  });
});
