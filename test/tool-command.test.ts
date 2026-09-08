import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Command } from "commander";

import type { ToolCaller } from "../src/call";
import { stableStringify } from "../src/render";
import {
  registerToolCommand,
  runToolCommand,
  type ToolCommandDeps,
  type ToolCommandFlags,
} from "../src/commands/tool";

/** A success result the way the server's ok() builds it (P2.2 contract). */
function okResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(envelope: unknown) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
  };
}

interface Recorded {
  calls: { name: string; arguments?: Record<string, unknown> }[];
  out: string[];
  err: string[];
  slept: number[];
  closed: number;
  connects: { url: string; token: string; sessionId?: string }[];
}

function makeDeps(
  overrides: Partial<ToolCommandDeps> & {
    result?: unknown;
    connectError?: unknown;
  } = {},
): { deps: ToolCommandDeps; rec: Recorded } {
  const rec: Recorded = {
    calls: [],
    out: [],
    err: [],
    slept: [],
    closed: 0,
    connects: [],
  };
  const caller: ToolCaller = {
    callTool: (async (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      rec.calls.push(params);
      return overrides.result ?? okResult({ ok: true });
    }) as ToolCaller["callTool"],
  };
  const deps: ToolCommandDeps = {
    env: { STACKS_TOKEN: "tm_test_token" },
    configFile: () => null,
    knownTools: new Set([
      "list_workspaces",
      "create_task",
      "get_task",
      "update_task",
    ]),
    connect: async (target) => {
      if (overrides.connectError !== undefined) throw overrides.connectError;
      rec.connects.push(target);
      return {
        caller,
        close: async () => {
          rec.closed += 1;
        },
      };
    },
    readStdin: async () => "{}",
    readFile: () => {
      throw new Error("readFile not stubbed");
    },
    writeOut: (text) => rec.out.push(text),
    writeErr: (text) => rec.err.push(text),
    sleep: async (ms) => {
      rec.slept.push(ms);
    },
    now: () => 0,
    ...overrides,
  };
  return { deps, rec };
}

function flags(overrides: Partial<ToolCommandFlags> = {}): ToolCommandFlags {
  return { wait: true, maxWait: "60", ...overrides };
}

describe("runToolCommand — argument parsing (exit 2, nothing sent)", () => {
  it("--args with invalid JSON → exit 2, no call attempted", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "list_workspaces",
      flags({ args: "{not json" }),
      deps,
    );
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.equal(rec.connects.length, 0);
    assert.match(rec.err.join("\n"), /not valid JSON/);
  });

  it("--args that is JSON but not an object → exit 2", async () => {
    const { deps, rec } = makeDeps();
    for (const bad of ["[1,2]", "42", '"str"', "null"]) {
      const code = await runToolCommand(
        "list_workspaces",
        flags({ args: bad }),
        deps,
      );
      assert.equal(code, 2, `expected exit 2 for ${bad}`);
    }
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /must be a JSON object/);
  });

  it("--args and --args-file together → exit 2", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "list_workspaces",
      flags({ args: "{}", argsFile: "args.json" }),
      deps,
    );
    assert.equal(code, 2);
    assert.match(rec.err.join("\n"), /either --args or --args-file/);
    assert.equal(rec.calls.length, 0);
  });

  it("unreadable --args-file → exit 2 with the path in the message", async () => {
    const { deps, rec } = makeDeps({
      readFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    const code = await runToolCommand(
      "list_workspaces",
      flags({ argsFile: "missing.json" }),
      deps,
    );
    assert.equal(code, 2);
    assert.match(rec.err.join("\n"), /missing\.json/);
  });

  it("empty stdin → exit 2, not a cryptic JSON error", async () => {
    const { deps, rec } = makeDeps({ readStdin: async () => "" });
    const code = await runToolCommand(
      "list_workspaces",
      flags({ argsFile: "-" }),
      deps,
    );
    assert.equal(code, 2);
    assert.match(rec.err.join("\n"), /empty/);
  });

  it("invalid --max-wait → exit 2", async () => {
    const { deps } = makeDeps();
    for (const bad of ["abc", "-5"]) {
      const code = await runToolCommand(
        "list_workspaces",
        flags({ maxWait: bad }),
        deps,
      );
      assert.equal(code, 2, `expected exit 2 for --max-wait ${bad}`);
    }
  });
});

describe("JEN-170: a non-id workspaceId never reaches authz", () => {
  it("a slug is refused as INVALID_INPUT before anything connects", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "list_workspaces",
      flags({ args: JSON.stringify({ workspaceId: "jentrix" }) }),
      deps,
    );
    assert.equal(code, 2);
    assert.equal(rec.connects.length, 0, "nothing was sent");
    assert.equal(rec.calls.length, 0);
    const err = rec.err.join("\n");
    assert.match(err, /is not a workspace id/);
    // The false claim the bug produced must not be what the operator reads.
    assert.doesNotMatch(err, /member/i);
    // The message names both fixes.
    assert.match(err, /jentrix workspace list/);
    assert.match(err, /align --workspace <id-or-slug>/);
  });

  it("a real cuid is sent untouched — the server stays the authority", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "list_workspaces",
      flags({
        args: JSON.stringify({ workspaceId: "cmt2cuhyo000004l38ddsim1y" }),
      }),
      deps,
    );
    assert.equal(code, 0);
    assert.equal(
      rec.calls[0]?.arguments?.workspaceId,
      "cmt2cuhyo000004l38ddsim1y",
    );
  });

  it("a non-string workspaceId is left to the server's schema", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "list_workspaces",
      flags({ args: JSON.stringify({ workspaceId: 7 }) }),
      deps,
    );
    assert.equal(code, 0);
    assert.equal(rec.calls.length, 1);
  });
});

describe("runToolCommand — args sources", () => {
  it("--args-file - reads stdin", async () => {
    const { deps, rec } = makeDeps({
      readStdin: async () => '{"workspaceId":"cmws1000000000000000001"}',
    });
    const code = await runToolCommand(
      "list_workspaces",
      flags({ argsFile: "-" }),
      deps,
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.calls, [
      {
        name: "list_workspaces",
        arguments: { workspaceId: "cmws1000000000000000001" },
      },
    ]);
  });

  it("--args-file <path> reads the file", async () => {
    const { deps, rec } = makeDeps({
      readFile: (path) => {
        assert.equal(path, "args.json");
        return '{"taskId":"t1"}';
      },
    });
    const code = await runToolCommand(
      "get_task",
      flags({ argsFile: "args.json" }),
      deps,
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0]?.arguments, { taskId: "t1" });
  });

  it("no --args at all → sends {}", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0]?.arguments, {});
  });

  it("--args JSON passes through untouched (values, nesting, key strings)", async () => {
    // The SVR focus case: exact ISO strings (expectedUpdatedAt), leading-zero
    // strings, floats, nulls, nested arrays/objects must arrive verbatim.
    const raw =
      '{"expectedUpdatedAt":"2026-01-02T03:04:05.678Z","title":"01",' +
      '"priority":null,"nested":{"z":1,"a":[true,0.5,"x"]}}';
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "update_task",
      flags({ args: raw }),
      deps,
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0]?.arguments, JSON.parse(raw));
    // String-typed values stayed strings (no numeric coercion).
    assert.equal(
      rec.calls[0]?.arguments?.expectedUpdatedAt,
      "2026-01-02T03:04:05.678Z",
    );
    assert.equal(rec.calls[0]?.arguments?.title, "01");
  });
});

describe("runToolCommand — tool list (D13 intersection)", () => {
  /** A caller that also serves listTools, like the real MCP client does. */
  function listingDeps(served: string[]) {
    const { deps, rec } = makeDeps();
    const baseConnect = deps.connect;
    deps.connect = async (target) => {
      const handle = await baseConnect(target);
      return {
        ...handle,
        caller: Object.assign(Object.create(handle.caller), {
          listTools: async () => ({
            tools: served.map((name) => ({ name })),
          }),
        }) as typeof handle.caller,
      };
    };
    return { deps, rec };
  }

  it("reports the manifest ∩ endpoint intersection, sorted, with a summary", async () => {
    const { deps, rec } = listingDeps([
      "list_workspaces",
      "get_task",
      "create_work_order", // server-only: never listed
    ]);
    const code = await runToolCommand("list", flags(), deps);
    assert.equal(code, 0);
    const summary = rec.out.at(-1)!;
    assert.match(summary, /2 of 4 manifest tools/);
    const rows = rec.out.slice(0, -1);
    assert.deepEqual(rows, [
      "create_task  (not on this server)",
      "get_task",
      "list_workspaces",
      "update_task  (not on this server)",
    ]);
    assert.ok(!rec.out.join("\n").includes("create_work_order"));
  });

  it("--json emits callable/manifestOnly/counts", async () => {
    const { deps, rec } = listingDeps(["list_workspaces"]);
    const code = await runToolCommand("list", flags({ json: true }), deps);
    assert.equal(code, 0);
    const parsed = JSON.parse(rec.out[0]!) as {
      callable: string[];
      manifestOnly: string[];
      manifestCount: number;
      serverCount: number;
    };
    assert.deepEqual(parsed.callable, ["list_workspaces"]);
    assert.equal(parsed.manifestCount, 4);
    assert.equal(parsed.serverCount, 1);
    assert.deepEqual(parsed.manifestOnly, [
      "create_task",
      "get_task",
      "update_task",
    ]);
  });

  it("manifest unreadable → error naming the reinstall, nothing sent", async () => {
    const { deps, rec } = makeDeps({ knownTools: null });
    const code = await runToolCommand("list", flags(), deps);
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /manifest is unreadable/);
  });
});

describe("runToolCommand — product-manifest refusal (D8)", () => {
  it("non-manifest tool name → refused locally, nothing sent (C9 regression)", async () => {
    const { deps, rec } = makeDeps();
    const code = await runToolCommand(
      "create_work_order",
      flags({ args: "{}" }),
      deps,
    );
    assert.equal(code, 2, "refused before any call");
    assert.equal(rec.calls.length, 0, "nothing may be sent");
    const errs = rec.err.join("\n");
    assert.match(errs, /TOOL_NOT_IN_PRODUCT_MANIFEST/);
    assert.match(errs, /create_work_order/);
    // Names the operations paths and the discovery command.
    assert.doesNotMatch(errs, /jentrix-runner/);
    assert.match(errs, /jentrix tool list/);
    // D20: the count in the message is the injected manifest's size, not a
    // frozen number.
    assert.match(errs, new RegExp(`\\(${deps.knownTools!.size} tools\\)`));
  });

  it("known tool name → no refusal, no notice", async () => {
    const { deps, rec } = makeDeps();
    await runToolCommand("list_workspaces", flags(), deps);
    assert.deepEqual(rec.err, []);
  });

  it("manifest unavailable (null) refuses before configuration or connection", async () => {
    const { deps, rec } = makeDeps({ knownTools: null });
    deps.configFile = () => {
      throw new Error("must refuse before config");
    };
    deps.connect = async () => {
      throw new Error("must not connect");
    };
    const code = await runToolCommand("whatever_tool", flags(), deps);
    assert.equal(code, 2);
    assert.equal(rec.calls.length, 0);
    assert.match(rec.err.join("\n"), /PRODUCT_MANIFEST_UNAVAILABLE.*reinstall/);
  });
});

describe("runToolCommand — rendering", () => {
  const payload = { workspaces: [{ id: "w1", name: "Acme" }] };

  it("--json prints stable JSON of structuredContent", async () => {
    const { deps, rec } = makeDeps({ result: okResult(payload) });
    const code = await runToolCommand(
      "list_workspaces",
      flags({ json: true }),
      deps,
    );
    assert.equal(code, 0);
    assert.deepEqual(rec.out, [stableStringify(payload)]);
  });

  it("default mode renders the human table (not raw JSON)", async () => {
    const { deps, rec } = makeDeps({ result: okResult(payload) });
    await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(rec.out.length, 1);
    assert.match(rec.out[0], /id\s+name/);
    assert.match(rec.out[0], /w1\s+Acme/);
  });
});

describe("runToolCommand — config and auth failures", () => {
  it("no token anywhere → exit 7 with the actionable config message", async () => {
    const { deps, rec } = makeDeps({ env: {} });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 7);
    assert.equal(rec.connects.length, 0, "must fail before connecting");
    assert.match(rec.err.join("\n"), /STACKS_TOKEN/);
    assert.match(rec.err.join("\n"), /\/account\/tokens/);
  });

  it("malformed config file (lazy read) → exit 2 with the reader's message", async () => {
    const { ConfigError } = await import("../src/config");
    const { deps, rec } = makeDeps({
      env: {},
      configFile: () => {
        throw new ConfigError("config file /x is not valid JSON: boom", 2);
      },
    });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 2);
    assert.match(rec.err.join("\n"), /not valid JSON/);
  });

  it("HTTP 401 at connect → exit 7 with the dead-token message (transport layer)", async () => {
    const { deps, rec } = makeDeps({
      connectError: new Error(
        "Streamable HTTP error: Error POSTing to endpoint (HTTP 401): Unauthorized",
      ),
    });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 7);
    assert.equal(rec.calls.length, 0);
    const err = rec.err.join("\n");
    assert.match(err, /dead or expired/);
    assert.match(err, /\/account\/tokens/);
  });

  it("connection refused → exit 7 WITHOUT the dead-token message", async () => {
    const { deps, rec } = makeDeps({
      connectError: new Error("fetch failed: ECONNREFUSED 127.0.0.1:9"),
    });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 7);
    const err = rec.err.join("\n");
    assert.doesNotMatch(err, /dead or expired/);
    assert.match(err, /ECONNREFUSED/);
  });

  it("failed OAuth refresh at connect → exit 7 with the RELOGIN message, NOT mint-a-PAT [C4.2-R1-4]", async () => {
    // main.ts wraps a RefreshFailedError as a 401-shaped error carrying
    // `reloginMessage`; the command layer must prefer that remediation.
    const { deps, rec } = makeDeps({
      connectError: Object.assign(new Error("HTTP 401"), {
        code: 401,
        reloginMessage:
          "OAuth session expired and could not be refreshed — run `jentrix login` to sign in again.",
      }),
    });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 7);
    const err = rec.err.join("\n");
    assert.match(err, /run `jentrix login`/);
    // The generic mint-a-PAT dead-token message must NOT appear.
    assert.doesNotMatch(err, /mint a new PAT/);
    assert.doesNotMatch(err, /dead or expired/);
  });

  it("FORBIDDEN envelope → exit 3 (tool layer, distinct from 401 transport)", async () => {
    const { deps, rec } = makeDeps({
      result: errorResult({
        error: {
          code: "FORBIDDEN",
          message: "This token has read scope only",
          hint: "Mint a token with write scope.",
        },
      }),
    });
    const code = await runToolCommand("create_task", flags(), deps);
    assert.equal(code, 3);
    assert.match(rec.err.join("\n"), /^FORBIDDEN: This token has read scope/m);
  });

  it("never prints the token, even when a transport error echoes it", async () => {
    const secret = "tm_test_token";
    const { deps, rec } = makeDeps({
      connectError: new Error(
        `fetch failed: proxy rejected header "Bearer ${secret}"`,
      ),
    });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 7);
    const all = [...rec.err, ...rec.out].join("\n");
    assert.ok(!all.includes(secret), "token leaked into output");
    assert.match(all, /<redacted token>/);
  });
});

describe("runToolCommand — retry wiring", () => {
  const rateLimited = errorResult({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests",
      retryAfterSeconds: 3,
    },
  });

  it("default (--wait): sleeps retryAfterSeconds and retries", async () => {
    const { deps, rec } = makeDeps({ result: rateLimited });
    const code = await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(code, 6, "retries exhausted still exit 6");
    assert.deepEqual(rec.slept, [3000, 3000], "two retries by default");
    assert.equal(rec.calls.length, 3);
  });

  it("--no-wait: never sleeps, exits 6 immediately", async () => {
    const { deps, rec } = makeDeps({ result: rateLimited });
    const code = await runToolCommand(
      "list_workspaces",
      flags({ wait: false }),
      deps,
    );
    assert.equal(code, 6);
    assert.deepEqual(rec.slept, []);
    assert.equal(rec.calls.length, 1);
  });

  it("--max-wait 1: refuses a 3s wait, exits 6 without sleeping", async () => {
    const { deps, rec } = makeDeps({ result: rateLimited });
    const code = await runToolCommand(
      "list_workspaces",
      flags({ maxWait: "1" }),
      deps,
    );
    assert.equal(code, 6);
    assert.deepEqual(rec.slept, []);
  });
});

describe("runToolCommand — lifecycle", () => {
  it("closes the client after a successful call", async () => {
    const { deps, rec } = makeDeps();
    await runToolCommand("list_workspaces", flags(), deps);
    assert.equal(rec.closed, 1);
  });

  it("closes the client after an envelope error too", async () => {
    const { deps, rec } = makeDeps({
      result: errorResult({
        error: { code: "NOT_FOUND", message: "no such task" },
      }),
    });
    const code = await runToolCommand("get_task", flags(), deps);
    assert.equal(code, 4);
    assert.equal(rec.closed, 1);
  });

  it("CONFLICT envelope: current state on stdout, message on stderr, exit 5", async () => {
    const current = { id: "t1", updatedAt: "2026-07-06T00:00:00.000Z" };
    const { deps, rec } = makeDeps({
      result: errorResult({
        error: { code: "CONFLICT", message: "stale write", current },
      }),
    });
    const code = await runToolCommand("update_task", flags(), deps);
    assert.equal(code, 5);
    assert.deepEqual(rec.out, [JSON.stringify(current)]);
    assert.match(rec.err.join("\n"), /CONFLICT: stale write/);
  });
});

describe("registerToolCommand — commander wiring (parse level)", () => {
  async function parse(
    argv: string[],
    overrides: Parameters<typeof makeDeps>[0] = {},
  ): Promise<{ code: number | undefined; rec: Recorded }> {
    const { deps, rec } = makeDeps(overrides);
    const program = new Command();
    program.name("stacks").exitOverride();
    let code: number | undefined;
    registerToolCommand(program, deps, (c) => {
      code = c;
    });
    await program.parseAsync(["node", "stacks", ...argv]);
    return { code, rec };
  }

  it("jentrix tool list_workspaces --json flows flags through to the renderer", async () => {
    const payload = { workspaces: [{ id: "w1" }] };
    const { code, rec } = await parse(["tool", "list_workspaces", "--json"], {
      result: okResult(payload),
    });
    assert.equal(code, 0);
    assert.deepEqual(rec.out, [stableStringify(payload)]);
    assert.deepEqual(rec.calls, [{ name: "list_workspaces", arguments: {} }]);
  });

  it("--args '<json>' after the subcommand parses", async () => {
    const { code, rec } = await parse([
      "tool",
      "get_task",
      "--args",
      '{"taskId":"t1"}',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(rec.calls[0]?.arguments, { taskId: "t1" });
  });

  it("--no-wait reaches the retry policy", async () => {
    const { code, rec } = await parse(
      ["tool", "list_workspaces", "--no-wait"],
      {
        result: errorResult({
          error: {
            code: "RATE_LIMITED",
            message: "slow down",
            retryAfterSeconds: 2,
          },
        }),
      },
    );
    assert.equal(code, 6);
    assert.deepEqual(rec.slept, []);
    assert.equal(rec.calls.length, 1);
  });

  it("STA-59: sends the resolved session id so writes carry X-Stacks-Session-Id", async () => {
    const { deps, rec } = makeDeps({ sessionId: async () => "ses_live" });
    const code = await runToolCommand("create_task", flags(), deps);
    assert.equal(code, 0);
    assert.equal(rec.connects[0]?.sessionId, "ses_live");
  });

  it("STA-59: no session → connects UNCORRELATED, never a guessed id", async () => {
    const { deps, rec } = makeDeps({ sessionId: async () => null });
    await runToolCommand("create_task", flags(), deps);
    assert.equal(rec.connects[0]?.sessionId, undefined);
    assert.ok(!("sessionId" in (rec.connects[0] ?? {})));
  });

  it("STA-59: a failing marker read costs the call NOTHING (degrades to uncorrelated)", async () => {
    const { deps, rec } = makeDeps({
      sessionId: async () => {
        throw new Error("not a git checkout");
      },
    });
    const code = await runToolCommand("create_task", flags(), deps);
    assert.equal(code, 0);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.connects[0]?.sessionId, undefined);
  });

  it("STA-59: a build with no sessionId dep still works (the dep is optional)", async () => {
    const { deps, rec } = makeDeps();
    assert.equal(await runToolCommand("create_task", flags(), deps), 0);
    assert.equal(rec.connects[0]?.sessionId, undefined);
  });

  it("missing <name> argument → commander usage error (mapped to exit 2 by main)", async () => {
    const { deps } = makeDeps();
    const program = new Command();
    program.name("stacks").exitOverride();
    program.configureOutput({ writeErr: () => undefined });
    registerToolCommand(program, deps, () => undefined);
    await assert.rejects(
      program.parseAsync(["node", "stacks", "tool"]),
      (e: unknown) =>
        typeof e === "object" &&
        e !== null &&
        (e as { code?: string }).code === "commander.missingArgument",
    );
  });
});
