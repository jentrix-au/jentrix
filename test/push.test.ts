import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Command } from "commander";

import { writeAlignmentMarker } from "../src/session/state";
import {
  mintIssueCommandHint,
  registerMintIssueCommand,
  runMintIssue,
  runPush,
  type PushDeps,
} from "../src/commands/push";
import { createSessionRedactor } from "../src/session-host/session-redact";

// Jentrix MVP — `jentrix push`: AC6 (unaligned refusal naming the align
// command), AC7 (file + stdin), AC11 (local redaction before anything leaves
// the process).

function deps(overrides: Partial<PushDeps> = {}): PushDeps & {
  out: string[];
  err: string[];
  requests: Array<{ url: string; init: RequestInit }>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const dir = mkdtempSync(join(tmpdir(), "stacks-push-"));
  const base: PushDeps = {
    env: { CODEX_THREAD_ID: "test-thread" },
    cwd: () => dir,
    configPath: join(dir, "config.json"),
    resolveTarget: () => ({
      token: "tm_test_token_abcdefghijklmnop",
      url: "http://localhost:3000/api/mcp",
    }),
    ensureInstallationId: () => "install-1234",
    connect: async () => {
      throw new Error("push never opens an MCP connection");
    },
    // A fake git runner that reports a repo rooted at `dir`.
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
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ artifactId: "art_1", type: "REPORT", deduped: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
    ...overrides,
  };
  return Object.assign(base, { out, err, requests });
}

describe("jentrix push", () => {
  it("refuses an unaligned checkout naming the align command (AC6)", async () => {
    const d = deps();
    const code = await runPush("report", undefined, {}, d);
    assert.equal(code, 2);
    // JEN-300: the v2 command, not the deprecated alias (which also refuses
    // without --task|--session-level now).
    assert.match(d.err.join("\n"), /jentrix session align --task/);
  });

  it("refuses an unknown kind", async () => {
    const d = deps();
    const code = await runPush("transcript", undefined, {}, d);
    assert.equal(code, 2);
    assert.match(
      d.err.join("\n"),
      /plan, decision, findings, report, diff, deliverable, learning/,
    );
  });

  it("pushes a file for the aligned session, redacted locally (AC7/AC11)", async () => {
    const d = deps();
    writeAlignmentMarker(
      d.configPath,
      d.cwd(),
      {
        sessionId: "ses_1",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: "task_1",
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const file = join(d.cwd(), "report.md");
    writeFileSync(file, "# Report\ntoken: tm_supersecretbearer12345678 done");
    const code = await runPush("report", file, { title: "The report" }, d);
    assert.equal(code, 0);
    assert.equal(d.requests.length, 1);
    const request = d.requests[0]!;
    assert.match(request.url, /\/api\/agent-sessions\/ses_1\/artifacts$/);
    const body = JSON.parse(String(request.init.body)) as {
      kind: string;
      title: string;
      body: string;
    };
    assert.equal(body.kind, "report");
    assert.equal(body.title, "The report");
    assert.ok(!body.body.includes("tm_supersecretbearer12345678"));
    assert.match(body.body, /‹redacted›/);
    assert.match(d.out.join("\n"), /art_1/);
  });

  it("pushes stdin content (AC7)", async () => {
    const d = deps({ readStdin: async () => "piped findings" });
    writeAlignmentMarker(
      d.configPath,
      d.cwd(),
      {
        sessionId: "ses_2",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runPush("findings", undefined, {}, d);
    assert.equal(code, 0);
    const body = JSON.parse(String(d.requests[0]!.init.body)) as {
      body: string;
    };
    assert.equal(body.body, "piped findings");
  });

  it("relays the server's SESSION_NOT_ALIGNED refusal as a conflict", async () => {
    const d = deps({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            error:
              "SESSION_NOT_ALIGNED: this session is not aligned to a work layer — run `jentrix align` (or /jentrix-align in Claude Code) first",
          }),
          { status: 409 },
        )) as typeof fetch,
    });
    writeAlignmentMarker(
      d.configPath,
      d.cwd(),
      {
        sessionId: "ses_3",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runPush(
      "plan",
      undefined,
      {},
      {
        ...d,
        readStdin: async () => "content",
      },
    );
    assert.equal(code, 5);
    assert.match(d.err.join("\n"), /jentrix align/);
  });
});

// ---------------------------------------------------------------------------
// mvp-hardening — resolution order, the sealed-session fallback (AC3), the
// task-addressed push (AC4), and the session-level caution (AC11).
// ---------------------------------------------------------------------------

/** A fetch that answers per route, so a fallback is observable end to end. */
function routedFetch(answers: {
  session?: { status: number; body: unknown };
  task?: { status: number; body: unknown };
}) {
  return (async (url: URL | string) => {
    const target = String(url).includes("/api/tasks/")
      ? (answers.task ?? {
          status: 200,
          body: {
            artifactId: "art_task",
            type: "REPORT",
            deduped: false,
            taskId: "task_1",
          },
        })
      : (answers.session ?? {
          status: 200,
          body: {
            artifactId: "art_ses",
            type: "REPORT",
            deduped: false,
            taskId: "task_1",
          },
        });
    return new Response(JSON.stringify(target.body), {
      status: target.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const SEALED = {
  status: 409,
  body: {
    error:
      "SESSION_NOT_ACTIVE: this session has ended — start or attach a new session",
  },
};

function marker(
  d: { configPath: string; cwd(): string },
  taskId: string | null,
) {
  writeAlignmentMarker(
    d.configPath,
    d.cwd(),
    {
      sessionId: "ses_sealed",
      workspaceId: "ws_1",
      projectId: "proj_1",
      taskId,
      capture: "off",
      alignedAt: new Date().toISOString(),
    },
    "test-thread",
  );
}

describe("jentrix push — addressing", () => {
  it("--task addresses the task route with no session and no marker (AC4)", async () => {
    const d = deps({
      fetchImpl: routedFetch({}),
      readStdin: async () => "session-free findings",
    });
    const code = await runPush("findings", undefined, { task: "task_9" }, d);
    assert.equal(code, 0);
    assert.equal(d.requests.length, 0, "routedFetch replaces the recorder");
    assert.match(d.out.join("\n"), /art_task/);
  });

  it("records no marker read when --task is explicit", async () => {
    const d = deps();
    // The recording fetch answers with the default 200 body for either route.
    const code = await runPush(
      "report",
      undefined,
      { task: "task_9" },
      {
        ...d,
        readStdin: async () => "x",
      },
    );
    assert.equal(code, 0);
    assert.match(d.requests[0]!.url, /\/api\/tasks\/task_9\/artifacts$/);
  });

  it("refuses --session and --task together", async () => {
    const d = deps();
    const code = await runPush(
      "plan",
      undefined,
      {
        session: "ses_1",
        task: "task_1",
      },
      d,
    );
    assert.equal(code, 2);
    assert.match(d.err.join("\n"), /not both/);
  });

  it("falls back to the marker's task when the session is sealed (AC3)", async () => {
    const d = deps({
      fetchImpl: routedFetch({ session: SEALED }),
      readStdin: async () => "post-mortem findings",
    });
    marker(d, "task_1");
    const code = await runPush("findings", undefined, {}, d);
    assert.equal(code, 0, "a dead background process never costs an artifact");
    assert.match(d.err.join("\n"), /has ended/);
    assert.match(d.err.join("\n"), /straight to task task_1/);
    assert.match(d.out.join("\n"), /art_task/);
  });

  it("keeps the refusal when a sealed session has no task to fall back to", async () => {
    const d = deps({
      fetchImpl: routedFetch({ session: SEALED }),
      readStdin: async () => "x",
    });
    marker(d, null);
    const code = await runPush("findings", undefined, {}, d);
    assert.equal(code, 5);
    assert.match(d.err.join("\n"), /SESSION_NOT_ACTIVE/);
  });

  it("an explicit --session never falls back (the operator named it)", async () => {
    const d = deps({
      fetchImpl: routedFetch({ session: SEALED }),
      readStdin: async () => "x",
    });
    marker(d, "task_1");
    const code = await runPush("findings", undefined, { session: "ses_x" }, d);
    assert.equal(code, 5);
  });

  it("a push that landed on NO task discloses it and still exits 0 (AC11)", async () => {
    const d = deps({
      fetchImpl: routedFetch({
        session: {
          status: 200,
          body: {
            artifactId: "art_ses",
            type: "LEARNING",
            deduped: false,
            taskId: null,
          },
        },
      }),
      readStdin: async () => "a lesson",
    });
    marker(d, null);
    const code = await runPush("learning", undefined, {}, d);
    assert.equal(code, 0);
    assert.match(d.err.join("\n"), /appear on NO task card/);
  });
});

// ---------------------------------------------------------------------------
// F1 — `jentrix artifact mint-issue`: the offer's command form. Same mint as
// `push findings --yes`, correlated with the checkout's aligned session, and
// the REST link write carries the SAME X-Stacks-Session-Id as the sibling MCP
// calls (V9-cli-1).
// ---------------------------------------------------------------------------
describe("jentrix artifact mint-issue", () => {
  function mintCaller(artifactType = "FINDINGS") {
    return {
      callTool: async ({ name }: { name: string }) => {
        if (name === "get_artifact") {
          // The REAL shape: the row nests under `artifact` beside downloadUrl.
          return {
            structuredContent: {
              artifact: { id: "art_f", type: artifactType, title: "t" },
              downloadUrl: null,
            },
          };
        }
        if (name === "get_task") {
          return { structuredContent: { workspaceId: "ws_1", key: "STA-1" } };
        }
        if (name === "list_boards") {
          return {
            structuredContent: {
              boards: [
                {
                  id: "b_bugs",
                  name: "Issues",
                  kind: "BUGS",
                  archivedAt: null,
                },
              ],
            },
          };
        }
        if (name === "list_columns") {
          return {
            structuredContent: { columns: [{ id: "col_1", name: "Triage" }] },
          };
        }
        if (name === "create_task") {
          return { structuredContent: { id: "issue_1", key: "BUG-1" } };
        }
        if (name === "add_task_link") {
          return { structuredContent: { ok: true } };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    };
  }

  it("mints the card, correlated with the checkout's aligned session, and stamps the REST link write (V9-cli-1)", async () => {
    const targets: Array<{ sessionId?: string }> = [];
    const d = deps({
      connect: (async (target: { sessionId?: string }) => {
        targets.push(target);
        return { caller: mintCaller(), close: async () => undefined };
      }) as unknown as PushDeps["connect"],
    });
    writeAlignmentMarker(
      d.configPath,
      d.cwd(),
      {
        sessionId: "ses_mint",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: "task_1",
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1" },
      d,
    );
    assert.equal(code, 0);
    assert.match(d.out.join("\n"), /Minted BUG-1/);
    // The mint's write connection carried the aligned session.
    assert.ok(targets.some((t) => t.sessionId === "ses_mint"));
    // The REST link write carries the SAME correlation as the MCP calls.
    const link = d.requests.find((r) => r.url.includes("/api/tasks/issue_1/"));
    assert.ok(link, "the artifact was linked to the minted card over REST");
    const headers = link!.init.headers as Record<string, string>;
    assert.equal(headers["X-Stacks-Session-Id"], "ses_mint");
    assert.equal(JSON.parse(String(link!.init.body)).refArtifactId, "art_f");
  });

  it("runs unaligned too — no marker just means no correlation header, and the success line says so (JEN-274)", async () => {
    const d = deps({
      connect: (async () => ({
        caller: mintCaller(),
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1" },
      d,
    );
    assert.equal(code, 0);
    const link = d.requests.find((r) => r.url.includes("/api/tasks/issue_1/"));
    const headers = link!.init.headers as Record<string, string>;
    assert.equal(headers["X-Stacks-Session-Id"], undefined);
    // The evidence gap is named, never silent.
    assert.match(d.out.join("\n"), /card not correlated to a session/);
  });

  it("--session <id> correlates the mint with that session — over the marker — and the success line does not name a gap (JEN-274)", async () => {
    const targets: Array<{ sessionId?: string }> = [];
    const d = deps({
      connect: (async (target: { sessionId?: string }) => {
        targets.push(target);
        return { caller: mintCaller("GAP"), close: async () => undefined };
      }) as unknown as PushDeps["connect"],
    });
    // A marker for ANOTHER session exists in this checkout; the explicit
    // --session must win, exactly as it does for `push --session`.
    writeAlignmentMarker(
      d.configPath,
      d.cwd(),
      {
        sessionId: "ses_marker",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: "task_1",
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1", session: "ses_addr" },
      d,
    );
    assert.equal(code, 0);
    assert.ok(targets.some((t) => t.sessionId === "ses_addr"));
    assert.ok(!targets.some((t) => t.sessionId === "ses_marker"));
    const link = d.requests.find((r) => r.url.includes("/api/tasks/issue_1/"));
    const headers = link!.init.headers as Record<string, string>;
    assert.equal(headers["X-Stacks-Session-Id"], "ses_addr");
    assert.doesNotMatch(d.out.join("\n"), /not correlated/);
  });

  it("titles the card with the artifact's claim, never the anchor key (STA-128)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const base = mintCaller("GAP");
    const d = deps({
      connect: (async () => ({
        caller: {
          callTool: async (req: {
            name: string;
            arguments?: Record<string, unknown>;
          }) => {
            if (req.name === "create_task") created.push(req.arguments ?? {});
            return base.callTool(req as never);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1" },
      d,
    );
    assert.equal(code, 0);
    // mintCaller's stored artifact title is "t" — the claim rides the card.
    assert.equal(created[0]!.title, "Gap: t");
  });

  it("a --yes mint carries the push's own claim title onto the card (STA-128)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const base = mintCaller();
    const d = deps({
      readStdin: async () => "a finding",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            artifactId: "art_f",
            type: "FINDINGS",
            deduped: false,
            taskId: "task_1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      connect: (async () => ({
        caller: {
          callTool: async (req: {
            name: string;
            arguments?: Record<string, unknown>;
          }) => {
            if (req.name === "create_task") created.push(req.arguments ?? {});
            return base.callTool(req as never);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runPush(
      "findings",
      undefined,
      { session: "ses_x", yes: true, title: "Windows hook path untested" },
      d,
    );
    assert.equal(code, 0);
    assert.equal(created[0]!.title, "Finding: Windows hook path untested");
  });

  it("says so when the artifact link write fails — never 'artifact linked' (STA-115)", async () => {
    const d = deps({
      connect: (async () => ({
        caller: mintCaller(),
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
      fetchImpl: (async () =>
        new Response("boom", { status: 500 })) as typeof fetch,
    });
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1" },
      d,
    );
    assert.equal(code, 0, "a failed link must not cost the mint");
    assert.match(d.out.join("\n"), /artifact NOT linked/);
    assert.doesNotMatch(d.out.join("\n"), /· artifact linked ·/);
    assert.ok(
      d.err.some((l) =>
        l.includes(
          "link it by hand: jentrix push findings --task issue_1 --ref art_f",
        ),
      ),
    );
  });

  it("exits NOT_FOUND with the named fix when NO board can take a card (D7 last rung)", async () => {
    const d = deps({
      connect: (async () => ({
        caller: {
          callTool: async ({ name }: { name: string }) => {
            if (name === "get_artifact") {
              return {
                structuredContent: {
                  artifact: { id: "art_f", type: "FINDINGS" },
                  downloadUrl: null,
                },
              };
            }
            if (name === "get_task") {
              // No boardId → the anchor board fallback has nowhere to go.
              return { structuredContent: { workspaceId: "ws_1" } };
            }
            if (name === "list_boards") {
              return { structuredContent: { boards: [] } };
            }
            throw new Error(`unexpected tool ${name}`);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1" },
      d,
    );
    assert.equal(code, 4);
    assert.match(d.err.join("\n"), /no board can take a card/i);
  });

  it("falls back to the anchor task's OWN board on a TASKS-only workspace (taxonomy AC3.2/D7)", async () => {
    const d = deps({
      connect: (async () => ({
        caller: {
          callTool: async ({
            name,
            arguments: args,
          }: {
            name: string;
            arguments?: Record<string, unknown>;
          }) => {
            if (name === "get_artifact") {
              return {
                structuredContent: {
                  artifact: { id: "art_g", type: "GAP" },
                  downloadUrl: null,
                },
              };
            }
            if (name === "get_task") {
              return {
                structuredContent: {
                  workspaceId: "ws_1",
                  key: "STA-1",
                  boardId: "b_work",
                  boardName: "Work",
                },
              };
            }
            if (name === "list_boards") {
              // TASKS-only workspace: no BUGS board anywhere.
              return {
                structuredContent: {
                  boards: [
                    {
                      id: "b_work",
                      name: "Work",
                      kind: "TASKS",
                      archivedAt: null,
                    },
                  ],
                },
              };
            }
            if (name === "list_columns") {
              assert.equal((args as { boardId?: string }).boardId, "b_work");
              return {
                structuredContent: {
                  columns: [{ id: "col_w1", name: "Backlog" }],
                },
              };
            }
            if (name === "create_task") {
              assert.equal(
                (args as { columnId?: string }).columnId,
                "col_w1",
                "the card lands in the anchor board's FIRST column",
              );
              assert.equal(
                (args as { idempotencyKey?: string }).idempotencyKey,
                "mint-art_g",
                "idempotency key is mint-<artifactId> (AC3.4)",
              );
              return { structuredContent: { id: "gap_1", key: "STA-9" } };
            }
            if (name === "add_task_link") {
              return { structuredContent: { ok: true } };
            }
            throw new Error(`unexpected tool ${name}`);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runMintIssue(
      { artifact: "art_g", fromTask: "task_1" },
      d,
    );
    assert.equal(code, 0);
    assert.match(d.out.join("\n"), /Minted STA-9 on Work/);
    assert.match(d.out.join("\n"), /RELATES_TO task_1/);
  });

  it("--blocks links the minted card BLOCKS the anchor (taxonomy AC3.3)", async () => {
    const links: Array<Record<string, unknown>> = [];
    const caller = mintCaller("ISSUE");
    const base = caller.callTool;
    caller.callTool = async (req: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      if (req.name === "add_task_link") {
        links.push(req.arguments ?? {});
        return { structuredContent: { ok: true } };
      }
      return base(req);
    };
    const d = deps({
      connect: (async () => ({
        caller,
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1", blocks: true },
      d,
    );
    assert.equal(code, 0);
    assert.deepEqual(links, [
      { fromTaskId: "issue_1", toTaskId: "task_1", kind: "BLOCKS" },
    ]);
    assert.match(d.out.join("\n"), /BLOCKS task_1/);
  });

  it("refuses to mint a non-mintable artifact type (taxonomy AC3.1)", async () => {
    const d = deps({
      connect: (async () => ({
        caller: mintCaller("PLAN"),
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runMintIssue(
      { artifact: "art_f", fromTask: "task_1" },
      d,
    );
    assert.notEqual(code, 0);
    assert.match(d.err.join("\n"), /only FINDINGS, GAP, and ISSUE/);
  });
});

describe("local push redaction (session-host/session-redact)", () => {
  it("scrubs secret-shaped content and configured env values", () => {
    const env = { STACKS_TOKEN: "tm_live_valueXYZ12345678" };
    const input = [
      "bearer tm_live_valueXYZ12345678",
      "anthropic sk-ant-abcdefghijklmnopqrstuvwx",
      "github ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234",
      "aws AKIAABCDEFGHIJKLMNOP",
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = createSessionRedactor({ env }).text(input);
    assert.ok(!out.includes("tm_live_valueXYZ12345678"));
    assert.ok(!out.includes("sk-ant-abcdefghijklmnopqrstuvwx"));
    assert.ok(!out.includes("ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234"));
    assert.ok(!out.includes("AKIAABCDEFGHIJKLMNOP"));
    assert.ok(!out.includes("BEGIN PRIVATE KEY"));
  });
});

// ---------------------------------------------------------------------------
// control-room 04-6 (AC7.2–AC7.8) — the handoff half.
//
// The report's evidence was a single cross-task handoff in the whole estate,
// done by pushing the same bytes twice (checksum 40e50a… as two rows). Every
// behavior below OFFERS; none of it acts on its own, because a push whose side
// effects the operator did not ask for is worse than no offer at all.
// ---------------------------------------------------------------------------
describe("jentrix push --ref (control-room AC7.2/AC7.3)", () => {
  it("references an existing artifact instead of uploading bytes", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const d = deps({
      fetchImpl: (async (url: URL | string, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            artifactId: "art_1",
            taskId: "task_2",
            created: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const code = await runPush(
      "findings",
      undefined,
      {
        ref: "art_1",
        task: "task_2",
      },
      d,
    );
    assert.equal(code, 0);
    const body = JSON.parse(String(seen[0]!.init.body));
    assert.equal(body.refArtifactId, "art_1");
    // Nothing was uploaded: no kind, no body, no bytes.
    assert.equal(body.body, undefined);
    assert.match(d.out.join("\n"), /no copy/);
  });

  it("reports an already-linked pair as a no-op, not an error", async () => {
    const d = deps({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            artifactId: "art_1",
            taskId: "task_2",
            created: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const code = await runPush(
      "findings",
      undefined,
      {
        ref: "art_1",
        task: "task_2",
      },
      d,
    );
    assert.equal(code, 0);
    assert.match(d.out.join("\n"), /already reachable/);
  });

  it("refuses --ref without --task: a reference needs a destination", async () => {
    const d = deps();
    const code = await runPush("findings", undefined, { ref: "art_1" }, d);
    assert.equal(code, 2);
    assert.match(d.err.join("\n"), /--ref needs --task/);
  });

  it("refuses --ref alongside a file — two different requests", async () => {
    const d = deps();
    const code = await runPush(
      "findings",
      "notes.md",
      {
        ref: "art_1",
        task: "task_2",
      },
      d,
    );
    assert.equal(code, 2);
    assert.match(d.err.join("\n"), /takes no file/);
  });

  it("surfaces the server's cross-workspace refusal verbatim", async () => {
    const d = deps({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            detail:
              "an artifact can only be referenced from a task in its own workspace",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const code = await runPush(
      "findings",
      undefined,
      {
        ref: "art_1",
        task: "task_2",
      },
      d,
    );
    assert.notEqual(code, 0);
    assert.match(d.err.join("\n"), /its own workspace/);
  });
});

describe("jentrix push — the duplicate-bytes offer (control-room AC7.4)", () => {
  it("OFFERS a link when identical content already lives on another task", async () => {
    let calls = 0;
    const d = deps({
      fetchImpl: (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            artifactId: "art_new",
            type: "FINDINGS",
            deduped: false,
            taskId: "task_1",
            sameBytesOnTaskId: "task_9",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
      readStdin: async () => "a finding",
    });
    const code = await runPush("report", undefined, { task: "task_1" }, d);
    assert.equal(code, 0);
    const err = d.err.join("\n");
    assert.match(err, /already stored on task task_9/);
    assert.match(err, /--ref/);
    // Offered, not performed: the push is the only write that happened.
    assert.equal(calls, 1);
  });

  it("says nothing when the bytes are new", async () => {
    const d = deps({ readStdin: async () => "a finding" });
    await runPush("report", undefined, { task: "task_1" }, d);
    assert.equal(d.err.join("\n").includes("already stored on task"), false);
  });
});

describe("jentrix push decision --basis (taxonomy AC2.1, D6)", () => {
  it("prepends the structured block; URL refs are recorded verbatim with no MCP connection", async () => {
    const d = deps();
    writeAlignmentMarker(
      d.configPath,
      d.cwd(),
      {
        sessionId: "ses_basis",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runPush(
      "decision",
      undefined,
      { basis: ["https://example.com/spec"] },
      { ...d, readStdin: async () => "Chose X over Y because Z." },
    );
    assert.equal(code, 0);
    const body = JSON.parse(String(d.requests[0]!.init.body)) as {
      body: string;
    };
    assert.ok(
      body.body.startsWith(
        "Based on:\n- https://example.com/spec\n\nChose X over Y because Z.",
      ),
      body.body,
    );
  });

  it("resolves artifact-id refs (title inlined) and refuses the push when one does not resolve", async () => {
    const calls: string[] = [];
    const resolving = deps({
      connect: async () => ({
        caller: {
          async callTool({ arguments: args }) {
            calls.push(String((args as { artifactId?: string }).artifactId));
            return {
              structuredContent: {
                artifact: { id: "art_ok", title: "Search PRD" },
                downloadUrl: null,
              },
            };
          },
        },
        close: async () => undefined,
      }),
    });
    writeAlignmentMarker(
      resolving.configPath,
      resolving.cwd(),
      {
        sessionId: "ses_basis2",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const ok = await runPush(
      "decision",
      undefined,
      { basis: ["art_ok", "https://example.com/x"] },
      { ...resolving, readStdin: async () => "memo" },
    );
    assert.equal(ok, 0);
    assert.deepEqual(calls, ["art_ok"]);
    const posted = JSON.parse(String(resolving.requests[0]!.init.body)) as {
      body: string;
    };
    assert.ok(
      posted.body.startsWith(
        "Based on:\n- artifact art_ok — Search PRD\n- https://example.com/x\n\nmemo",
      ),
      posted.body,
    );

    const failing = deps({
      connect: async () => ({
        caller: {
          async callTool() {
            return {
              isError: true,
              content: [{ type: "text", text: "NOT_FOUND" }],
            };
          },
        },
        close: async () => undefined,
      }),
    });
    writeAlignmentMarker(
      failing.configPath,
      failing.cwd(),
      {
        sessionId: "ses_basis3",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runPush(
      "decision",
      undefined,
      { basis: ["art_missing"] },
      { ...failing, readStdin: async () => "memo" },
    );
    assert.notEqual(code, 0);
    assert.equal(
      failing.requests.length,
      0,
      "an unresolvable basis ref must refuse the push BEFORE anything is posted",
    );
    assert.ok(failing.err.some((line) => line.includes("art_missing")));
  });

  it("maps a RATE_LIMITED basis read to exit 6 — never 'does not resolve' (STA-116)", async () => {
    const limited = deps({
      connect: async () => ({
        caller: {
          async callTool() {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: { code: "RATE_LIMITED", message: "60/min exceeded" },
                  }),
                },
              ],
            };
          },
        },
        close: async () => undefined,
      }),
    });
    writeAlignmentMarker(
      limited.configPath,
      limited.cwd(),
      {
        sessionId: "ses_basis4",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runPush(
      "decision",
      undefined,
      { basis: ["art_fine"] },
      { ...limited, readStdin: async () => "memo" },
    );
    assert.equal(code, 6, "RATE_LIMITED must surface as exit 6");
    assert.ok(limited.err.some((l) => l.includes("rate limiting reads")));
    assert.ok(!limited.err.some((l) => l.includes("does not resolve")));
    assert.equal(limited.requests.length, 0);
  });

  it("names a server-side failure instead of blaming the ref (STA-116)", async () => {
    const broken = deps({
      connect: async () => ({
        caller: {
          async callTool() {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: { code: "INTERNAL", message: "database exploded" },
                  }),
                },
              ],
            };
          },
        },
        close: async () => undefined,
      }),
    });
    writeAlignmentMarker(
      broken.configPath,
      broken.cwd(),
      {
        sessionId: "ses_basis5",
        workspaceId: "ws_1",
        projectId: "proj_1",
        taskId: null,
        capture: "off",
        alignedAt: new Date().toISOString(),
      },
      "test-thread",
    );
    const code = await runPush(
      "decision",
      undefined,
      { basis: ["art_fine"] },
      { ...broken, readStdin: async () => "memo" },
    );
    assert.equal(code, 1);
    assert.ok(broken.err.some((l) => l.includes("(INTERNAL)")));
    assert.ok(!broken.err.some((l) => l.includes("does not resolve")));
  });

  it("refuses --basis on any kind but decision, and on --ref pushes", async () => {
    const d = deps();
    const code = await runPush(
      "report",
      undefined,
      { basis: ["https://example.com"] },
      { ...d, readStdin: async () => "body" },
    );
    assert.notEqual(code, 0);
    assert.ok(d.err.some((line) => line.includes("push decision")));
    assert.equal(d.requests.length, 0);

    const ref = deps();
    const refCode = await runPush(
      "decision",
      undefined,
      { basis: ["https://example.com"], ref: "art_1", task: "task_1" },
      ref,
    );
    assert.notEqual(refCode, 0);
    assert.equal(ref.requests.length, 0);
  });
});

describe("jentrix push — the finding→issue offer (control-room AC7.5/AC7.6/AC7.8)", () => {
  /** A push whose response is a normal findings artifact on a task. */
  function findingsPush(extra: Partial<PushDeps> = {}) {
    return deps({
      readStdin: async () => "a finding",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            artifactId: "art_f",
            type: "FINDINGS",
            deduped: false,
            taskId: "task_1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      ...extra,
    });
  }

  it("OFFERS a card and writes nothing without --yes", async () => {
    let connected = 0;
    const d = findingsPush({
      connect: (async () => {
        connected += 1;
        return {
          caller: {
            callTool: async ({ name }: { name: string }) => {
              if (name === "get_task") {
                return {
                  structuredContent: { workspaceId: "ws_1", key: "STA-1" },
                };
              }
              if (name === "list_boards") {
                return {
                  structuredContent: {
                    boards: [
                      {
                        id: "b_bugs",
                        name: "Issues",
                        kind: "BUGS",
                        archivedAt: null,
                      },
                    ],
                  },
                };
              }
              if (name === "list_columns") {
                return {
                  structuredContent: {
                    columns: [{ id: "col_triage", name: "Triage" }],
                  },
                };
              }
              throw new Error(`unexpected tool ${name}`);
            },
          },
          close: async () => undefined,
        };
      }) as unknown as PushDeps["connect"],
    });
    const code = await runPush("findings", undefined, { task: "task_1" }, d);
    assert.equal(code, 0);
    const err = d.err.join("\n");
    assert.match(err, /findings pushes usually become issues/);
    assert.match(err, /Issues/);
    assert.match(err, /Nothing was created/);
    assert.ok(connected > 0, "it looked for a board");
  });

  it("offers the anchor task's OWN board when the workspace has no BUGS board (taxonomy AC3.2/D7)", async () => {
    const d = findingsPush({
      connect: (async () => ({
        caller: {
          callTool: async ({ name }: { name: string }) => {
            if (name === "get_task") {
              return {
                structuredContent: {
                  workspaceId: "ws_1",
                  key: "STA-1",
                  boardId: "b_work",
                  boardName: "Work",
                },
              };
            }
            if (name === "list_boards") {
              return {
                structuredContent: {
                  boards: [
                    {
                      id: "b_work",
                      name: "Work",
                      kind: "TASKS",
                      archivedAt: null,
                    },
                  ],
                },
              };
            }
            if (name === "list_columns") {
              return {
                structuredContent: {
                  columns: [{ id: "col_w1", name: "Backlog" }],
                },
              };
            }
            throw new Error(`unexpected tool ${name}`);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runPush("findings", undefined, { task: "task_1" }, d);
    assert.equal(code, 0);
    // The offer names the FALLBACK board — and still writes nothing.
    assert.match(d.err.join("\n"), /opens a card on Work/);
    assert.match(d.err.join("\n"), /Nothing was created/);
  });

  it("says so and SKIPS when no board can take a card (D7 last rung)", async () => {
    // It never invents a board or a column: a board created by a side effect
    // is a board nobody agreed to.
    const d = findingsPush({
      connect: (async () => ({
        caller: {
          callTool: async ({ name }: { name: string }) => {
            if (name === "get_task") {
              return {
                structuredContent: { workspaceId: "ws_1", key: "STA-1" },
              };
            }
            if (name === "list_boards") {
              return { structuredContent: { boards: [] } };
            }
            throw new Error(`unexpected tool ${name}`);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    const code = await runPush("findings", undefined, { task: "task_1" }, d);
    assert.equal(code, 0);
    assert.match(d.err.join("\n"), /no board can take a card/i);
  });

  it("offers a card after push gap and push issue too (taxonomy AC3.1)", async () => {
    for (const kind of ["gap", "issue"] as const) {
      const d = deps({
        readStdin: async () => "left undone",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              artifactId: "art_x",
              type: kind.toUpperCase(),
              deduped: false,
              taskId: "task_1",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
        connect: (async () => ({
          caller: {
            callTool: async ({ name }: { name: string }) => {
              if (name === "get_task") {
                return {
                  structuredContent: { workspaceId: "ws_1", key: "STA-1" },
                };
              }
              if (name === "list_boards") {
                return {
                  structuredContent: {
                    boards: [
                      {
                        id: "b_bugs",
                        name: "Issues",
                        kind: "BUGS",
                        archivedAt: null,
                      },
                    ],
                  },
                };
              }
              if (name === "list_columns") {
                return {
                  structuredContent: {
                    columns: [{ id: "col_triage", name: "Triage" }],
                  },
                };
              }
              throw new Error(`unexpected tool ${name}`);
            },
          },
          close: async () => undefined,
        })) as unknown as PushDeps["connect"],
      });
      const code = await runPush(kind, undefined, { task: "task_1" }, d);
      assert.equal(code, 0, kind);
      const err = d.err.join("\n");
      assert.match(err, /pushes usually become follow-up cards/);
      assert.match(err, /Nothing was created/);
      assert.match(err, /--blocks/);
    }
  });

  it("never costs the operator their push when the offer fails (AC7.8)", async () => {
    const d = findingsPush({
      connect: (async () => {
        throw new Error("the deployment is unreachable");
      }) as unknown as PushDeps["connect"],
    });
    const code = await runPush("findings", undefined, { task: "task_1" }, d);
    // The artifact is already durable; a failed convenience is a note.
    assert.equal(code, 0);
    assert.match(d.err.join("\n"), /could not offer a card/);
    assert.match(d.out.join("\n"), /Pushed findings/);
  });

  it("threads the VALIDATED session correlation into the mint's writes (STA-26)", async () => {
    // A --session push whose --yes mint must carry X-Stacks-Session-Id on the
    // MCP connection, so the minted card's TASK_CREATED payload names the
    // session and the RUN_SUMMARY's "Work created" section lists the card.
    const targets: Array<{ sessionId?: string }> = [];
    const d = findingsPush({
      fetchImpl: (async (url: URL | string) =>
        new Response(
          JSON.stringify(
            String(url).includes("/api/agent-sessions/")
              ? {
                  artifactId: "art_f",
                  type: "FINDINGS",
                  deduped: false,
                  taskId: "task_1",
                }
              : { artifactId: "art_f", taskId: "issue_1", created: true },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      connect: (async (target: { sessionId?: string }) => {
        targets.push(target);
        return {
          caller: {
            callTool: async ({ name }: { name: string }) => {
              if (name === "get_task") {
                return {
                  structuredContent: { workspaceId: "ws_1", key: "STA-1" },
                };
              }
              if (name === "list_boards") {
                return {
                  structuredContent: {
                    boards: [
                      {
                        id: "b_bugs",
                        name: "Issues",
                        kind: "BUGS",
                        archivedAt: null,
                      },
                    ],
                  },
                };
              }
              if (name === "list_columns") {
                return {
                  structuredContent: {
                    columns: [{ id: "col_triage", name: "Triage" }],
                  },
                };
              }
              if (name === "create_task") {
                return { structuredContent: { id: "issue_1", key: "BUG-1" } };
              }
              if (name === "add_task_link") {
                return { structuredContent: { ok: true } };
              }
              throw new Error(`unexpected tool ${name}`);
            },
          },
          close: async () => undefined,
        };
      }) as unknown as PushDeps["connect"],
    });
    const code = await runPush(
      "findings",
      undefined,
      { session: "ses_live", yes: true },
      d,
    );
    assert.equal(code, 0);
    assert.match(d.out.join("\n"), /Minted BUG-1/);
    // The mint's write connection carried the session id; the board lookup
    // stayed plain (reads need no correlation).
    const mint = targets.find((t) => t.sessionId !== undefined);
    assert.ok(mint, "some connection carried the session correlation");
    assert.equal(mint!.sessionId, "ses_live");
  });

  it("prints the hint as the REGISTERED command (F1: no advertised ghost)", async () => {
    const d = findingsPush({
      connect: (async () => ({
        caller: {
          callTool: async ({ name }: { name: string }) => {
            if (name === "get_task") {
              return { structuredContent: { workspaceId: "ws_1" } };
            }
            if (name === "list_boards") {
              return {
                structuredContent: {
                  boards: [
                    { id: "b", name: "Issues", kind: "BUGS", archivedAt: null },
                  ],
                },
              };
            }
            if (name === "list_columns") {
              return {
                structuredContent: { columns: [{ id: "c", name: "Triage" }] },
              };
            }
            throw new Error(`unexpected tool ${name}`);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    await runPush("findings", undefined, { task: "task_1" }, d);
    assert.match(
      d.err.join("\n"),
      /jentrix artifact mint-issue --artifact art_f --from-task task_1/,
    );
    // …and the registered subcommand carries exactly the flags the hint names.
    const artifact = new Command("stacks").command("artifact");
    registerMintIssueCommand(artifact, d, () => undefined);
    const mint = artifact.commands.find((c) => c.name() === "mint-issue");
    assert.ok(mint, "mint-issue is registered on the artifact group");
    const flags = mint!.options.map((o) => o.long);
    assert.ok(flags.includes("--artifact"));
    assert.ok(flags.includes("--from-task"));
    assert.ok(flags.includes("--session"));
    assert.equal(
      mintIssueCommandHint("A", "T"),
      "jentrix artifact mint-issue --artifact A --from-task T",
    );
    // JEN-274: the hint of a --session-addressed push carries the session.
    assert.equal(
      mintIssueCommandHint("A", "T", "S"),
      "jentrix artifact mint-issue --artifact A --from-task T --session S",
    );
  });

  // JEN-274 — a push addressed with --session <id> (no marker) prints a mint
  // command that carries the session; running it mints a correlated card.
  it("a --session-addressed push prints a mint hint carrying --session <id> (JEN-274)", async () => {
    const d = deps({
      readStdin: async () => "a gap",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            artifactId: "art_g",
            type: "GAP",
            deduped: false,
            taskId: "task_1",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      connect: (async () => ({
        caller: {
          callTool: async ({ name }: { name: string }) => {
            if (name === "get_task") {
              return {
                structuredContent: { workspaceId: "ws_1", key: "STA-1" },
              };
            }
            if (name === "list_boards") {
              return {
                structuredContent: {
                  boards: [
                    { id: "b", name: "Bugs", kind: "BUGS", archivedAt: null },
                  ],
                },
              };
            }
            if (name === "list_columns") {
              return {
                structuredContent: { columns: [{ id: "c", name: "Triage" }] },
              };
            }
            throw new Error(`unexpected tool ${name}`);
          },
        },
        close: async () => undefined,
      })) as unknown as PushDeps["connect"],
    });
    await runPush("gap", undefined, { session: "ses_addr" }, d);
    assert.match(
      d.err.join("\n"),
      /jentrix artifact mint-issue --artifact art_g --from-task task_1 --session ses_addr/,
    );
  });

  it("makes NO offer for a kind that is not findings", async () => {
    let connected = 0;
    const d = findingsPush({
      connect: (async () => {
        connected += 1;
        throw new Error("should not be reached");
      }) as unknown as PushDeps["connect"],
    });
    await runPush("report", undefined, { task: "task_1" }, d);
    assert.equal(connected, 0);
  });
});
