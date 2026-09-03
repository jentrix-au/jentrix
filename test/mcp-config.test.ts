/**
 * F2 (2026-08-11 MVP gap report) — an aligned session had no MCP path to the
 * deployment it had just aligned to: both in-session servers answered with
 * production while the CLI was pinned to stacks-mvp, so `create_task` /
 * `move_task` / `create_comment` issued through the agent's own tools would
 * land in a different deployment entirely.
 *
 * The file sits at a COMMITTABLE path (`~/test-1` has no .gitignore and
 * `git check-ignore .mcp.json` reports it un-ignored), so every byte written
 * there is treated as public: the Authorization header is the `${VAR}`
 * template proven in this repo's own .mcp.json, and nothing else.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planMcpServerEntry, renderMcpConfig } from "../src/mcp-config";

const URL = "https://stacks-mvp.vercel.app/api/mcp";

describe("planMcpServerEntry", () => {
  it("plans a fresh write when the checkout has no .mcp.json", () => {
    const plan = planMcpServerEntry(null, URL, "STACKS_TOKEN");
    assert.equal(plan.action, "create");
    assert.equal(plan.previousUrl, null);
    assert.deepEqual(plan.next.mcpServers, {
      jentrix: {
        type: "http",
        url: URL,
        headers: { Authorization: "Bearer ${STACKS_TOKEN}" },
      },
    });
  });

  it("MERGES: an unrelated server survives untouched", () => {
    const existing = {
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp"] },
      },
    };
    const plan = planMcpServerEntry(existing, URL, "STACKS_TOKEN");
    assert.equal(plan.action, "create");
    assert.deepEqual(plan.next.mcpServers.playwright, {
      command: "npx",
      args: ["@playwright/mcp"],
    });
    assert.equal(plan.next.mcpServers.jentrix.url, URL);
  });

  it("preserves unrelated top-level keys", () => {
    const plan = planMcpServerEntry(
      { $schema: "x", mcpServers: {} },
      URL,
      "STACKS_TOKEN",
    );
    assert.equal(plan.next.$schema, "x");
  });

  it("REPOINTS an entry naming another deployment — that IS F2", () => {
    const existing = {
      mcpServers: {
        jentrix: {
          type: "http",
          url: "https://tm.jentrix.ai/api/mcp",
          headers: { Authorization: "Bearer ${STACKS_TOKEN}" },
        },
      },
    };
    const plan = planMcpServerEntry(existing, URL, "STACKS_TOKEN");
    assert.equal(plan.action, "repoint");
    assert.equal(plan.previousUrl, "https://tm.jentrix.ai/api/mcp");
    assert.equal(plan.next.mcpServers.jentrix.url, URL);
  });

  it("is a no-op when the entry already names this deployment", () => {
    const existing = {
      mcpServers: {
        jentrix: {
          type: "http",
          url: URL,
          headers: { Authorization: "Bearer ${STACKS_TOKEN}" },
        },
      },
    };
    assert.equal(
      planMcpServerEntry(existing, URL, "STACKS_TOKEN").action,
      "unchanged",
    );
  });

  // Jentrix rename (STA-88). A checkout aligned before the rename has a
  // `jentrix` entry. Writing a second `jentrix` entry beside it would leave the
  // agent with two servers for one deployment — a duplicated tool surface, and
  // an unmanaged `jentrix` entry this module would never repoint again, which is
  // precisely the F2 failure above. So the legacy entry is ADOPTED, not joined.
  it("ADOPTS a pre-rename stacks entry instead of writing a second server", () => {
    const existing = {
      mcpServers: {
        stacks: { type: "http", url: URL, timeout: 30 },
        playwright: { command: "npx" },
      },
    };
    const plan = planMcpServerEntry(existing, URL, null);

    assert.equal(plan.migratedLegacyKey, true);
    // Exactly one of ours, under the canonical key — the old key is gone, so a
    // later run has a single entry to keep pointed at the right deployment.
    assert.equal("stacks" in plan.next.mcpServers, false);
    assert.equal(plan.next.mcpServers.jentrix.url, URL);
    // Operator-set extras ride along; unrelated servers are untouched.
    assert.equal(plan.next.mcpServers.jentrix.timeout, 30);
    assert.deepEqual(plan.next.mcpServers.playwright, { command: "npx" });
    // The key changed, so this is never "unchanged" — the file really differs.
    assert.equal(plan.action, "update");
  });

  it("still reports the louder repoint when an adopted entry is ALSO stale", () => {
    const existing = {
      mcpServers: {
        stacks: { type: "http", url: "https://tm.jentrix.ai/api/mcp" },
      },
    };
    const plan = planMcpServerEntry(existing, URL, null);
    assert.equal(plan.action, "repoint");
    assert.equal(plan.previousUrl, "https://tm.jentrix.ai/api/mcp");
    assert.equal(plan.migratedLegacyKey, true);
    assert.equal(plan.next.mcpServers.jentrix.url, URL);
  });

  it("drops the legacy duplicate when BOTH keys are present", () => {
    const existing = {
      mcpServers: {
        jentrix: { type: "http", url: URL },
        stacks: { type: "http", url: "https://tm.jentrix.ai/api/mcp" },
      },
    };
    const plan = planMcpServerEntry(existing, URL, null);
    // The canonical entry is authoritative; the stale duplicate is removed
    // rather than repointed, so the checkout converges on one server.
    assert.equal("stacks" in plan.next.mcpServers, false);
    assert.equal(plan.next.mcpServers.jentrix.url, URL);
    assert.equal(plan.previousUrl, null);
  });

  it("REWRITES a literal bearer someone left in the file", () => {
    // Not merely tolerated: a literal credential at a committable path is the
    // thing this slice exists to never produce, so finding one is a reason to
    // replace it, and the plan must report a change so the card discloses it.
    const existing = {
      mcpServers: {
        jentrix: {
          type: "http",
          url: URL,
          headers: { Authorization: "Bearer tmo_realtokenvalue" },
        },
      },
    };
    const plan = planMcpServerEntry(existing, URL, "STACKS_TOKEN");
    assert.equal(plan.action, "update");
    assert.equal(
      plan.next.mcpServers.jentrix.headers?.Authorization,
      "Bearer ${STACKS_TOKEN}",
    );
  });

  it("NEVER writes a credential, whatever it is handed", () => {
    for (const envVar of ["STACKS_TOKEN", "WHATEVER"]) {
      const rendered = renderMcpConfig(
        planMcpServerEntry(null, URL, envVar).next,
      );
      assert.match(rendered, /\$\{/, "the header stays an env template");
      assert.doesNotMatch(rendered, /tmo_|tmr_|tm_[a-zA-Z0-9]{8}/);
    }
  });
});

// ---------------------------------------------------------------------------
// OAuth mode (2026-08-12), now the DEFAULT. Writing an Authorization header —
// even a `${VAR}` template — makes the client stop discovering the
// authorization server, so the header was the very thing keeping every MCP
// client off the OAuth path and on a PAT the CLI can neither mint nor export.
// `envVar: null` writes no header at all.
// ---------------------------------------------------------------------------

describe("planMcpServerEntry — OAuth mode", () => {
  it("writes NO Authorization header at all", () => {
    const plan = planMcpServerEntry(null, URL, null);
    assert.equal(plan.action, "create");
    assert.deepEqual(plan.next.mcpServers.jentrix, { type: "http", url: URL });
    assert.equal("headers" in plan.next.mcpServers.jentrix, false);
  });

  it("STRIPS a template header an earlier CLI wrote — that header is the defect", () => {
    const existing = {
      mcpServers: {
        jentrix: {
          type: "http",
          url: URL,
          headers: { Authorization: "Bearer ${STACKS_TOKEN}" },
        },
      },
    };
    const plan = planMcpServerEntry(existing, URL, null);
    assert.equal(plan.action, "update");
    assert.equal(plan.removedAuthorization, true);
    assert.equal("headers" in plan.next.mcpServers.jentrix, false);
  });

  it("strips a literal bearer too, and reports it", () => {
    const existing = {
      mcpServers: {
        jentrix: {
          type: "http",
          url: URL,
          headers: { Authorization: "Bearer tmo_realtokenvalue" },
        },
      },
    };
    const plan = planMcpServerEntry(existing, URL, null);
    assert.equal(plan.removedAuthorization, true);
    assert.doesNotMatch(renderMcpConfig(plan.next), /tmo_/);
  });

  it("drops ONLY Authorization — an operator's other headers survive", () => {
    const existing = {
      mcpServers: {
        jentrix: {
          type: "http",
          url: URL,
          headers: { Authorization: "Bearer ${STACKS_TOKEN}", "X-Trace": "on" },
        },
      },
    };
    const plan = planMcpServerEntry(existing, URL, null);
    assert.deepEqual(plan.next.mcpServers.jentrix.headers, { "X-Trace": "on" });
  });

  it("is a no-op on a file already in OAuth shape", () => {
    const existing = { mcpServers: { jentrix: { type: "http", url: URL } } };
    const plan = planMcpServerEntry(existing, URL, null);
    assert.equal(plan.action, "unchanged");
    assert.equal(plan.removedAuthorization, false);
  });

  it("reports removedAuthorization false when there was nothing to remove", () => {
    assert.equal(
      planMcpServerEntry(null, URL, null).removedAuthorization,
      false,
    );
  });

  it("still never writes a credential", () => {
    const rendered = renderMcpConfig(planMcpServerEntry(null, URL, null).next);
    assert.doesNotMatch(rendered, /tmo_|tmr_|tm_[a-zA-Z0-9]{8}|Authorization/);
  });
});

describe("renderMcpConfig", () => {
  it("renders stable, newline-terminated JSON", () => {
    const rendered = renderMcpConfig(
      planMcpServerEntry(null, URL, "STACKS_TOKEN").next,
    );
    assert.equal(rendered.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(rendered).mcpServers.jentrix.url, URL);
  });
});

// ---------------------------------------------------------------------------
// The activation guidance (2026-08-11 follow-up). The file align writes is
// INERT by default, and the CLI structurally cannot make it live: it will not
// inline the token (the path is committable) and it cannot set a variable in
// the operator's shell. So the guidance IS the feature — and it pointed at the
// wrong credential type, which cost a real verification run a round trip.
// ---------------------------------------------------------------------------

import { mcpActivationHint } from "../src/mcp-config";

describe("mcpActivationHint", () => {
  const url = "https://stacks-mvp.vercel.app/api/mcp";

  it("names a PAT and where to mint it — not `jentrix login`", () => {
    const hint = mcpActivationHint("STACKS_TOKEN", url);
    assert.match(hint, /STACKS_TOKEN/);
    assert.match(hint, /account\/tokens/);
    assert.match(hint, /stacks-mvp\.vercel\.app/);
    // `jentrix login` mints a ROTATING OAuth token; an exported copy dies at the
    // next rotation, mid-session, as a confusing 401. Recommending it here was
    // the defect.
    assert.doesNotMatch(hint, /jentrix login/);
  });

  it("says the token is never written into the file", () => {
    assert.match(mcpActivationHint("STACKS_TOKEN", url), /never/i);
  });

  it("says plainly that this is a step the CLI cannot do", () => {
    // Otherwise the operator reads a green line and still has no working tools.
    assert.match(
      mcpActivationHint("STACKS_TOKEN", url),
      /before .*start|relaunch|new session/i,
    );
  });

  it("carries no credential of its own", () => {
    assert.doesNotMatch(
      mcpActivationHint("STACKS_TOKEN", url),
      /tmo_|tmr_|tm_[A-Za-z0-9]{10}/,
    );
  });

  it("OAuth mode names no PAT and no variable — there is nothing to arrange", () => {
    const hint = mcpActivationHint(null, url);
    assert.doesNotMatch(hint, /STACKS_TOKEN|account\/tokens|PAT/);
    assert.match(hint, /Authenticate/);
    // The one thing that IS still required of the operator.
    assert.match(hint, /restart/i);
  });
});
