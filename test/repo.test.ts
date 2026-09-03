/**
 * M20.1 §9.2 — repository identity for connected sessions. The normalization
 * fixtures below are the CONTRACT the agents/lib/preflight.ts mirror also
 * satisfies; a divergence between the two is a bug in whichever side changed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectRepository,
  localRepoIdentity,
  normalizeRemoteRepo,
  type GitRunner,
} from "../src/repo";

test("normalizeRemoteRepo matches the runner mirror on every remote shape", () => {
  const cases: Array<[string, string | null]> = [
    [
      "https://github.com/Jentrix-AU/Task-Manager.git",
      "jentrix-au/task-manager",
    ],
    ["https://github.com/acme/api", "acme/api"],
    ["https://github.com/acme/api/", "acme/api"],
    ["git@github.com:acme/api.git", "acme/api"],
    ["ssh://git@github.com/acme/api.git", "acme/api"],
    ["https://ghe.example.com/Team/Repo.git", "team/repo"],
    ["", null],
    ["   ", null],
    ["not a url", null],
    ["https://github.com/only-owner", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeRemoteRepo(input), expected, input);
  }
});

function fakeGit(
  responses: Record<string, { code: number; stdout: string }>,
): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    return responses[key] ?? { code: 1, stdout: "" };
  };
}

test("inspectRepository reports a clean checkout without mutation", async () => {
  const inspection = await inspectRepository(
    "/work/api/src",
    fakeGit({
      "rev-parse --show-toplevel": { code: 0, stdout: "/work/api\n" },
      "remote get-url origin": {
        code: 0,
        stdout: "git@github.com:Acme/API.git\n",
      },
      "symbolic-ref --short -q HEAD": { code: 0, stdout: "main\n" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
      "status --porcelain": { code: 0, stdout: "" },
    }),
  );
  assert.deepEqual(inspection, {
    root: "/work/api",
    repoOwnerName: "acme/api",
    syntheticRepoIdentity: false,
    originUrl: "git@github.com:Acme/API.git",
    branch: "main",
    head: "abc123",
    dirty: false,
  });
});

test("localRepoIdentity is a stable owner/name for a remote-less checkout", () => {
  const cases: Array<[string, string]> = [
    // Mixed case in, lowercased out — the folder name is arbitrary fixture
    // text; what this pins is the case-folding, not the word.
    ["/work/Jentrix-Codex-Test", "local/jentrix-codex-test"],
    ["/work/my project", "local/my-project"],
    ["C:\\work\\api", "local/api"],
    ["/work/api/", "local/api"],
    ["/", "local/checkout"],
  ];
  for (const [root, expected] of cases) {
    assert.equal(localRepoIdentity(root), expected, root);
    // Whatever it produces must satisfy the server's owner/name contract.
    assert.match(localRepoIdentity(root), /^[^/\s]+\/[^/\s]+$/);
  }
});

test("inspectRepository falls back to a local identity without a usable origin", async () => {
  // Not every project has a remote — the session still needs an identity.
  const inspection = await inspectRepository(
    "/work/api",
    fakeGit({
      "rev-parse --show-toplevel": { code: 0, stdout: "/work/api\n" },
      "remote get-url origin": { code: 2, stdout: "" },
      "symbolic-ref --short -q HEAD": { code: 1, stdout: "" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
      "status --porcelain": { code: 0, stdout: " M src/app.ts\n" },
    }),
  );
  assert.deepEqual(inspection, {
    root: "/work/api",
    repoOwnerName: "local/api",
    syntheticRepoIdentity: true,
    originUrl: null,
    branch: null,
    head: "abc123",
    dirty: true,
  });
});

test("inspectRepository falls back when origin exists but is unrecognizable", async () => {
  const inspection = await inspectRepository(
    "/work/api",
    fakeGit({
      "rev-parse --show-toplevel": { code: 0, stdout: "/work/api\n" },
      "remote get-url origin": { code: 0, stdout: "not a url\n" },
      "symbolic-ref --short -q HEAD": { code: 0, stdout: "main\n" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
      "status --porcelain": { code: 0, stdout: "" },
    }),
  );
  assert.equal(inspection?.repoOwnerName, "local/api");
  assert.equal(inspection?.syntheticRepoIdentity, true);
  // The raw remote is still reported for local diagnostics.
  assert.equal(inspection?.originUrl, "not a url");
});

test("inspectRepository returns null outside a git work tree", async () => {
  assert.equal(await inspectRepository("/tmp/nowhere", fakeGit({})), null);
});
