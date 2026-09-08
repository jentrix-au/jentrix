/**
 * `jentrix mcp status|enable|disable <claude|codex>` — provider-native MCP,
 * optional and EXPLICIT (client-runtime v2 D11/§15.5). Separate from folder
 * and session alignment (R14): enabling gives the agent Jentrix TOOLS;
 * connect/align never write MCP config (D14).
 *
 * Claude Code reads `./.mcp.json` in the checkout — managed here in full.
 * Codex registers through its OWN CLI (`codex mcp add` runs an interactive
 * OAuth approval that must not be driven blind), so enable/disable print the
 * exact command while status reads the config honestly.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { EXIT_CODES } from "../errors";
import { planMcpServerEntry, renderMcpConfig } from "../mcp-config";
import { reportError } from "../session/runtime";
import { UsageError } from "../tool-client";
import { type SessionCommandDeps } from "../session/deps";

type McpProvider = "claude" | "codex";

function assertProvider(value: string): McpProvider {
  if (value === "claude" || value === "codex") return value;
  throw new UsageError("provider must be claude or codex");
}

function claudeConfigPath(deps: SessionCommandDeps): string {
  return join(deps.cwd(), ".mcp.json");
}

function codexConfigPath(): string {
  return join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml",
  );
}

function codexEntryOf(config: string | null): "jentrix" | "stacks" | null {
  if (!config) return null;
  if (/^\[mcp_servers\.jentrix\]/m.test(config)) return "jentrix";
  if (/^\[mcp_servers\.stacks\]/m.test(config)) return "stacks";
  return null;
}

export async function runMcpStatus(
  provider: McpProvider,
  flags: { json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  if (provider === "claude") {
    const path = claudeConfigPath(deps);
    let url: string | null = null;
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as {
          mcpServers?: Record<string, { url?: string }>;
        };
        url =
          parsed.mcpServers?.jentrix?.url ??
          parsed.mcpServers?.stacks?.url ??
          null;
      } catch {
        url = null;
      }
    }
    if (flags.json) {
      deps.writeOut(
        JSON.stringify({ provider, registered: url !== null, url }),
      );
    } else {
      deps.writeOut(
        url
          ? `Claude native MCP: registered → ${url} (${path}). Auth is the client's own OAuth consent — a session that has not approved it simply has no jentrix tools (D12: registration ≠ authentication).`
          : `Claude native MCP: not registered (no jentrix entry in ${path}). Enable with: jentrix mcp enable claude`,
      );
    }
    return EXIT_CODES.OK;
  }
  const path = codexConfigPath();
  const entry = codexEntryOf(
    existsSync(path) ? readFileSync(path, "utf8") : null,
  );
  if (flags.json) {
    deps.writeOut(
      JSON.stringify({ provider, registered: entry !== null, entry }),
    );
  } else {
    deps.writeOut(
      entry
        ? `Codex native MCP: registered as [mcp_servers.${entry}] in ${path}. Auth is Codex's own (codex mcp login ${entry}) — reported separately from registration (D12).`
        : `Codex native MCP: not registered in ${path}. Enable with: jentrix mcp enable codex`,
    );
  }
  return EXIT_CODES.OK;
}

export async function runMcpEnable(
  provider: McpProvider,
  flags: { url?: string; yes?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    const url = flags.url ?? deps.resolveTarget().url;
    if (provider === "claude") {
      const path = claudeConfigPath(deps);
      let existing: unknown = null;
      if (existsSync(path)) {
        try {
          existing = JSON.parse(readFileSync(path, "utf8"));
        } catch {
          throw new UsageError(
            `${path} is not valid JSON — fix or remove it, then retry`,
          );
        }
      }
      const plan = planMcpServerEntry(existing, url, null);
      if (plan.action === "unchanged") {
        deps.writeOut(`./.mcp.json already names ${url}.`);
        return EXIT_CODES.OK;
      }
      writeFileSync(path, renderMcpConfig(plan.next));
      deps.writeOut(
        `Wrote ${path} → ${url} (Claude Code reads it at session start; no credential inside — the client's OAuth consent authorizes).`,
      );
      return EXIT_CODES.OK;
    }
    // Codex: its `mcp add` runs an interactive OAuth approval — never driven
    // blind from here. Print the exact command instead.
    deps.writeOut(
      [
        "Codex registers native MCP through its own CLI (interactive OAuth approval):",
        `  codex mcp add jentrix --url ${url}`,
        "  codex mcp login jentrix",
        "(or re-run `jentrix setup --native-mcp`, which walks it with the plugin install)",
      ].join("\n"),
    );
    return EXIT_CODES.OK;
  } catch (error) {
    return reportError(error, deps);
  }
}

export async function runMcpDisable(
  provider: McpProvider,
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    if (provider === "claude") {
      const path = claudeConfigPath(deps);
      if (!existsSync(path)) {
        deps.writeOut("Nothing to disable — no ./.mcp.json here.");
        return EXIT_CODES.OK;
      }
      let parsed: { mcpServers?: Record<string, unknown> };
      try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as {
          mcpServers?: Record<string, unknown>;
        };
      } catch {
        throw new UsageError(
          `${path} is not valid JSON — fix or remove it by hand`,
        );
      }
      const servers = { ...(parsed.mcpServers ?? {}) };
      if (!("jentrix" in servers) && !("stacks" in servers)) {
        deps.writeOut("Nothing to disable — ./.mcp.json has no jentrix entry.");
        return EXIT_CODES.OK;
      }
      delete servers.jentrix;
      delete servers.stacks;
      if (Object.keys(servers).length === 0) {
        // Only our entry lived here — remove the file, not an empty husk.
        unlinkSync(path);
        deps.writeOut(`Removed ${path} (it held only the jentrix entry).`);
      } else {
        writeFileSync(
          path,
          `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`,
        );
        deps.writeOut(
          `Removed the jentrix entry from ${path} — other servers untouched (D14).`,
        );
      }
      return EXIT_CODES.OK;
    }
    const entry = codexEntryOf(
      existsSync(codexConfigPath())
        ? readFileSync(codexConfigPath(), "utf8")
        : null,
    );
    deps.writeOut(
      entry
        ? `Codex unregisters through its own CLI:\n  codex mcp remove ${entry}`
        : "Nothing to disable — Codex has no jentrix MCP entry.",
    );
    return EXIT_CODES.OK;
  } catch (error) {
    return reportError(error, deps);
  }
}

export function registerMcpCommand(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  const mcp = program
    .command("mcp")
    .description(
      "Provider-native MCP configuration — optional and explicit; separate from folder/session alignment",
    );
  mcp
    .command("status <provider>")
    .description("Report native-MCP registration for claude|codex")
    .option("--json", "stable JSON output")
    .action(async (provider: string, options: { json?: boolean }) => {
      onExit(await runMcpStatus(assertProvider(provider), options, deps));
    });
  mcp
    .command("enable <provider>")
    .description("Register the Jentrix MCP server for claude|codex")
    .option("--url <mcp-url>", "endpoint (default: the signed-in server)")
    .option("--yes", "no confirmation prompt")
    .action(
      async (provider: string, options: { url?: string; yes?: boolean }) => {
        onExit(await runMcpEnable(assertProvider(provider), options, deps));
      },
    );
  mcp
    .command("disable <provider>")
    .description("Remove the Jentrix native-MCP registration for claude|codex")
    .option("--yes", "no confirmation prompt")
    .action(async (provider: string) => {
      onExit(await runMcpDisable(assertProvider(provider), deps));
    });
  return mcp;
}
