/**
 * M20.1 — `jentrix session`: project confirmation (AC7/AC8), pinned-credential
 * discovery refusal (AC45), trusted hook context for attach (AC17), resume
 * continuity, and exit codes. All deps injected — no sockets, no runner.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { writeFolderBinding } from "../src/binding";
import { EXIT_CODES } from "../src/errors";

import {
  alignmentMarkerPath,
  localConnectionKey,
  readClaudeHookContext,
  resolveProjectForSession,
  runSessionAttach,
  runSessionConnect,
  runSessionDoctor,
  runSessionEnd,
  runSessionStart,
  runSessionStatus,
  sessionCloseVerdict,
  withCaller,
  writeAlignmentMarker,
  type SessionCommandDeps,
  type SessionToolCaller,
} from "../src/commands/session";

/**
 * Client-runtime v2: a checkout FOLDER-BOUND to ws_1 — the workspace scope
 * every v2 session path reads. A real temp dir, because the binding gate
 * reads the filesystem at the git root.
 */
function boundCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "jsess-"));
  writeFolderBinding(root, {
    version: 1,
    endpoint: "https://stacks.example/api/mcp",
    workspaceId: "ws_1",
    workspaceSlug: "acme",
    repoOwnerName: "acme/api",
    alignedAt: "2026-08-29T00:00:00.000Z",
  });
  return root;
}

/** The standard git mock rooted at `root`. */
function gitAt(root: string) {
  return async (args: string[]) => {
    const key = args.join(" ");
    const table: Record<string, { code: number; stdout: string }> = {
      "rev-parse --show-toplevel": { code: 0, stdout: `${root}\n` },
      "remote get-url origin": {
        code: 0,
        stdout: "git@github.com:acme/api.git\n",
      },
      "symbolic-ref --short -q HEAD": { code: 0, stdout: "main\n" },
      "rev-parse HEAD": { code: 0, stdout: "abc123\n" },
      "status --porcelain": { code: 0, stdout: "" },
    };
    return table[key] ?? { code: 1, stdout: "" };
  };
}

const CANDIDATE = {
  id: "proj_1",
  name: "Atlas",
  slug: "atlas",
  workspace: { id: "ws_1", name: "Engineering", slug: "eng" },
  ownerId: "user_1",
  repoMatch: "project_link",
};

function envelope(payload: unknown) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function fakeCaller(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
): SessionToolCaller & {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      const value = handler(args);
      return { structuredContent: value };
    },
  };
}

function deps(
  caller: SessionToolCaller,
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps & { out: string[]; err: string[]; hostPlans: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const hostPlans: string[] = [];
  return {
    out,
    err,
    hostPlans,
    env: {},
    cwd: () => "/work/api",
    configPath: "/tmp/config.json",
    resolveTarget: () => ({
      token: "tm_x",
      url: "https://stacks.example/api/mcp",
    }),
    ensureInstallationId: () => "install-uuid-1",
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
    writeOut: (text) => out.push(text),
    writeErr: (text) => err.push(text),
    isInteractive: true,
    readLine: async () => "y",
    resolveSessionHost: () => "/tools/session-host-main.js",
    runSessionHost: async (_runner, planPath) => {
      hostPlans.push(planPath);
      return 0;
    },
    spawnSessionHostDetached: (_runner, planPath) => {
      hostPlans.push(planPath);
      return 9999;
    },
    spoolRoot: "/tmp/spool",
    ...overrides,
  };
}

test("single repo match is preselected but still confirmed (AC7)", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
  });
  const prompts: string[] = [];
  const result = await resolveProjectForSession(
    caller,
    {
      isInteractive: true,
      readLine: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
    "acme/api",
    undefined,
  );
  assert.equal(result.projectId, "proj_1");
  assert.match(prompts[0]!, /Atlas/);
  assert.match(prompts[0]!, /Engineering/);
});

test("declining the confirmation creates nothing (§8.2)", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
  });
  await assert.rejects(
    resolveProjectForSession(
      caller,
      {
        isInteractive: true,
        readLine: async () => "n",
        writeOut: () => undefined,
        writeErr: () => undefined,
      },
      "acme/api",
      undefined,
    ),
    /no session was created/,
  );
});

test("multiple matches prompt; non-interactive requires --project (AC8)", async () => {
  const second = { ...CANDIDATE, id: "proj_2", name: "Beacon", slug: "beacon" };
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE, second] }),
  });
  const picked = await resolveProjectForSession(
    caller,
    {
      isInteractive: true,
      readLine: async () => "2",
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
    "acme/api",
    undefined,
  );
  assert.equal(picked.projectId, "proj_2");

  await assert.rejects(
    resolveProjectForSession(
      caller,
      {
        isInteractive: false,
        readLine: async () => "",
        writeOut: () => undefined,
        writeErr: () => undefined,
      },
      "acme/api",
      undefined,
    ),
    /PROJECT_REQUIRED: non-interactive/,
  );
});

test("a workspace-pinned credential refuses discovery non-interactively but validates an exact --project (AC45)", async () => {
  const caller: SessionToolCaller = {
    async callTool({ name }) {
      if (name === "resolve_projects_for_repo") {
        return envelope({
          error: {
            code: "FORBIDDEN",
            message:
              "PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN: cross-workspace repository discovery needs an unpinned human credential",
          },
        });
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  await assert.rejects(
    resolveProjectForSession(
      caller,
      {
        isInteractive: false,
        readLine: async () => "y",
        writeOut: () => undefined,
        writeErr: () => undefined,
      },
      "acme/api",
      undefined,
    ),
    /PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN/,
  );
  const withFlag = await resolveProjectForSession(
    caller,
    {
      isInteractive: true,
      readLine: async () => "y",
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
    "acme/api",
    "proj_9",
  );
  assert.equal(withFlag.projectId, "proj_9");
});

test("a pinned credential gets the SAME confirmation picker over the pin's projects, behind a scope banner (AC45 preserved)", async () => {
  // Discovery is still refused server-side; the CLI composes a SCOPED list
  // from list_workspaces + list_projects and says so, instead of dead-ending.
  const pinnedRefusal = () =>
    envelope({
      error: {
        code: "FORBIDDEN",
        message:
          "PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN: cross-workspace repository discovery needs an unpinned human credential",
      },
    });
  const caller: SessionToolCaller = {
    async callTool({ name, arguments: args }) {
      if (name === "resolve_projects_for_repo") return pinnedRefusal();
      if (name === "list_workspaces") {
        return {
          structuredContent: {
            workspaces: [{ id: "ws_pin", name: "Engineering", slug: "eng" }],
          },
        };
      }
      if (name === "list_projects") {
        assert.equal((args as { workspaceId?: string }).workspaceId, "ws_pin");
        return {
          structuredContent: {
            projects: [
              { id: "proj_a", name: "Atlas", slug: "atlas" },
              { id: "proj_b", name: "Beacon", slug: "beacon" },
            ],
          },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const out: string[] = [];
  const picked = await resolveProjectForSession(
    caller,
    {
      isInteractive: true,
      readLine: async () => "2",
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
    },
    "acme/api",
    undefined,
  );
  assert.equal(picked.projectId, "proj_b");
  const banner = out.join("\n");
  // The scope banner names the pinned workspace and states that other
  // workspaces were NOT searched — a scoped answer must never read as
  // "no other project uses this repo".
  assert.match(banner, /Engineering/);
  assert.match(banner, /not searched/i);

  // A single project in the pin is preselected but still confirmed (AC7).
  const single: SessionToolCaller = {
    async callTool({ name }) {
      if (name === "resolve_projects_for_repo") return pinnedRefusal();
      if (name === "list_workspaces") {
        return {
          structuredContent: {
            workspaces: [{ id: "ws_pin", name: "Engineering", slug: "eng" }],
          },
        };
      }
      if (name === "list_projects") {
        return {
          structuredContent: {
            projects: [{ id: "proj_a", name: "Atlas", slug: "atlas" }],
          },
        };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const prompts: string[] = [];
  const confirmed = await resolveProjectForSession(
    single,
    {
      isInteractive: true,
      readLine: async (prompt) => {
        prompts.push(prompt);
        return "";
      },
      writeOut: () => undefined,
      writeErr: () => undefined,
    },
    "acme/api",
    undefined,
  );
  assert.equal(confirmed.projectId, "proj_a");
  assert.match(prompts[0]!, /Atlas/);
});

test("start creates the session BEFORE launching the host with a transient plan file (AC11, v2 workspace shape)", async () => {
  const root = boundCheckout();
  const caller = fakeCaller({
    create_agent_session: (args) => {
      // Client-runtime v2 §16.1: workspace scope from the folder binding —
      // no Project, no repo-link gate.
      assert.equal(args.workspaceId, "ws_1");
      assert.equal(args.projectId, undefined);
      assert.equal(args.repoOwnerName, "acme/api");
      assert.match(String(args.idempotencyKey), /^launch:/);
      return {
        id: "ses_1",
        workspaceId: "ws_1",
        projectId: null,
        status: "STARTING",
      };
    },
  });
  const d = deps(caller, {
    // Plan file lands in the spool root; use a real temp dir for the write.
    spoolRoot: process.env.TMPDIR ?? "/tmp",
    cwd: () => root,
    git: gitAt(root),
  });
  const code = await runSessionStart("claude", {}, d);
  assert.equal(code, 0);
  assert.equal(d.hostPlans.length, 1);
  assert.match(d.out.join("\n"), /Jentrix session ses_1/);
  assert.match(d.out.join("\n"), /workspace acme/);
  const order = caller.calls.map((c) => c.name);
  assert.deepEqual(order, ["create_agent_session"]);
});

test("start without a folder binding fails closed naming the fix (FOLDER_NOT_ALIGNED)", async () => {
  const root = mkdtempSync(join(tmpdir(), "jsess-unbound-"));
  const caller = fakeCaller({});
  const d = deps(caller, { cwd: () => root, git: gitAt(root) });
  const code = await runSessionStart("claude", {}, d);
  assert.notEqual(code, 0);
  assert.match(d.err.join("\n"), /FOLDER_NOT_ALIGNED/);
  assert.match(d.err.join("\n"), /jentrix folder align/);
});

test("attach without trusted provider context is refused, never guessed (AC17/§15.2)", async () => {
  const caller = fakeCaller({});
  const d = deps(caller, { env: {} });
  const code = await runSessionAttach({ provider: "codex" }, d);
  assert.equal(code, 2);
  // err[0] is the D16 rename notice (attach → connect); the refusal follows.
  assert.match(d.err[0]!, /session connect/);
  assert.match(d.err.join("\n"), /PROVIDER_SESSION_UNAVAILABLE/);
  assert.match(d.err.join("\n"), /jentrix session codex/);
});

test("attach uses the plugin's hook-recorded context for the current checkout (AC17)", () => {
  const now = Date.parse("2026-08-11T02:46:00.000Z");
  const hookLines = [
    JSON.stringify({
      event: "SessionStart",
      at: new Date(now - 120_000).toISOString(),
      payload: {
        session_id: "claude_ses_old",
        transcript_path: "/t/old.jsonl",
        cwd: "/elsewhere",
      },
    }),
    JSON.stringify({
      event: "SessionStart",
      at: new Date(now - 60_000).toISOString(),
      payload: {
        session_id: "claude_ses_1",
        transcript_path: "/t/1.jsonl",
        cwd: "/work/api",
      },
    }),
    "not json",
  ].join("\n");
  const context = readClaudeHookContext(
    { env: { HOME: "/home/op" }, cwd: () => "/work/api/src" },
    () => hookLines,
    () => now,
    () => now,
  );
  assert.equal(context?.sessionId, "claude_ses_1");
  assert.equal(context?.transcriptPath, "/t/1.jsonl");
  // `/elsewhere` is newer than nothing here — it is OLDER than the winner, so
  // it is not the F1 ambiguity signal.
  assert.equal(context?.newerElsewhere, null);
  assert.equal(
    readClaudeHookContext(
      { env: {}, cwd: () => "/work/api" },
      () => hookLines,
      () => now,
      () => now,
    ),
    null,
  );
});

test("two live sessions in ONE checkout each resolve themselves, not the newest", () => {
  // The reported failure: cwd containment cannot separate concurrent Claude
  // Code sessions in one folder, so both resolved to whichever started last —
  // the second align re-aligned the first session and both sessions' pushes
  // landed on one. Claude Code stamps its id on every command it runs, so the
  // asking session names itself.
  const now = Date.parse("2026-08-13T09:00:00.000Z");
  const hookLines = [
    { session_id: "ses_first", transcript_path: "/t/first.jsonl", at: 120_000 },
    {
      session_id: "ses_second",
      transcript_path: "/t/second.jsonl",
      at: 60_000,
    },
  ]
    .map((r) =>
      JSON.stringify({
        event: "SessionStart",
        at: new Date(now - r.at).toISOString(),
        payload: {
          session_id: r.session_id,
          transcript_path: r.transcript_path,
          cwd: "/work/api",
        },
      }),
    )
    .join("\n");
  const resolve = (env: Record<string, string | undefined>) =>
    readClaudeHookContext(
      { env: { HOME: "/home/op", ...env }, cwd: () => "/work/api" },
      () => hookLines,
      () => now,
      () => now,
    );

  const first = resolve({ CLAUDE_CODE_SESSION_ID: "ses_first" });
  assert.equal(first?.sessionId, "ses_first");
  assert.equal(first?.transcriptPath, "/t/first.jsonl", "its OWN transcript");
  assert.equal(first?.newerElsewhere, null, "no ambiguity to disclose");
  assert.equal(
    resolve({ CLAUDE_CODE_SESSION_ID: "ses_second" })?.sessionId,
    "ses_second",
  );

  // Identity survives a missing hook record; only the transcript is lost.
  const unhooked = resolve({ CLAUDE_CODE_SESSION_ID: "ses_never_hooked" });
  assert.equal(unhooked?.sessionId, "ses_never_hooked");
  assert.equal(unhooked?.transcriptPath, null);
  assert.match(unhooked!.basis, /no hook record names a transcript/);

  // Without the env var the ledger inference stands (a plain shell).
  assert.equal(resolve({})?.sessionId, "ses_second");
});

test("connect binds the trusted provider session and converges idempotently (AC44, v2 workspace shape)", async () => {
  const root = boundCheckout();
  const caller = fakeCaller({
    attach_agent_session: (args) => {
      assert.equal(args.providerSessionId, "thread_7");
      // v2 (§16.2): the folder's workspace scopes the attach — no Project.
      assert.equal(args.workspaceId, "ws_1");
      assert.equal(args.projectId, undefined);
      // AGE-961: a per-invocation NONCE, never a stable key — a stable key
      // froze the first target for its 24h TTL (CONFLICT on same-target
      // replay after a commit and on re-target after `session end`). The
      // server's convergence on the provider thread is the idempotency.
      assert.match(
        String(args.idempotencyKey),
        /^attach:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      return {
        id: "ses_2",
        workspaceId: "ws_1",
        projectId: null,
        status: "ACTIVE",
        converged: true,
      };
    },
  });
  const d = deps(caller, { cwd: () => root, git: gitAt(root) });
  const code = await runSessionConnect(
    { provider: "codex", providerSession: "thread_7" },
    d,
  );
  assert.equal(code, 0);
  assert.match(d.out.join("\n"), /Reconnected to Jentrix session ses_2/);
  assert.match(d.out.join("\n"), /workspace acme/);
});

test("PROJECT_REPO_MISMATCH is self-service: offer to add the REPO link, then retry", async () => {
  let createCalls = 0;
  const linkArgs: Array<Record<string, unknown>> = [];
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    add_project_link: (args) => {
      linkArgs.push(args);
      return { ok: true };
    },
    create_agent_session: () => {
      createCalls += 1;
      if (createCalls === 1) {
        throw new Error(
          "PROJECT_REPO_MISMATCH: project proj_1 does not link repository acme/api. Ask a workspace admin to add the repo link (project settings → Linked items), then retry.",
        );
      }
      return {
        id: "ses_9",
        workspaceId: "ws_1",
        projectId: "proj_1",
        status: "STARTING",
      };
    },
  });
  // The repo-link offer is the LEGACY --project path's flow (the v2 shape has
  // no repo gate at all). Every prompt (project confirm, link offer) → "y".
  const d = deps(caller, {
    spoolRoot: process.env.TMPDIR ?? "/tmp",
  });
  const code = await runSessionStart("claude", { project: "proj_1" }, d);
  assert.equal(code, 0);
  assert.equal(createCalls, 2);
  assert.deepEqual(linkArgs, [
    { projectId: "proj_1", targetType: "REPO", targetId: "acme/api" },
  ]);

  // Non-interactive: no prompt — print the exact command instead.
  const nonInteractive = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [] }),
    create_agent_session: () => {
      throw new Error(
        "PROJECT_REPO_MISMATCH: project proj_1 does not link repository acme/api. Ask a workspace admin to add the repo link (project settings → Linked items), then retry.",
      );
    },
  });
  const d2 = deps(nonInteractive, { isInteractive: false });
  const code2 = await runSessionStart("claude", { project: "proj_1" }, d2);
  assert.notEqual(code2, 0);
  assert.match(d2.err.join("\n"), /add_project_link/);
  assert.match(d2.err.join("\n"), /"targetId":"acme\/api"/);
});

test("status: a healthy live session never reads as a capture warning (M20.1 UX)", async () => {
  // captureComplete === false is the NORMAL state of an open session — the
  // flag only means "not finalized yet". Only a TERMINAL session with
  // captureComplete=false is capture debt.
  const caller = fakeCaller({
    list_workspaces: () => ({ workspaces: [{ id: "ws_1" }] }),
    list_agent_sessions: () => ({
      sessions: [
        {
          id: "ses_live",
          provider: "claude",
          projectName: "Atlas",
          status: "ACTIVE",
          captureComplete: false,
        },
      ],
    }),
  });
  const d = deps(caller);
  assert.equal(await runSessionStatus(undefined, {}, d), 0);
  const listing = d.out.join("\n");
  assert.ok(
    !/capture pending|INCOMPLETE/i.test(listing),
    `live session listing must not warn: ${listing}`,
  );

  const detailCaller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_live",
      provider: "claude",
      status: "ACTIVE",
      projectName: "Atlas",
      projectId: "proj_1",
      repoOwnerName: "acme/api",
      captureComplete: false,
      captureError: null,
      summaryArtifactId: null,
    }),
  });
  const d2 = deps(detailCaller);
  assert.equal(await runSessionStatus("ses_live", {}, d2), 0);
  const detail = d2.out.join("\n");
  assert.match(detail, /recording/i);
  assert.ok(
    !/INCOMPLETE/.test(detail),
    `open-session detail must not read as a warning: ${detail}`,
  );

  const closedCaller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_done",
      provider: "claude",
      status: "COMPLETED",
      projectName: "Atlas",
      projectId: "proj_1",
      repoOwnerName: "acme/api",
      captureComplete: false,
      captureError: "unacknowledged trace parts: missing [2]",
      summaryArtifactId: null,
    }),
  });
  const d3 = deps(closedCaller);
  assert.equal(await runSessionStatus("ses_done", {}, d3), 0);
  assert.match(d3.out.join("\n"), /INCOMPLETE/);
});

test("status: an open LOCALLY-BOUND session with zero capture footprint is LOUD (F-3/AGE-931)", async () => {
  // The E2E shape: this machine attached the session (connection key matches
  // operator+installation), the server says ACTIVE, and the spool holds
  // NOTHING — no host.json, no parts, no session dir. "No spool → nothing to
  // report" is correct for a session captured elsewhere and a lie here.
  const spool = mkdtempSync(join(tmpdir(), "stacks-f3-"));
  const key = localConnectionKey("user_1", "install-uuid-1");
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_f3",
      provider: "claude",
      status: "ACTIVE",
      projectName: "HTML Report",
      projectId: "proj_1",
      repoOwnerName: "acme/api",
      captureComplete: false,
      captureError: null,
      summaryArtifactId: null,
      operator: { id: "user_1", name: "A", email: "a@example.com" },
      providerConnectionId: key,
    }),
  });
  const d = deps(caller, { spoolRoot: spool });
  assert.equal(await runSessionStatus("ses_f3", {}, d), 0);
  const detail = d.out.join("\n");
  assert.match(detail, /NOT RUNNING/, "the dead local leg must be loud");
  assert.doesNotMatch(
    detail,
    /recording \(finalizes/,
    "the server line must not contradict the local truth",
  );

  // The SAME empty spool for a session bound on ANOTHER machine stays quiet.
  const remoteCaller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_remote",
      provider: "claude",
      status: "ACTIVE",
      projectName: "HTML Report",
      projectId: "proj_1",
      repoOwnerName: "acme/api",
      captureComplete: false,
      captureError: null,
      summaryArtifactId: null,
      operator: { id: "user_1", name: "A", email: "a@example.com" },
      providerConnectionId: localConnectionKey("user_1", "some-other-machine"),
    }),
  });
  const d2 = deps(remoteCaller, { spoolRoot: spool });
  assert.equal(await runSessionStatus("ses_remote", {}, d2), 0);
  const remoteDetail = d2.out.join("\n");
  assert.match(remoteDetail, /recording \(finalizes/);
  assert.doesNotMatch(remoteDetail, /NOT RUNNING/);
});

test("launch creates spoolRoot when it does not exist (AGE-929)", async () => {
  // The runner's SessionSpool mkdirs only its per-session subdirectory, and
  // only after the plan file is written — so on a machine that has never
  // launched a session every launch died on ENOENT.
  const spoolRoot = join(
    mkdtempSync(join(tmpdir(), "stacks-spool-")),
    "never-created",
  );
  assert.equal(existsSync(spoolRoot), false);

  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_3",
      provider: "claude",
      providerSessionId: "claude_thread",
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-06T10:00:00.000Z",
    }),
    resume_agent_session: () => ({
      id: "ses_3",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "ACTIVE",
    }),
  });

  // launchHost unlinks the plan on the way out, so prove it existed while the
  // host was running — that is the write the bug killed.
  let planExistedDuringHost = false;
  const d = deps(caller, {
    spoolRoot,
    runSessionHost: async (_runner, planPath) => {
      planExistedDuringHost = existsSync(planPath);
      assert.equal(dirname(planPath), spoolRoot);
      return 0;
    },
  });

  const code = await runSessionStart("claude", { resume: "ses_3" }, d);
  assert.equal(code, 0, d.err.join("\n"));
  assert.equal(planExistedDuringHost, true);
  assert.equal(existsSync(spoolRoot), true);
});

test("launchHost creates the spool root — no hand-run mkdir (AGE-929 setup gap)", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    create_agent_session: () => ({
      id: "ses_mk",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "STARTING",
    }),
    get_agent_session: () => ({ id: "ses_mk", status: "COMPLETED" }),
  });
  const freshRoot = join(
    mkdtempSync(join(tmpdir(), "stacks-cli-test-")),
    "nested",
    "session-spool",
  );
  const root = boundCheckout();
  const d = deps(caller, {
    spoolRoot: freshRoot,
    cwd: () => root,
    git: gitAt(root),
  });
  const code = await runSessionStart("claude", {}, d);
  assert.equal(code, 0);
  assert.equal(d.hostPlans.length, 1);
});

test("a nonzero host exit with a still-open server session warns BOUND BUT NOT RECORDING (AGE-929)", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    create_agent_session: () => ({
      id: "ses_dead",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "STARTING",
    }),
    get_agent_session: () => ({
      id: "ses_dead",
      status: "ACTIVE",
      provider: "claude",
    }),
  });
  const root = boundCheckout();
  const d = deps(caller, {
    spoolRoot: process.env.TMPDIR ?? "/tmp",
    runSessionHost: async () => 3,
    cwd: () => root,
    git: gitAt(root),
  });
  const code = await runSessionStart("claude", {}, d);
  assert.equal(code, 3);
  const err = d.err.join("\n");
  assert.match(err, /BOUND BUT NOT RECORDING/);
  assert.match(err, /jentrix session end ses_dead/);

  // A terminal server session after a nonzero exit needs NO warning — the
  // close was recorded; the exit code already reports the capture debt.
  const closed = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    create_agent_session: () => ({
      id: "ses_ok",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "STARTING",
    }),
    get_agent_session: () => ({ id: "ses_ok", status: "COMPLETED" }),
  });
  const root2 = boundCheckout();
  const d2 = deps(closed, {
    spoolRoot: process.env.TMPDIR ?? "/tmp",
    runSessionHost: async () => 1,
    cwd: () => root2,
    git: gitAt(root2),
  });
  const code2 = await runSessionStart("claude", {}, d2);
  assert.equal(code2, 1);
  assert.ok(!/BOUND BUT NOT RECORDING/.test(d2.err.join("\n")));
});

test("status reports LOCAL capture liveness: dead host + stale spool are visible immediately", async () => {
  const spoolRoot = mkdtempSync(join(tmpdir(), "stacks-cli-spool-"));
  const sessionDir = join(spoolRoot, "ses_live");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "host.json"),
    JSON.stringify({
      pid: 4242,
      startedAt: "2026-08-07T00:00:00.000Z",
      provider: "claude",
      mode: "launch",
    }),
  );
  writeFileSync(join(sessionDir, "part-000000.ndjson"), '{"kind":"session"}\n');

  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_live",
      provider: "claude",
      status: "ACTIVE",
      projectName: "Atlas",
      projectId: "proj_1",
      repoOwnerName: "acme/api",
      captureComplete: false,
      captureError: null,
      summaryArtifactId: null,
    }),
  });
  const d = deps(caller, { spoolRoot, isPidAlive: () => false });
  assert.equal(await runSessionStatus("ses_live", {}, d), 0);
  const detail = d.out.join("\n");
  assert.match(detail, /HOST NOT RUNNING/);
  assert.match(detail, /nothing is recording locally/);
  assert.match(detail, /spool last grew/i);

  // Same session with the host alive reads as healthy local capture.
  const d2 = deps(caller, { spoolRoot, isPidAlive: () => true });
  assert.equal(await runSessionStatus("ses_live", {}, d2), 0);
  assert.match(d2.out.join("\n"), /host running \(pid 4242\)/i);
});

test("doctor reports EVERY failure at once instead of one per round trip (Slice 6)", async () => {
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read"], // missing the write scope a session needs
      storedScopes: ["read"],
      grandfathered: false,
      workspacePinned: false,
      workspaceId: null,
    }),
    resolve_projects_for_repo: () => ({ projects: [] }),
  });
  const d = deps(caller, {
    resolveSessionHost: () => null, // bundled host missing
    // repo checkout has no usable origin remote
    git: async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse --show-toplevel")
        return { code: 0, stdout: "/work/api\n" };
      if (key === "remote get-url origin") return { code: 1, stdout: "" };
      if (key === "rev-parse HEAD") return { code: 0, stdout: "abc\n" };
      if (key === "symbolic-ref --short -q HEAD")
        return { code: 0, stdout: "main\n" };
      if (key === "status --porcelain") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    },
    spoolRoot: join(mkdtempSync(join(tmpdir(), "stacks-doctor-")), "spool"),
  });
  const code = await runSessionDoctor({}, d);
  assert.equal(code, 1);
  const out = d.out.join("\n");
  // BOTH independent failures surface in the ONE run — no serial dead ends.
  assert.match(out, /session host/i);
  assert.match(out, /SESSION_HOST_MISSING/);
  assert.match(out, /credential/i);
  assert.match(out, /write scope/i);
  // A checkout without an origin remote is NOT one of them: it reports ok
  // under its directory-derived identity, and says so.
  assert.match(out, /local\/api/);
  assert.match(out, /identified by its directory name/i);
  // The passing checks still report.
  assert.match(out, /spool/i);
});

test("doctor passes end to end and warns (not fails) on a missing explicit repo link", async () => {
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write"],
      storedScopes: ["read", "write"],
      grandfathered: false,
      workspacePinned: true,
      workspaceId: "ws_1",
    }),
    get_project: () => ({
      id: "proj_1",
      name: "Atlas",
      workspaceId: "ws_1",
      links: [{ id: "l1", targetType: "DOC", targetId: "https://doc" }],
    }),
  });
  const d = deps(caller, {
    spoolRoot: join(mkdtempSync(join(tmpdir(), "stacks-doctor2-")), "spool"),
  });
  const code = await runSessionDoctor({ project: "proj_1" }, d);
  assert.equal(code, 0);
  const out = d.out.join("\n");
  assert.match(out, /no explicit REPO link/i);
  assert.match(out, /add_project_link/);
  // AGE-951: the board precondition surfaces in the SAME pass as the repo one
  // (it used to appear only after the repo blocker cleared), and stays a warn
  // because align now self-provisions a board for a new task.
  assert.match(out, /links no board/i);
  assert.match(out, /auto-provision/i);
});

test("doctor reports the board link ok when the project links one", async () => {
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write"],
      storedScopes: ["read", "write"],
      grandfathered: false,
      workspacePinned: true,
      workspaceId: "ws_1",
    }),
    get_project: () => ({
      id: "proj_1",
      name: "Atlas",
      workspaceId: "ws_1",
      links: [
        { id: "l1", targetType: "REPO", targetId: "acme/api" },
        { id: "l2", targetType: "BOARD", targetId: "board_1" },
      ],
    }),
  });
  const d = deps(caller, {
    spoolRoot: join(mkdtempSync(join(tmpdir(), "stacks-doctor5-")), "spool"),
  });
  const code = await runSessionDoctor({ project: "proj_1" }, d);
  assert.equal(code, 0);
  const out = d.out.join("\n");
  assert.match(out, /links 1 board/);
});

test("doctor --project resolves a SLUG on an unpinned token (STA-60)", async () => {
  // `--project` is documented `<id-or-slug>`. The by-slug retry used to run
  // only for a workspace-PINNED credential, so an ordinary unpinned token got
  // a bare "Project not found" for the documented form.
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write"],
      storedScopes: ["read", "write"],
      grandfathered: false,
      workspacePinned: false,
      workspaceId: null,
    }),
    list_workspaces: () => ({
      workspaces: [{ id: "ws_other" }, { id: "ws_1" }],
    }),
    get_project: (args) => {
      if (args.projectId) throw new Error("Project not found");
      // A slug is unique only WITHIN a workspace — the first one misses.
      if (args.workspaceId !== "ws_1") throw new Error("Project not found");
      return {
        id: "proj_1",
        name: "Atlas",
        workspaceId: "ws_1",
        links: [
          { id: "l1", targetType: "REPO", targetId: "acme/api" },
          { id: "l2", targetType: "BOARD", targetId: "board_1" },
        ],
      };
    },
  });
  const d = deps(caller, {
    spoolRoot: join(
      mkdtempSync(join(tmpdir(), "stacks-doctor-slug-")),
      "spool",
    ),
  });
  const code = await runSessionDoctor({ project: "atlas" }, d);
  assert.equal(code, 0);
  assert.match(d.out.join("\n"), /Atlas \(proj_1\)/);
});

test("doctor --project keeps the by-id error when NO workspace holds the slug (STA-60)", async () => {
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write"],
      storedScopes: ["read", "write"],
      grandfathered: false,
      workspacePinned: false,
      workspaceId: null,
    }),
    list_workspaces: () => ({ workspaces: [{ id: "ws_1" }] }),
    get_project: () => {
      throw new Error("Project not found");
    },
  });
  const d = deps(caller, {
    spoolRoot: join(
      mkdtempSync(join(tmpdir(), "stacks-doctor-slug2-")),
      "spool",
    ),
  });
  const code = await runSessionDoctor({ project: "nope" }, d);
  // Still a blocker, and still exits NON-ZERO — the exit code has always
  // tracked the verdict (`ok:false` ⇒ 1); the TPM round's "exits 0" note was
  // a shell capture artifact, and this pins the real behavior.
  assert.equal(code, 1);
  assert.match(d.out.join("\n"), /did not resolve/i);
});

test("withCaller hands REST legs the token re-read AFTER connect (expired-OAuth one-shot)", async () => {
  // connect performs the C4.2 refresh and PERSISTS the rotated pair; the
  // target it was handed still holds the expired token. A flow that mixes MCP
  // with raw fetch used to bearer the stale one and fail once with
  // STACKS_LOGIN_REQUIRED, then "work" on the next invocation.
  const caller = fakeCaller({ list_workspaces: () => ({ workspaces: [] }) });
  let refreshed = false;
  const d = deps(caller, {
    resolveTarget: () => ({
      token: refreshed ? "tmo_fresh" : "tmo_expired",
      url: "https://stacks.example/api/mcp",
    }),
    connect: async () => {
      refreshed = true; // what connectJentrixClientWithRefresh does to the file
      return { caller, close: async () => undefined };
    },
  });
  const seen = await withCaller(d, async (_caller, target) => target.token);
  assert.equal(seen, "tmo_fresh");
});

test("doctor --project FAILS when discovery disowns the project — never 'Ready' before a refused attach (AGE-936)", async () => {
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write"],
      storedScopes: ["read", "write"],
      grandfathered: false,
      workspacePinned: false,
      workspaceId: null,
    }),
    get_project: () => ({
      id: "proj_1",
      name: "Atlas",
      workspaceId: "ws_1",
      links: [{ id: "l1", targetType: "DOC", targetId: "https://doc" }],
    }),
    // The server's own matching does NOT map acme/api to proj_1 — the attach
    // gate will refuse fail-closed, so doctor must predict that, not hedge.
    resolve_projects_for_repo: () => ({
      projects: [
        {
          id: "proj_2",
          slug: "other",
          name: "Other",
          workspace: { id: "ws_2", slug: "w2", name: "W2" },
          repoMatch: "project link",
        },
      ],
    }),
  });
  const d = deps(caller, {
    spoolRoot: join(mkdtempSync(join(tmpdir(), "stacks-doctor4-")), "spool"),
  });
  const code = await runSessionDoctor({ project: "proj_1" }, d);
  assert.equal(code, 1);
  const out = d.out.join("\n");
  assert.match(out, /PROJECT_REPO_MISMATCH/);
  assert.match(out, /will refuse/i);
  assert.match(out, /jentrix tool add_project_link --args/);
  assert.match(out, /"projectId":"proj_1"/);
  assert.match(out, /"targetId":"acme\/api"/);

  // And the converse: discovery matching the project PROVES the gate — ok, 0.
  const matched = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write"],
      storedScopes: ["read", "write"],
      grandfathered: false,
      workspacePinned: false,
      workspaceId: null,
    }),
    get_project: () => ({
      id: "proj_1",
      name: "Atlas",
      workspaceId: "ws_1",
      links: [],
    }),
    resolve_projects_for_repo: () => ({
      projects: [
        {
          id: "proj_1",
          slug: "atlas",
          name: "Atlas",
          workspace: { id: "ws_1", slug: "w1", name: "W1" },
          repoMatch: "board github sync",
        },
      ],
    }),
  });
  const d2 = deps(matched, {
    spoolRoot: join(mkdtempSync(join(tmpdir(), "stacks-doctor5-")), "spool"),
  });
  assert.equal(await runSessionDoctor({ project: "proj_1" }, d2), 0);
  assert.match(d2.out.join("\n"), /matched by repository discovery/i);
});

test("doctor v2: an unbound folder is THE blocker; a project-less repo is informational (never PROJECT_REQUIRED)", async () => {
  const caller = fakeCaller({
    get_token_context: () => ({
      tokenId: "tok_1",
      tokenName: "cli",
      scopes: ["read", "write", "admin"],
      storedScopes: ["read", "write", "admin"],
      grandfathered: false,
      workspacePinned: false,
      workspaceId: null,
    }),
    resolve_projects_for_repo: () => ({ projects: [] }),
  });
  const d = deps(caller, {
    spoolRoot: join(mkdtempSync(join(tmpdir(), "stacks-doctor3-")), "spool"),
  });
  const code = await runSessionDoctor({}, d);
  // Exit 1 comes from the missing FOLDER BINDING — the v2 first-run state —
  // never from the repo having no Project.
  assert.equal(code, 1);
  const out = d.out.join("\n");
  assert.match(out, /FOLDER_NOT_ALIGNED/);
  assert.match(out, /jentrix folder align --workspace/);
  assert.doesNotMatch(out, /PROJECT_REQUIRED/);
  assert.match(out, /optional in v2/i);
  assert.match(out, /task project add/);
});

test("GOAL: pinned credential + project with no REPO link reaches a bound, capturing session through prompts alone", async () => {
  // The end-to-end objective scenario: workspace-pinned credential, a
  // --project that does NOT link the checkout repo, `session attach
  // --provider claude --project <id> --watch`. Must succeed via prompts only —
  // no UI visit (the repo link is added through add_project_link on a prompt)
  // and no hand-run mkdir (the spool root does not exist yet).
  let linked = false;
  const attachAttempts: number[] = [];
  const caller = fakeCaller({
    resolve_projects_for_repo: () => {
      throw new Error(
        "PROJECT_DISCOVERY_REQUIRES_UNPINNED_LOGIN: cross-workspace repository discovery needs an unpinned human credential",
      );
    },
    add_project_link: (args) => {
      assert.deepEqual(args, {
        projectId: "proj_pin",
        targetType: "REPO",
        targetId: "acme/api",
      });
      linked = true;
      return { ok: true };
    },
    attach_agent_session: () => {
      attachAttempts.push(Date.now());
      if (!linked) {
        throw new Error(
          "PROJECT_REPO_MISMATCH: project proj_pin does not link repository acme/api. Ask a workspace admin to add the repo link (project settings → Linked items), then retry.",
        );
      }
      return {
        id: "ses_goal",
        workspaceId: "ws_pin",
        projectId: "proj_pin",
        status: "ACTIVE",
        converged: false,
      };
    },
    get_agent_session: () => ({ id: "ses_goal", status: "COMPLETED" }),
  });
  const freshSpool = join(
    mkdtempSync(join(tmpdir(), "stacks-goal-")),
    "never-created",
    "session-spool",
  );
  const d = deps(caller, {
    spoolRoot: freshSpool,
    readLine: async () => "y", // the only operator input: accept the link offer
  });
  const code = await runSessionAttach(
    {
      provider: "claude",
      providerSession: "claude_thread_goal",
      project: "proj_pin",
      transcriptPath: "/t/goal.jsonl",
      watch: true,
    },
    d,
  );
  assert.equal(code, 0);
  assert.equal(linked, true, "the REPO link was added via the prompt");
  assert.equal(attachAttempts.length, 2, "mismatch then retry, one round");
  assert.equal(
    d.hostPlans.length,
    1,
    "the capture host launched (bound + capturing)",
  );
  assert.match(d.out.join("\n"), /Connected Jentrix session ses_goal/);
});

test("attach without --watch starts a DETACHED capture host (F-4/AGE-930: capture must actually run)", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    attach_agent_session: () => ({
      id: "ses_d1",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "ACTIVE",
      converged: false,
    }),
  });
  const spool = mkdtempSync(join(tmpdir(), "stacks-detach-"));
  const root = boundCheckout();
  const spawned: Array<{ planPath: string; logPath: string }> = [];
  const d = deps(caller, {
    env: { HOME: "/home/test" },
    spoolRoot: spool,
    cwd: () => root,
    git: gitAt(root),
    spawnSessionHostDetached: (_runner, planPath, logPath) => {
      spawned.push({ planPath, logPath });
      return 4242;
    },
  });
  const code = await runSessionAttach(
    {
      provider: "claude",
      providerSession: "cc-detach",
      transcriptPath: "/t/detach.jsonl",
    },
    d,
  );
  assert.equal(code, 0);
  assert.equal(spawned.length, 1, "a background host was spawned");
  const plan = JSON.parse(readFileSync(spawned[0]!.planPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(plan.mode, "watch");
  assert.equal(plan.transcriptPath, "/t/detach.jsonl");
  assert.equal(plan.sessionId, "ses_d1");
  // JEN-295: the Claude host gets the plugin ledger too — without it the
  // watch host could never see its own session's SessionEnd and ran forever.
  assert.equal(plan.hookDir, "/home/test/.config/stacks/claude-sessions");
  assert.equal(plan.providerSessionId, "cc-detach");
  assert.equal(
    plan.importHistory,
    false,
    "capture begins at attachment by default — history is opt-in",
  );
  assert.equal(spawned[0]!.logPath, join(spool, "ses_d1", "host.log"));
  assert.match(d.out.join("\n"), /pid 4242/);
  assert.doesNotMatch(
    d.err.join("\n"),
    /NOT RECORDING/,
    "a running host is not a warning",
  );

  // --import-history reaches the host plan verbatim.
  const d2 = deps(caller, {
    spoolRoot: spool,
    cwd: () => root,
    git: gitAt(root),
    spawnSessionHostDetached: (_runner, planPath, logPath) => {
      spawned.push({ planPath, logPath });
      return 4243;
    },
  });
  assert.equal(
    await runSessionAttach(
      {
        provider: "claude",
        providerSession: "cc-detach",
        transcriptPath: "/t/detach.jsonl",
        importHistory: true,
      },
      d2,
    ),
    0,
  );
  const importPlan = JSON.parse(
    readFileSync(spawned[1]!.planPath, "utf8"),
  ) as Record<string, unknown>;
  assert.equal(importPlan.importHistory, true);
});

test("Codex attach starts one hook host and reuses it on convergence", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    attach_agent_session: () => ({
      id: "ses_codex_attach",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "ACTIVE",
      converged: false,
    }),
  });
  const spool = mkdtempSync(join(tmpdir(), "stacks-codex-attach-"));
  const spawned: string[] = [];
  const d = deps(caller, {
    // Explicit --provider-session wins before conflicting environment ids.
    env: {
      HOME: "/home/test",
      CODEX_THREAD_ID: "foreign-a",
      CODEX_SESSION_ID: "foreign-b",
    },
    spoolRoot: spool,
    isPidAlive: (pid) => pid === 4242,
    spawnSessionHostDetached: (_runner, planPath) => {
      spawned.push(planPath);
      const dir = join(spool, "ses_codex_attach");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "host.json"),
        JSON.stringify({
          pid: 4242,
          startedAt: new Date().toISOString(),
          provider: "codex",
          mode: "watch",
        }),
      );
      return 4242;
    },
  });
  const flags = {
    provider: "codex" as const,
    providerSession: "thread-1",
    project: "proj_1",
  };
  assert.equal(await runSessionAttach({ ...flags }, d), 0);
  assert.equal(await runSessionAttach({ ...flags }, d), 0);
  assert.equal(spawned.length, 1, "a converged attach reuses the live host");
  const plan = JSON.parse(readFileSync(spawned[0]!, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(plan.provider, "codex");
  assert.equal(plan.providerSessionId, "thread-1");
  assert.equal(plan.hookDir, "/home/test/.config/stacks/codex-sessions");
  assert.match(d.out.join("\n"), /no second host started/);
});

test("D18: no bearer bytes ever land in a host plan or the spool — the credential rides config reference or child env", async () => {
  // The plan file used to carry the bearer in plaintext (F2 — 0600 +
  // unlink-on-read was the only backstop). v2: a config-file token rides as
  // `configPath` (the host follows rotations, AGE-934's fix subsumed); an
  // env/flag token rides the CHILD ENVIRONMENT; the plan itself never holds
  // a secret. This is the packed no-bearer grep test.
  const TOKEN = "tmo_secret_token_bytes_0123456789";
  const caller = fakeCaller({
    attach_agent_session: () => ({
      id: "ses_rf",
      workspaceId: "ws_1",
      projectId: null,
      status: "ACTIVE",
      converged: false,
    }),
    get_agent_session: () => ({ id: "ses_rf", status: "ACTIVE" }),
  });
  const spool = mkdtempSync(join(tmpdir(), "stacks-d18-"));
  const root = boundCheckout();
  const spawned: Array<{ planPath: string; env?: Record<string, string> }> = [];
  const d = deps(caller, {
    spoolRoot: spool,
    cwd: () => root,
    git: gitAt(root),
    resolveTarget: () => ({
      token: TOKEN,
      url: "https://stacks.example/api/mcp",
      tokenSource: "env", // a STACKS_TOKEN credential — no config to follow
    }),
    spawnSessionHostDetached: (_runner, planPath, _log, env) => {
      // The plan is unlinked on read in production — capture its bytes now.
      spawned.push({
        planPath: readFileSync(planPath, "utf8"),
        env,
      });
      return 7001;
    },
  });
  const code = await runSessionConnect(
    {
      provider: "claude",
      providerSession: "cc-refresh",
      transcriptPath: "/t/refresh.jsonl",
    },
    d,
  );
  assert.equal(code, 0);
  const planBytes = spawned[0]!.planPath;
  const plan = JSON.parse(planBytes) as Record<string, unknown>;
  assert.ok(!("bearer" in plan), "the plan carries NO bearer field");
  assert.doesNotMatch(planBytes, new RegExp(TOKEN), "no token bytes in plan");
  assert.equal(plan.configPath, null, "env token: nothing to follow");
  assert.deepEqual(
    spawned[0]!.env,
    { STACKS_TOKEN: TOKEN },
    "the credential rides the child environment instead",
  );
  // Nothing under the spool (markers, request files) may hold token bytes.
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else
        assert.doesNotMatch(
          readFileSync(path, "utf8"),
          new RegExp(TOKEN),
          `no token bytes in spool file ${path}`,
        );
    }
  };
  scan(spool);

  // A config-file token names the config REFERENCE instead — still no bytes.
  const spawned2: Array<{ planPath: string; env?: Record<string, string> }> =
    [];
  const d2 = deps(caller, {
    spoolRoot: spool,
    cwd: () => root,
    git: gitAt(root),
    configPath: "/home/op/.config/stacks/config.json",
    resolveTarget: () => ({
      token: TOKEN,
      url: "https://stacks.example/api/mcp",
      tokenSource: "file",
    }),
    spawnSessionHostDetached: (_runner, planPath, _log, env) => {
      spawned2.push({ planPath: readFileSync(planPath, "utf8"), env });
      return 7002;
    },
  });
  assert.equal(
    await runSessionConnect(
      {
        provider: "claude",
        providerSession: "cc-refresh-2",
        transcriptPath: "/t/refresh2.jsonl",
      },
      d2,
    ),
    0,
  );
  const plan2 = JSON.parse(spawned2[0]!.planPath) as Record<string, unknown>;
  assert.ok(!("bearer" in plan2));
  assert.doesNotMatch(spawned2[0]!.planPath, new RegExp(TOKEN));
  assert.equal(plan2.configPath, "/home/op/.config/stacks/config.json");
  assert.equal(spawned2[0]!.env, undefined, "config-following: no env needed");
});

test("status: an empty spool with a flush stamp reads as acknowledged, not as nothing (F-4 follow-up)", async () => {
  const spool = mkdtempSync(join(tmpdir(), "stacks-acked-"));
  const dir = join(spool, "ses_ack");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "host.json"),
    JSON.stringify({
      pid: 5151,
      startedAt: "2026-08-07T00:00:00.000Z",
      provider: "claude",
      mode: "watch",
      ackedParts: 2,
      lastFlushAt: new Date().toISOString(),
    }),
  );
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_ack",
      provider: "claude",
      status: "ACTIVE",
      projectName: "HTML Report",
      projectId: "proj_1",
      repoOwnerName: "acme/api",
      captureComplete: false,
      captureError: null,
      summaryArtifactId: null,
    }),
  });
  const d = deps(caller, { spoolRoot: spool, isPidAlive: () => true });
  assert.equal(await runSessionStatus("ses_ack", {}, d), 0);
  const detail = d.out.join("\n");
  assert.match(detail, /2 part\(s\) acknowledged server-side/);
  assert.doesNotMatch(
    detail,
    /no parts yet/,
    "an acknowledged spool is not 'nothing captured'",
  );
});

test("attach with NO transcript context warns BOUND BUT NOT RECORDING — never claims capture began", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    attach_agent_session: () => ({
      id: "ses_d2",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "ACTIVE",
      converged: false,
    }),
  });
  const root = boundCheckout();
  const d = deps(caller, { cwd: () => root, git: gitAt(root) }); // no HOME → no hook context, no transcript
  const code = await runSessionAttach(
    { provider: "claude", providerSession: "cc-blind" },
    d,
  );
  assert.equal(code, 0, "the bind itself still succeeds");
  assert.match(d.err.join("\n"), /SESSION BOUND BUT NOT RECORDING/);
  assert.doesNotMatch(d.out.join("\n"), /Capture begins at attachment/);
});

test("codex attach warns that the binding records no local capture", async () => {
  const caller = fakeCaller({
    resolve_projects_for_repo: () => ({ projects: [CANDIDATE] }),
    attach_agent_session: () => ({
      id: "ses_d3",
      workspaceId: "ws_1",
      projectId: "proj_1",
      status: "ACTIVE",
      converged: false,
    }),
  });
  const root2 = boundCheckout();
  const d = deps(caller, { cwd: () => root2, git: gitAt(root2) });
  const code = await runSessionAttach(
    { provider: "codex", providerSession: "thread_d3" },
    d,
  );
  assert.equal(code, 0);
  assert.match(d.err.join("\n"), /SESSION BOUND BUT NOT RECORDING/);
});

test("session end defers to a live local capture host and reports ITS verdict", async () => {
  const spool = mkdtempSync(join(tmpdir(), "stacks-end-"));
  const dir = join(spool, "ses_e1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "host.json"),
    JSON.stringify({
      pid: 7777,
      startedAt: "2026-08-07T00:00:00.000Z",
      provider: "claude",
      mode: "watch",
    }),
  );
  let hostDone = false;
  let completeCalls = 0;
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_e1",
      status: hostDone ? "COMPLETED" : "ACTIVE",
      captureComplete: hostDone,
      summaryArtifactId: hostDone ? "art_9" : null,
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-07T00:10:00.000Z",
    }),
    complete_agent_session: () => {
      completeCalls += 1;
      return { status: "COMPLETED", captureComplete: true };
    },
  });
  const d = deps(caller, {
    spoolRoot: spool,
    isPidAlive: () => !hostDone,
    sleep: async () => {
      // The host notices end-request.json and finalizes: stamps its exit.
      hostDone = true;
      writeFileSync(
        join(dir, "host.json"),
        JSON.stringify({
          pid: 7777,
          startedAt: "2026-08-07T00:00:00.000Z",
          provider: "claude",
          mode: "watch",
          exitedAt: "2026-08-07T00:11:00.000Z",
          exitCode: 0,
        }),
      );
    },
  });
  const code = await runSessionEnd("ses_e1", {}, d);
  assert.equal(code, 0);
  assert.equal(
    completeCalls,
    0,
    "the host owns completion — the CLI must not race it",
  );
  assert.ok(
    existsSync(join(dir, "end-request.json")),
    "the end request was handed to the host",
  );
  assert.match(d.out.join("\n"), /capture complete/);
});

test("session end falls through to server-side completion when the host exits WITHOUT closing (AGE-934 shape)", async () => {
  // A host holding a dead bearer (or crashing mid-finalize) stamps its exit
  // but cannot complete the session — `end` must not report "closed" over a
  // session that is still ACTIVE; it completes server-side instead.
  const spool = mkdtempSync(join(tmpdir(), "stacks-end3-"));
  const dir = join(spool, "ses_e3");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "host.json"),
    JSON.stringify({
      pid: 7779,
      startedAt: "2026-08-07T00:00:00.000Z",
      provider: "claude",
      mode: "watch",
    }),
  );
  let hostExited = false;
  let completeCalls = 0;
  // 2026-08-08 finding (session cmsk80my…): the dead host leaves its last
  // provider-receipt rollup in the spool — the fallback must submit it
  // rather than closing the session with null usage.
  writeFileSync(
    join(dir, "usage.json"),
    JSON.stringify({
      rollup: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 9000,
        cacheCreationTokens: 100,
        providerActiveDurationMs: 61_000,
        toolDurationMs: 4_000,
        coverage: "COMPLETE",
        missingRanges: [],
      },
      updatedAt: "2026-08-07T00:09:00.000Z",
    }),
  );
  let completedWith: Record<string, unknown> | null = null;
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_e3",
      status: "ACTIVE", // the host never managed to close it
      captureComplete: false,
      summaryArtifactId: null,
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-07T00:10:00.000Z",
    }),
    complete_agent_session: (args) => {
      completeCalls += 1;
      completedWith = args;
      return {
        status: "COMPLETED",
        captureComplete: false,
        summaryArtifactId: "art_e3",
      };
    },
  });
  const d = deps(caller, {
    spoolRoot: spool,
    isPidAlive: () => !hostExited,
    sleep: async () => {
      hostExited = true;
      writeFileSync(
        join(dir, "host.json"),
        JSON.stringify({
          pid: 7779,
          startedAt: "2026-08-07T00:00:00.000Z",
          provider: "claude",
          mode: "watch",
          exitedAt: "2026-08-07T00:11:00.000Z",
          exitCode: 1,
        }),
      );
    },
  });
  const code = await runSessionEnd("ses_e3", {}, d);
  assert.equal(completeCalls, 1, "the CLI completed server-side");
  assert.equal(
    code,
    EXIT_CODES.CAPTURE_INCOMPLETE,
    "capture debt stays visible in the exit code — but as its OWN code (AGE-965), not 1",
  );
  assert.match(
    d.err.join("\n"),
    /without completing/,
    "the fall-through is announced, not silent",
  );
  const usage = (completedWith as unknown as Record<string, unknown>)
    .usage as Record<string, unknown>;
  assert.equal(
    usage.inputTokens,
    1200,
    "the spooled rollup reached the server",
  );
  assert.equal(usage.coverage, "COMPLETE");
  assert.match(d.err.join("\n"), /usage snapshot from the retained spool/);
});

test("session end completes server-side when the local host already exited", async () => {
  const spool = mkdtempSync(join(tmpdir(), "stacks-end2-"));
  const dir = join(spool, "ses_e2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "host.json"),
    JSON.stringify({
      pid: 7778,
      startedAt: "2026-08-07T00:00:00.000Z",
      provider: "claude",
      mode: "watch",
      exitedAt: "2026-08-07T00:05:00.000Z",
      exitCode: 1,
    }),
  );
  let completeCalls = 0;
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_e2",
      status: "ACTIVE",
      captureComplete: false,
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-07T00:10:00.000Z",
    }),
    complete_agent_session: () => {
      completeCalls += 1;
      return {
        status: "COMPLETED",
        captureComplete: true,
        summaryArtifactId: "art_2",
      };
    },
  });
  const d = deps(caller, { spoolRoot: spool, isPidAlive: () => false });
  const code = await runSessionEnd("ses_e2", {}, d);
  assert.equal(code, 0);
  assert.equal(completeCalls, 1, "no live host — the direct path completes");
  assert.ok(!existsSync(join(dir, "end-request.json")));
});

test("bare end with trusted identity reaps its stale marker and resolves its ACTIVE session (AGE-963)", async () => {
  // 0.4.16 live finding P1-1/P1-3: the marker said ses_old, ses_old had
  // already ended, and the genuinely ACTIVE session kept running while the
  // command died with SESSION_NOT_ACTIVE — permanently, because the stale
  // marker was never reaped on that path.
  const confDir = mkdtempSync(join(tmpdir(), "stacks-end-stale-"));
  const configPath = join(confDir, "config.json");
  writeAlignmentMarker(
    configPath,
    "/work/api",
    {
      sessionId: "ses_old",
      workspaceId: "ws_1",
      projectId: "proj_1",
      taskId: null,
      capture: "off",
      alignedAt: "2026-08-09T00:00:00.000Z",
    },
    "thread-1",
  );
  let completeCalls = 0;
  const caller = fakeCaller({
    get_agent_session: (args) =>
      args.sessionId === "ses_old"
        ? {
            id: "ses_old",
            status: "COMPLETED",
            repoOwnerName: "acme/api",
            updatedAt: "2026-08-09T00:10:00.000Z",
          }
        : {
            id: "ses_live",
            status: "ACTIVE",
            providerSessionId: "thread-1",
            repoOwnerName: "acme/api",
            alignment: { capture: "off" },
            updatedAt: "2026-08-10T00:10:00.000Z",
          },
    list_workspaces: () => ({ workspaces: [{ id: "ws_1" }] }),
    list_agent_sessions: (args) =>
      args.status === "ACTIVE"
        ? {
            sessions: [
              {
                id: "ses_live",
                projectId: "proj_2",
                repoOwnerName: "acme/api",
                operator: { id: "user_1" },
                providerConnectionId: localConnectionKey(
                  "user_1",
                  "install-uuid-1",
                ),
              },
              {
                // Another operator's session on the same repo — never ours.
                id: "ses_theirs",
                projectId: "proj_9",
                repoOwnerName: "acme/api",
                operator: { id: "user_2" },
                providerConnectionId: localConnectionKey(
                  "user_2",
                  "another-machine",
                ),
              },
            ],
          }
        : { sessions: [] },
    complete_agent_session: (args) => {
      completeCalls += 1;
      assert.equal(args.sessionId, "ses_live");
      return {
        status: "COMPLETED",
        captureComplete: false,
        summaryArtifactId: null,
      };
    },
  });
  const spool = mkdtempSync(join(tmpdir(), "stacks-end-stale-spool-"));
  const d = deps(caller, {
    configPath,
    spoolRoot: spool,
    env: { CODEX_THREAD_ID: "thread-1" },
  });
  const code = await runSessionEnd(undefined, {}, d);
  assert.equal(code, 0, "capture-off close is clean");
  assert.equal(
    completeCalls,
    1,
    "the LIVE session was ended, not the stale one",
  );
  const out = d.out.join("\n");
  assert.match(out, /Stale alignment marker cleared \(session ses_old/);
  assert.match(out, /Ending this session: ses_live/);
  assert.ok(
    !existsSync(alignmentMarkerPath(configPath, "/work/api")),
    "the stale marker file is gone",
  );
});

test("resume checks provider continuity and reuses the stored thread (AC13)", async () => {
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_3",
      provider: "claude",
      providerSessionId: "claude_thread",
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-06T10:00:00.000Z",
    }),
    resume_agent_session: (args) => {
      assert.equal(args.expectedUpdatedAt, "2026-08-06T10:00:00.000Z");
      assert.equal(args.repoOwnerName, "acme/api");
      return {
        id: "ses_3",
        workspaceId: "ws_1",
        projectId: "proj_1",
        status: "ACTIVE",
      };
    },
  });
  const d = deps(caller, { spoolRoot: process.env.TMPDIR ?? "/tmp" });
  const code = await runSessionStart("claude", { resume: "ses_3" }, d);
  assert.equal(code, 0);

  const wrongProvider = fakeCaller({
    get_agent_session: () => ({
      id: "ses_3",
      provider: "codex",
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-06T10:00:00.000Z",
    }),
  });
  const d2 = deps(wrongProvider);
  const code2 = await runSessionStart("claude", { resume: "ses_3" }, d2);
  assert.equal(code2, 2);
  assert.match(d2.err[0]!, /SESSION_RESUME_CONFLICT/);
});

// ---------------------------------------------------------------------------
// AGE-965 — a successful close carrying capture debt is NOT a failed close.
// ---------------------------------------------------------------------------

test("sessionCloseVerdict separates capture debt (8) from clean (0) — AGE-965", () => {
  // The server's own derived verdict (AGE-958) decides when present.
  assert.deepEqual(sessionCloseVerdict({ captureStatus: "COMPLETE" }, false), {
    code: EXIT_CODES.OK,
    capture: "complete",
  });
  assert.equal(
    sessionCloseVerdict({ captureStatus: "OFF_BY_DESIGN" }, false).code,
    EXIT_CODES.OK,
    "capture-off is a deliberate mode, never debt — even with no alignment read",
  );
  for (const status of ["PENDING", "ERROR"]) {
    const verdict = sessionCloseVerdict({ captureStatus: status }, false);
    assert.equal(
      verdict.code,
      EXIT_CODES.CAPTURE_INCOMPLETE,
      `${status} is recorded capture debt, not a failed close`,
    );
    assert.match(verdict.capture, /INCOMPLETE \(recorded\)/);
  }
  // Fallback for a server predating captureStatus.
  assert.equal(
    sessionCloseVerdict({ captureComplete: true }, false).code,
    EXIT_CODES.OK,
  );
  assert.equal(
    sessionCloseVerdict({ captureComplete: false }, true).code,
    EXIT_CODES.OK,
    "capture-off alignment still reads clean without captureStatus",
  );
  assert.equal(
    sessionCloseVerdict({ captureComplete: false }, false).code,
    EXIT_CODES.CAPTURE_INCOMPLETE,
  );
  // The code is distinct from every failure code — that IS the fix.
  const failureCodes: number[] = [
    EXIT_CODES.INTERNAL,
    EXIT_CODES.INVALID_INPUT,
    EXIT_CODES.FORBIDDEN,
    EXIT_CODES.NOT_FOUND,
    EXIT_CODES.CONFLICT,
    EXIT_CODES.RATE_LIMITED,
    EXIT_CODES.TRANSPORT,
  ];
  assert.ok(!failureCodes.includes(EXIT_CODES.CAPTURE_INCOMPLETE));
});

test("session end exits CAPTURE_INCOMPLETE on a successful close with a gap, and --json carries the distinction (AGE-965)", async () => {
  const caller = fakeCaller({
    get_agent_session: () => ({
      id: "ses_gap",
      status: "ACTIVE",
      captureComplete: false,
      captureStatus: "PENDING",
      summaryArtifactId: null,
      repoOwnerName: "acme/api",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }),
    complete_agent_session: () => ({
      id: "ses_gap",
      status: "COMPLETED",
      captureComplete: false,
      captureStatus: "PENDING",
      summaryArtifactId: null,
    }),
  });
  const spool = mkdtempSync(join(tmpdir(), "stacks-end-gap-"));
  const d = deps(caller, { spoolRoot: spool, isPidAlive: () => false });
  const code = await runSessionEnd("ses_gap", { json: true }, d);
  assert.equal(code, EXIT_CODES.CAPTURE_INCOMPLETE);
  // A script must decide from JSON ALONE — no parsing of the human line.
  const payload = JSON.parse(d.out.join("\n")) as Record<string, unknown>;
  assert.equal(payload.status, "COMPLETED", "the close SUCCEEDED");
  assert.equal(payload.captureComplete, false);
  assert.equal(payload.captureStatus, "PENDING");
});

// ---------------------------------------------------------------------------
// F1/F1c (2026-08-11 MVP gap report) — the resolver must bind the session that
// is ASKING, and say so. The reported shape: Claude Code launched from
// ~/task-manager, the CLI run from the sibling ~/test-1, and a 35-hour-stale
// SessionStart in ~/test-1 (no SessionEnd, transcript still on disk) won.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-11T02:46:00.000Z");
const isoAgo = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function hookFile(
  records: Array<{
    event: string;
    at: string;
    session_id: string;
    cwd: string;
    transcript_path?: string;
  }>,
): string {
  return records
    .map(({ event, at, ...payload }) => JSON.stringify({ event, at, payload }))
    .join("\n");
}

test("hook context never selects a session that already ENDED (F1)", () => {
  const body = hookFile([
    {
      event: "SessionStart",
      at: isoAgo(3),
      session_id: "ended_ses",
      cwd: "/work/api",
      transcript_path: "/t/ended.jsonl",
    },
    {
      event: "SessionEnd",
      at: isoAgo(2),
      session_id: "ended_ses",
      cwd: "/work/api",
    },
    {
      event: "SessionStart",
      at: isoAgo(1),
      session_id: "live_ses",
      cwd: "/work/api",
      transcript_path: "/t/live.jsonl",
    },
  ]);
  const context = readClaudeHookContext(
    { env: { HOME: "/home/op" }, cwd: () => "/work/api" },
    () => body,
    () => NOW - HOUR,
    () => NOW,
  );
  assert.equal(context?.sessionId, "live_ses");

  // …and an ended session is not a fallback either: with only the ended
  // record present, the resolver returns nothing rather than binding a corpse.
  const onlyEnded = hookFile([
    {
      event: "SessionStart",
      at: isoAgo(3),
      session_id: "ended_ses",
      cwd: "/work/api",
      transcript_path: "/t/ended.jsonl",
    },
    {
      event: "SessionEnd",
      at: isoAgo(2),
      session_id: "ended_ses",
      cwd: "/work/api",
    },
  ]);
  assert.equal(
    readClaudeHookContext(
      { env: { HOME: "/home/op" }, cwd: () => "/work/api" },
      () => onlyEnded,
      () => NOW - HOUR,
      () => NOW,
    ),
    null,
  );
});

test("hook context refuses a STALE unterminated SessionStart (F1)", () => {
  // The reported record: 35h old, never ended, transcript still on disk but
  // equally cold. Existence is not liveness.
  const body = hookFile([
    {
      event: "SessionStart",
      at: isoAgo(35),
      session_id: "0e0e6a88",
      cwd: "/work/api",
      transcript_path: "/t/stale.jsonl",
    },
  ]);
  assert.equal(
    readClaudeHookContext(
      { env: { HOME: "/home/op" }, cwd: () => "/work/api" },
      () => body,
      () => NOW - 30 * HOUR, // transcript last touched 30h ago
      () => NOW,
    ),
    null,
  );
  // A long-running session is NOT stale: the start is old, the transcript is
  // seconds fresh. Bounding on the start alone would evict real work.
  assert.equal(
    readClaudeHookContext(
      { env: { HOME: "/home/op" }, cwd: () => "/work/api" },
      () => body,
      () => NOW - 5_000,
      () => NOW,
    )?.sessionId,
    "0e0e6a88",
  );
});

test("hook context reports a NEWER live session in another cwd (F1)", () => {
  // Verbatim F1: same machine, same moment, two directories.
  const body = hookFile([
    {
      event: "SessionStart",
      at: isoAgo(3),
      session_id: "0e0e6a88",
      cwd: "/Users/op/test-1",
      transcript_path: "/t/stale.jsonl",
    },
    {
      event: "SessionStart",
      at: isoAgo(0.1),
      session_id: "9c08e219",
      cwd: "/Users/op/task-manager",
      transcript_path: "/t/live.jsonl",
    },
  ]);
  const context = readClaudeHookContext(
    { env: { HOME: "/home/op" }, cwd: () => "/Users/op/test-1" },
    () => body,
    () => NOW - 60_000,
    () => NOW,
  );
  assert.equal(context?.sessionId, "0e0e6a88");
  assert.equal(context?.newerElsewhere?.sessionId, "9c08e219");
  assert.equal(context?.newerElsewhere?.cwd, "/Users/op/task-manager");
  assert.match(context!.basis, /SessionStart/);
});

test("hook context keeps the AGE-957 transcript-exists preference among survivors", () => {
  const body = hookFile([
    {
      event: "SessionStart",
      at: isoAgo(0.2),
      session_id: "real_ses",
      cwd: "/work/api",
      transcript_path: "/t/real.jsonl",
    },
    {
      event: "SessionStart",
      at: isoAgo(0.1),
      session_id: "phantom_ses",
      cwd: "/work/api",
      transcript_path: "/t/phantom.jsonl",
    },
  ]);
  const mtime = (path: string) => (path === "/t/real.jsonl" ? NOW : null);
  assert.equal(
    readClaudeHookContext(
      { env: { HOME: "/home/op" }, cwd: () => "/work/api" },
      () => body,
      mtime,
      () => NOW,
    )?.sessionId,
    "real_ses",
  );
  // Neither transcript on disk (brand-new session) — newest stays the
  // fallback, and the age bound reads the START when there is no file.
  assert.equal(
    readClaudeHookContext(
      { env: { HOME: "/home/op" }, cwd: () => "/work/api" },
      () => body,
      () => null,
      () => NOW,
    )?.sessionId,
    "phantom_ses",
  );
});

// ---------------------------------------------------------------------------
// JEN-457 — `session connect` must launch its host under the mode the SERVER
// resolves for this operator. Before this the watch plan carried no
// captureTrace at all, so the host fell back to its own `true` and every
// connected session recorded TRACE capture on, ahead of the account default;
// the first align then SENT that observation ("(live host)") and the D3 chain
// was never reached. Reproduced on prod 2026-09-06 on three sessions.
// ---------------------------------------------------------------------------

/** Run connect against an attach result and return the host plan it wrote. */
async function connectPlan(
  attachResult: Record<string, unknown>,
  flags: Record<string, unknown> = {},
): Promise<{
  plan: Record<string, unknown>;
  attachArgs: Record<string, unknown>;
  out: string;
}> {
  let attachArgs: Record<string, unknown> = {};
  const caller = fakeCaller({
    attach_agent_session: (args) => {
      attachArgs = args;
      return attachResult;
    },
    get_agent_session: () => ({ id: "ses_cap", status: "ACTIVE" }),
  });
  const spool = mkdtempSync(join(tmpdir(), "stacks-jen457-"));
  const root = boundCheckout();
  const plans: string[] = [];
  const d = deps(caller, {
    spoolRoot: spool,
    cwd: () => root,
    git: gitAt(root),
    spawnSessionHostDetached: (_runner, planPath) => {
      plans.push(readFileSync(planPath, "utf8"));
      return 7101;
    },
  });
  const code = await runSessionConnect(
    {
      provider: "claude",
      providerSession: "cc-cap",
      transcriptPath: "/t/cap.jsonl",
      ...flags,
    },
    d,
  );
  assert.equal(code, 0);
  return {
    plan: JSON.parse(plans[0]!) as Record<string, unknown>,
    attachArgs,
    out: d.out.join("\n"),
  };
}

const ATTACHED = {
  id: "ses_cap",
  workspaceId: "ws_1",
  projectId: null,
  status: "ACTIVE",
  converged: false,
};

test("connect: a preference-less account starts the host capture OFF, from (built-in)", async () => {
  const { plan, attachArgs, out } = await connectPlan({
    ...ATTACHED,
    capture: "off",
    skeleton: "on",
    captureSources: { capture: "(built-in)", skeleton: "(built-in)" },
  });
  assert.equal(plan.captureTrace, false, "the shipped default must hold");
  assert.equal(plan.collectSkeleton, true);
  // Tri-state: no flag means OMIT, which is the only way the server ever
  // reaches the account default.
  assert.equal("capture" in attachArgs, false);
  assert.equal("skeleton" in attachArgs, false);
  assert.match(out, /TRACE capture is OFF \(built-in\)/);
  // JEN-457: the provenance rides the plan, so the first align can disclose
  // "(built-in)" rather than the generic "(live host)".
  assert.equal(plan.captureSource, "(built-in)");
});

test("connect: an account default of ON starts the host capturing, from (your default)", async () => {
  const { plan, out } = await connectPlan({
    ...ATTACHED,
    capture: "on",
    skeleton: "on",
    captureSources: { capture: "(your default)", skeleton: "(your default)" },
  });
  assert.equal(plan.captureTrace, true);
  assert.equal(plan.captureSource, "(your default)");
  assert.match(out, /TRACE capture ON \(your default\)/);
});

test("connect --capture sends the flag rung and starts capturing", async () => {
  const { plan, attachArgs } = await connectPlan(
    {
      ...ATTACHED,
      capture: "on",
      skeleton: "on",
      captureSources: { capture: "(flag)", skeleton: "(built-in)" },
    },
    { capture: true },
  );
  assert.equal(attachArgs.capture, "on");
  assert.equal(plan.captureTrace, true);
});

test("connect --no-capture sends off even when the account default is on", async () => {
  const { plan, attachArgs } = await connectPlan(
    {
      ...ATTACHED,
      capture: "off",
      skeleton: "on",
      captureSources: { capture: "(flag)", skeleton: "(built-in)" },
    },
    { capture: false },
  );
  assert.equal(attachArgs.capture, "off");
  assert.equal(plan.captureTrace, false);
});

test("connect --no-skeleton is independent of capture", async () => {
  const { plan, attachArgs } = await connectPlan(
    {
      ...ATTACHED,
      capture: "off",
      skeleton: "off",
      captureSources: { capture: "(built-in)", skeleton: "(flag)" },
    },
    { skeleton: false },
  );
  assert.equal(attachArgs.skeleton, "off");
  assert.equal(plan.collectSkeleton, false);
});

test("connect against an OLDER server (no resolved posture) falls back to the documented default, not TRACE-on", async () => {
  // The regression guard: the absent-field path is exactly what used to yield
  // captureTrace true.
  const { plan } = await connectPlan(ATTACHED);
  assert.equal(plan.captureTrace, false);
  assert.equal(plan.collectSkeleton, true);
});
