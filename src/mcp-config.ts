/**
 * `./.mcp.json` — the checkout's agent-tool endpoint (2026-08-11 gap report
 * F2). PURE: plan here, write in align.
 *
 * An aligned session with no MCP server for its own deployment is not merely
 * toolless — the inherited configuration points its `create_task` /
 * `move_task` / `create_comment` at PRODUCTION, so it writes confidently into
 * the wrong workspace. Align resolves an endpoint; the checkout should use
 * that one.
 *
 * The one hard rule: **no credential ever reaches this file.** It lives at a
 * committable path, so there is no mode in which a token is inlined — not a
 * literal bearer, not an expanded value, not a fallback when a variable is
 * unset.
 *
 * There are two ways to satisfy that rule, and the DEFAULT changed on
 * 2026-08-12. Writing `Bearer ${STACKS_TOKEN}` keeps the secret out of the
 * file, but it also DISABLES the client's OAuth fallback — a client that
 * finds an Authorization header stops discovering the authorization server —
 * and it leaves the operator needing a PAT the CLI can neither mint nor
 * export. So the default now writes NO header at all: the client discovers
 * Jentrix's own AS and runs the flow itself, which needs no second credential
 * and rotates on its own. `--pat` restores the template for a headless
 * context (CI, a runner, a container with no browser) that cannot complete an
 * interactive flow.
 */

export type McpConfigAction = "create" | "update" | "repoint" | "unchanged";

/**
 * The server key this module authors, and the pre-rename key it ADOPTS.
 *
 * Adoption, not coexistence: a checkout aligned before the rename has a
 * `stacks` entry, and simply writing a second `jentrix` entry beside it would
 * leave the agent with two live servers — a duplicated tool surface, and worse,
 * an unmanaged `stacks` entry that this module would stop repointing. That is
 * exactly the F2 failure this file exists to prevent (the checkout's agent
 * silently answering from another deployment). So a legacy entry is renamed in
 * place: its url, type, and any operator-set extras carry over, and the old key
 * is removed in the same write.
 */
export const MCP_SERVER_KEY = "jentrix";
export const LEGACY_MCP_SERVER_KEY = "stacks";

export interface McpServerEntry {
  type: string;
  url: string;
  /** Absent in OAuth mode — its presence is what suppresses client OAuth. */
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpConfigDocument {
  mcpServers: Record<string, McpServerEntry | Record<string, unknown>>;
  [key: string]: unknown;
}

export interface McpConfigPlan {
  action: McpConfigAction;
  /** The endpoint the existing managed entry named, when it named another. */
  previousUrl: string | null;
  /**
   * Whether this plan RENAMES a pre-rename `stacks` entry to `jentrix`.
   * Disclosed for the same reason `removedAuthorization` is: the operator's
   * committable file changes shape, and the agent's tool names change with it
   * (`mcp__stacks__*` → `mcp__jentrix__*`) at the next session start.
   */
  migratedLegacyKey: boolean;
  /**
   * Whether this plan STRIPS an Authorization header the file already had.
   * Disclosed rather than done quietly: a header written by an earlier CLI is
   * exactly what keeps the OAuth path switched off, so removing it is the
   * repair — but it is still the operator's file changing under them.
   */
  removedAuthorization: boolean;
  /** The whole document to write — every other key and server preserved. */
  next: McpConfigDocument & {
    mcpServers: Record<typeof MCP_SERVER_KEY, McpServerEntry>;
  };
}

/** The ONLY Authorization value this module can produce. */
export function bearerTemplate(envVar: string): string {
  return `Bearer \${${envVar}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Plan the managed server entry over whatever the checkout already has.
 * Merge, never clobber: unrelated servers and unrelated top-level keys are
 * carried through verbatim, and only the managed entry is authored.
 *
 * A pre-rename `stacks` entry is treated as THE managed entry and renamed to
 * `jentrix` in place, so a checkout ends with one server rather than two.
 *
 * `envVar` null selects OAuth mode (no Authorization header); a string writes
 * the `Bearer ${VAR}` template for that variable.
 */
export function planMcpServerEntry(
  existing: unknown,
  url: string,
  envVar: string | null,
): McpConfigPlan {
  const doc = isRecord(existing) ? existing : {};
  const servers = isRecord(doc.mcpServers) ? { ...doc.mcpServers } : {};
  const own = isRecord(servers[MCP_SERVER_KEY])
    ? (servers[MCP_SERVER_KEY] as Record<string, unknown>)
    : null;
  const legacy = isRecord(servers[LEGACY_MCP_SERVER_KEY])
    ? (servers[LEGACY_MCP_SERVER_KEY] as Record<string, unknown>)
    : null;
  // Prefer our own key; otherwise adopt the pre-rename one. When BOTH exist
  // the canonical entry wins and the legacy duplicate is dropped, which is the
  // only reading that converges on one server.
  const current = own ?? legacy;
  const migratedLegacyKey = legacy !== null;
  const currentUrl = typeof current?.url === "string" ? current.url : null;
  const currentHeaders = isRecord(current?.headers) ? current.headers : null;
  const currentAuth = currentHeaders?.Authorization;
  const authorization = envVar === null ? null : bearerTemplate(envVar);

  // Only OUR key is dropped; an operator's other headers survive.
  const headers: Record<string, unknown> = { ...(currentHeaders ?? {}) };
  if (authorization === null) delete headers.Authorization;
  else headers.Authorization = authorization;
  const removedAuthorization =
    authorization === null && currentAuth !== undefined;

  let action: McpConfigAction;
  if (!current) {
    action = "create";
  } else if (migratedLegacyKey && !own) {
    // The key itself is changing, so the file is never "unchanged" — call it an
    // update unless the endpoint is also wrong, which stays the louder repoint.
    action = currentUrl !== url ? "repoint" : "update";
  } else if (currentUrl !== url) {
    // The F2 shape: this checkout's agent is pointed at another deployment.
    action = "repoint";
  } else if (currentAuth !== (authorization ?? undefined)) {
    // Same endpoint, different header — including a literal bearer someone
    // pasted in, and including a template this mode no longer wants.
    action = "update";
  } else {
    action = "unchanged";
  }

  const entry: McpServerEntry = {
    // Preserve any extra keys the operator set (timeouts, notes) — only the
    // endpoint and the header are ours.
    ...(current ?? {}),
    type: typeof current?.type === "string" ? current.type : "http",
    url,
  };
  // An empty headers object would be harmless but noisy; omit it entirely so
  // the OAuth-mode file is the minimal thing a reader can check at a glance.
  if (Object.keys(headers).length > 0) entry.headers = headers;
  else delete entry.headers;

  const nextServers: Record<string, unknown> = {
    ...servers,
    [MCP_SERVER_KEY]: entry,
  };
  // The adoption: one server, under the canonical key.
  if (migratedLegacyKey) delete nextServers[LEGACY_MCP_SERVER_KEY];

  return {
    action,
    previousUrl: action === "repoint" ? currentUrl : null,
    removedAuthorization,
    migratedLegacyKey,
    next: { ...doc, mcpServers: nextServers } as McpConfigPlan["next"],
  };
}

export function renderMcpConfig(doc: McpConfigDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * How to actually make the written file work.
 *
 * In OAuth mode there is nothing to arrange — which is the point, and worth
 * saying plainly, because every earlier version of this hint ended in a
 * manual step. In `--pat` mode the manual step is real and the hint must name
 * a PAT: the earlier wording pointed at `jentrix login`, which mints a
 * ROTATING OAuth token, so an exported copy dies at the next rotation as a
 * confusing 401. That cost a real verification run a round trip on
 * 2026-08-11.
 */
export function mcpActivationHint(envVar: string | null, url: string): string {
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  })();
  if (envVar === null) {
    return [
      `No credential is written, and none needs to be exported.`,
      `The agent authenticates with ${origin} itself: start it, then approve the`,
      `Jentrix consent screen (in Claude Code: /mcp → jentrix → Authenticate).`,
      `MCP servers load at session start, so a session already running when this`,
      `file changed must be restarted before it sees the server.`,
    ].join("\n");
  }
  return [
    `The file is inert until ${envVar} is exported — the token is NEVER written into it.`,
    `Mint a PAT (scopes read+write) at ${origin}/account/tokens and export it BEFORE starting the agent:`,
    `  export ${envVar}='tm_…'`,
    `MCP servers load at session start, so exporting it inside a running session does nothing — relaunch.`,
    `Do not use the CLI's stored login token here: it rotates, and an exported copy dies at the next rotation.`,
  ].join("\n");
}
