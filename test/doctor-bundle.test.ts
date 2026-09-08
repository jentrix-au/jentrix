import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CLI_VERSION } from "../src/client";
import { doctorBundle } from "../src/commands/doctor-client";
import { runSessionDoctor } from "../src/session/doctor";
import { type DoctorCheck, type SessionCommandDeps } from "../src/session/deps";
import { type SessionToolCaller } from "../src/tool-client";

/**
 * `jentrix session doctor --bundle` (open-client R2 S2, PRD §8 Phase 5): the
 * support bundle is REDACTED BY CONSTRUCTION. These tests plant every kind of
 * thing the bundle must not carry — a bearer literal from the environment, a
 * token in a check's prose, a transcript line, a hook body and a file's
 * contents attached as check data — and grep the serialized bundle for each.
 */

const PLANTED_TOKEN = "tm_plantedsecretbearer0123456789";
const PLANTED_ENV_LITERAL = "envliteral-Sup3rS3cret-value";
const PLANTED_TRANSCRIPT_LINE =
  "USER: here is my private transcript line about the acquisition";
const PLANTED_HOOK_BODY =
  '"/opt/node" "/opt/lib/node_modules/@jentrix/cli/dist/session-host-main.js" hook --provider claude --event SessionStart';
const PLANTED_FILE_CONTENTS = "-----BEGIN FILE-----\nsecret config body\n";

const checks: DoctorCheck[] = [
  {
    name: "session host",
    status: "ok",
    detail:
      "/Users/op/.nvm/node/lib/node_modules/@jentrix/cli/dist/session-host-main.js",
  },
  {
    name: "credential",
    status: "fail",
    detail: `token verification failed: Bearer ${PLANTED_TOKEN} was refused (env ${PLANTED_ENV_LITERAL})`,
    fix: "jentrix login",
  },
  {
    // A check that (wrongly) attached transcript and file contents as data:
    // the bundle must drop them — its details are the doctor's own prose,
    // never a transcript's, and `data` survives for the contract alone.
    name: "telemetry",
    status: "warn",
    detail: "FOLDER_NOT_ALIGNED: this checkout has no workspace binding",
    data: { transcript: PLANTED_TRANSCRIPT_LINE, file: PLANTED_FILE_CONTENTS },
  },
  {
    name: "hooks claude",
    status: "ok",
    detail:
      "6 commands pinned to /Users/op/.nvm/node/lib/node_modules/@jentrix/cli/dist/session-host-main.js; the provider's cached copy matches",
    data: { commands: [PLANTED_HOOK_BODY] },
  },
  {
    name: "marketplace codex",
    status: "warn",
    detail:
      'PLUGIN_MARKETPLACE_CONFLICT: Codex marketplace "jentrix" points at /Users/op/forks/mine, which this install did not write',
  },
  {
    name: "contract",
    status: "warn",
    detail:
      "compatible drift: https://tm.example/api/mcp serves 1.1.0 (digest bbbb…), this build adopted 1.0.0 (digest aaaa…)",
    data: {
      adopted: { surface: "mvp", apiRelease: "1.0.0", digest: "aaaa" },
      served: {
        surface: "mvp",
        apiRelease: "1.1.0",
        digest: "bbbb",
        publicationState: "supported",
      },
    },
  },
  { name: "repository", status: "skip", detail: "not a work tree" },
];

describe("doctorBundle — redacted by construction", () => {
  const bundle = doctorBundle(checks, {
    env: { STACKS_TOKEN: PLANTED_ENV_LITERAL, HOME: "/Users/op" },
    homedir: "/Users/op",
    literals: [PLANTED_TOKEN],
    now: new Date("2026-09-03T10:00:00.000Z"),
    node: "v22.0.0",
    os: "darwin",
    arch: "arm64",
  });
  const text = JSON.stringify(bundle);

  it("carries no planted secret, transcript line, hook body or file contents", () => {
    assert.ok(!text.includes(PLANTED_TOKEN), "bearer literal leaked");
    assert.ok(!text.includes(PLANTED_ENV_LITERAL), "env literal leaked");
    assert.ok(
      !text.includes(PLANTED_TRANSCRIPT_LINE),
      "transcript line leaked",
    );
    assert.ok(
      !text.includes("private transcript line"),
      "transcript prose leaked",
    );
    assert.ok(!text.includes(PLANTED_HOOK_BODY), "hook body leaked");
    assert.ok(!text.includes("secret config body"), "file contents leaked");
    assert.ok(!text.includes("/Users/op/"), "home directory leaked");
    assert.ok(
      text.includes("‹redacted›"),
      "the token was dropped rather than marked redacted",
    );
  });

  it("keeps what support needs: names, statuses, redacted details, fixes, the contract's two sides, error categories", () => {
    assert.equal(bundle.kind, "jentrix-doctor-bundle");
    assert.equal(bundle.cli.version, CLI_VERSION);
    assert.deepEqual(bundle.platform, {
      os: "darwin",
      arch: "arm64",
      node: "v22.0.0",
    });
    assert.deepEqual(bundle.summary, { ok: 2, warn: 3, fail: 1, skip: 1 });
    assert.deepEqual(
      bundle.checks.map((c) => [c.name, c.status]),
      checks.map((c) => [c.name, c.status]),
    );
    assert.equal(bundle.checks[1]!.fix, "jentrix login");
    assert.match(bundle.checks[0]!.detail, /^~\/\.nvm\//);
    const contract = bundle.checks.find((c) => c.name === "contract")!;
    assert.deepEqual(contract.data, checks[5]!.data);
    for (const c of bundle.checks) {
      if (c.name !== "contract")
        assert.equal(c.data, undefined, `${c.name} carried data`);
    }
    // Codes, never prose: the leading UPPER_SNAKE code where one exists, a
    // derived NAME_STATUS category otherwise.
    assert.deepEqual(bundle.errorCategories, [
      "CREDENTIAL_FAIL",
      "FOLDER_NOT_ALIGNED",
      "PLUGIN_MARKETPLACE_CONFLICT",
      "CONTRACT_WARN",
    ]);
  });
});

describe("session doctor --bundle", () => {
  function deps(
    overrides: Partial<SessionCommandDeps>,
  ): SessionCommandDeps & { out: string[] } {
    const out: string[] = [];
    const caller: SessionToolCaller = {
      call: async (name: string) => {
        if (name === "get_token_context") {
          return {
            tokenId: "tok_1",
            tokenName: "cli",
            scopes: ["read", "write"],
            storedScopes: ["read", "write"],
            grandfathered: false,
            workspacePinned: false,
            workspaceId: null,
          };
        }
        if (name === "resolve_projects_for_repo") return { projects: [] };
        return {};
      },
    } as unknown as SessionToolCaller;
    return {
      out,
      env: { STACKS_TOKEN: PLANTED_TOKEN },
      cwd: () => "/work/api",
      configPath: "/tmp/config.json",
      resolveTarget: () => ({
        token: PLANTED_TOKEN,
        url: "https://stacks.example/api/mcp",
      }),
      ensureInstallationId: () => "install-1",
      connect: async () => ({ caller, close: async () => undefined }),
      git: async (args) => {
        const key = args.join(" ");
        const table: Record<string, { code: number; stdout: string }> = {
          "rev-parse --show-toplevel": { code: 0, stdout: "/work/api\n" },
          "remote get-url origin": {
            code: 0,
            stdout: "git@github.com:acme/api.git\n",
          },
          "symbolic-ref --short -q HEAD": { code: 0, stdout: "main\n" },
          "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
          "status --porcelain": { code: 0, stdout: "" },
        };
        return table[key] ?? { code: 1, stdout: "" };
      },
      writeOut: (t) => out.push(t),
      writeErr: () => undefined,
      isInteractive: false,
      readLine: async () => "",
      resolveSessionHost: () => "/tools/session-host-main.js",
      runSessionHost: async () => 0,
      spawnSessionHostDetached: () => 1,
      spoolRoot: join(
        mkdtempSync(join(tmpdir(), "jx-doctor-bundle-")),
        "spool",
      ),
      ...overrides,
    };
  }

  it("writes the bundle where asked, owner-only, without the bearer, and names it in both output modes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-doctor-bundle-out-"));
    const file = join(dir, "bundle.json");
    const d = deps({});
    await runSessionDoctor({ bundle: file }, d);
    assert.ok(existsSync(file), "bundle file missing");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text) as { kind: string; checks: unknown[] };
    assert.equal(parsed.kind, "jentrix-doctor-bundle");
    assert.ok(parsed.checks.length > 0);
    assert.ok(!text.includes(PLANTED_TOKEN), "bearer leaked into the bundle");
    assert.match(
      d.out.join("\n"),
      /Support bundle written: .*bundle\.json — redacted/,
    );

    const dj = deps({});
    const json = join(dir, "bundle2.json");
    await runSessionDoctor({ bundle: json, json: true }, dj);
    const line = JSON.parse(dj.out[0]!) as { bundle?: string };
    assert.equal(line.bundle, json);
  });

  it("defaults the file name into the working directory when --bundle has no value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jx-doctor-bundle-cwd-"));
    const d = deps({ cwd: () => dir });
    await runSessionDoctor({ bundle: true }, d);
    const written = d.out.find((l) =>
      l.startsWith("Support bundle written: "),
    )!;
    assert.match(
      written,
      new RegExp(
        `${dir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/jentrix-doctor-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}\\.json`,
      ),
    );
  });
});
