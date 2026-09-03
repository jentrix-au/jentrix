/**
 * `jentrix folder align|status|clear` — LEVEL 1 alignment (client-runtime v2
 * §11.3/§11.4, §15.2): bind one checkout to one endpoint + workspace. No
 * Project, no session, no native MCP, no token — the binding is a default
 * and a drift detector, and the server stays the only authority (D2).
 */

import { Command } from "commander";

import {
  assertBindingCurrent,
  BindingError,
  bindingPathOf,
  clearFolderBinding,
  FOLDER_NOT_ALIGNED_MESSAGE,
  normalizeEndpoint,
  readFolderBinding,
  writeFolderBinding,
  type FolderBinding,
} from "../binding";
import { EXIT_CODES } from "../errors";
import {
  callStructured,
  inspectCheckout,
  UsageError,
  withCaller,
  type SessionCommandDeps,
} from "./session";

export interface FolderAlignFlags {
  workspace?: string;
  json?: boolean;
  yes?: boolean;
}

interface WorkspaceRow {
  id: string;
  name?: string;
  slug?: string;
}

async function pickWorkspace(
  deps: SessionCommandDeps,
  rows: WorkspaceRow[],
  wanted: string | undefined,
  assumeYes: boolean,
): Promise<WorkspaceRow> {
  if (wanted) {
    const match = rows.find(
      (ws) => ws.id === wanted || ws.slug === wanted.toLowerCase(),
    );
    if (!match) {
      throw new UsageError(
        `--workspace ${wanted} matches none of your workspaces (slugs: ${
          rows
            .map((ws) => ws.slug)
            .filter(Boolean)
            .join(", ") || "none visible"
        })`,
        EXIT_CODES.NOT_FOUND,
      );
    }
    return match;
  }
  if (rows.length === 1 && rows[0]) return rows[0];
  if (!deps.isInteractive || assumeYes) {
    throw new UsageError(
      `--workspace <id-or-slug> is required here (you belong to ${rows.length} workspaces: ${rows
        .map((ws) => ws.slug ?? ws.id)
        .join(", ")})`,
    );
  }
  deps.writeOut("Which workspace should this checkout use by default?");
  rows.forEach((ws, index) => {
    deps.writeOut(`  ${index + 1}. ${ws.name ?? ws.slug ?? ws.id} (${ws.slug ?? ws.id})`);
  });
  const answer = (await deps.readLine("Workspace number: ")).trim();
  const picked = rows[Number(answer) - 1];
  if (!picked) throw new UsageError("cancelled — no workspace chosen");
  return picked;
}

export async function runFolderAlign(
  flags: FolderAlignFlags,
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    // §11.3: inspect the git root WITHOUT mutation, authenticate, list, pick,
    // confirm, write atomically, print the next step.
    const inspection = await inspectCheckout(deps);
    return await withCaller(deps, async (caller, target) => {
      const listed = await callStructured(caller, "list_workspaces", {});
      const rows = (listed.workspaces as WorkspaceRow[]) ?? [];
      if (rows.length === 0) {
        throw new UsageError(
          "this credential belongs to no workspace — create one in the app first",
          EXIT_CODES.NOT_FOUND,
        );
      }
      const picked = await pickWorkspace(deps, rows, flags.workspace, !!flags.yes);
      if (deps.isInteractive && !flags.yes && !flags.workspace) {
        const answer = await deps.readLine(
          `Bind ${inspection.repoOwnerName} → ${picked.slug ?? picked.id} on ${normalizeEndpoint(target.url)}? [Y/n] `,
        );
        if (/^n/i.test(answer.trim())) {
          throw new UsageError("cancelled — nothing written");
        }
      }
      const binding: FolderBinding = {
        version: 1,
        endpoint: normalizeEndpoint(target.url),
        workspaceId: picked.id,
        workspaceSlug: picked.slug ?? picked.id,
        repoOwnerName: inspection.repoOwnerName,
        alignedAt: new Date().toISOString(),
      };
      const path = writeFolderBinding(inspection.root, binding);
      if (flags.json) {
        deps.writeOut(JSON.stringify({ path, binding }));
      } else {
        deps.writeOut(
          `Folder aligned: ${inspection.repoOwnerName} → workspace ${binding.workspaceSlug} (${binding.workspaceId}) on ${binding.endpoint}`,
        );
        deps.writeOut(
          "Next: `jentrix session connect --provider claude|codex` from inside a provider session (or /jentrix-connect).",
        );
      }
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportFolderError(error, deps);
  }
}

export async function runFolderStatus(
  flags: { json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    const inspection = await inspectCheckout(deps);
    const binding = readFolderBinding(inspection.root);
    if (!binding) {
      if (flags.json) {
        deps.writeOut(JSON.stringify({ aligned: false }));
      } else {
        deps.writeOut(FOLDER_NOT_ALIGNED_MESSAGE);
      }
      return EXIT_CODES.OK;
    }
    // §11.4 + G9: folder facts and drift reported INDEPENDENTLY of auth and
    // session state — status never needs a network call.
    let endpointDrift: string | null = null;
    try {
      const target = deps.resolveTarget();
      if (normalizeEndpoint(target.url) !== normalizeEndpoint(binding.endpoint)) {
        endpointDrift = `active credential targets ${normalizeEndpoint(target.url)}`;
      }
    } catch {
      endpointDrift = null; // no credential configured — the binding still reports
    }
    const repoDrift =
      inspection.repoOwnerName !== binding.repoOwnerName
        ? `checkout now inspects as ${inspection.repoOwnerName}`
        : null;
    if (flags.json) {
      deps.writeOut(
        JSON.stringify({
          aligned: true,
          path: bindingPathOf(inspection.root),
          binding,
          drift: {
            endpoint: endpointDrift,
            repo: repoDrift,
          },
        }),
      );
    } else {
      deps.writeOut(
        `Folder binding: workspace ${binding.workspaceSlug} (${binding.workspaceId}) · ${binding.endpoint} · repo ${binding.repoOwnerName} · aligned ${binding.alignedAt}`,
      );
      if (endpointDrift) {
        deps.writeOut(
          `DRIFT (FOLDER_ENDPOINT_MISMATCH): ${endpointDrift} — remote mutations here will refuse until re-aligned.`,
        );
      }
      if (repoDrift) {
        deps.writeOut(
          `DRIFT (FOLDER_REPO_CHANGED): ${repoDrift} — re-run \`jentrix folder align\` to confirm the new identity.`,
        );
      }
    }
    return EXIT_CODES.OK;
  } catch (error) {
    return reportFolderError(error, deps);
  }
}

export async function runFolderClear(
  flags: { yes?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    const inspection = await inspectCheckout(deps);
    if (deps.isInteractive && !flags.yes) {
      const answer = await deps.readLine(
        "Remove this checkout's folder binding? (sessions, markers, logins and native MCP config are untouched) [y/N] ",
      );
      if (!/^y/i.test(answer.trim())) {
        deps.writeOut("cancelled — nothing removed");
        return EXIT_CODES.OK;
      }
    }
    const removed = clearFolderBinding(inspection.root);
    deps.writeOut(
      removed
        ? "Folder binding removed. (Only binding.json — logout, markers and native MCP config are separate.)"
        : "No folder binding to remove.",
    );
    return EXIT_CODES.OK;
  } catch (error) {
    return reportFolderError(error, deps);
  }
}

function reportFolderError(error: unknown, deps: SessionCommandDeps): number {
  if (error instanceof BindingError || error instanceof UsageError) {
    deps.writeErr(error.message);
    return error.exitCode;
  }
  deps.writeErr(error instanceof Error ? error.message : String(error));
  return EXIT_CODES.INTERNAL;
}

export function registerFolderCommand(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  const folder = program
    .command("folder")
    .description(
      "Folder alignment — bind THIS checkout to a Jentrix workspace (level 1 of 2; sessions align separately)",
    );
  folder
    .command("align")
    .description(
      "Bind the checkout at the git root to an endpoint + workspace (non-secret .stacks/binding.json)",
    )
    .option("--workspace <id-or-slug>", "workspace to bind (skips the picker)")
    .option("--json", "stable JSON output")
    .option("--yes", "no confirmation prompt")
    .action(async (options: FolderAlignFlags) => {
      onExit(await runFolderAlign(options, deps));
    });
  folder
    .command("status")
    .description("Show the checkout's binding and any endpoint/repo drift")
    .option("--json", "stable JSON output")
    .action(async (options: { json?: boolean }) => {
      onExit(await runFolderStatus(options, deps));
    });
  folder
    .command("clear")
    .description("Remove only the folder binding (nothing else)")
    .option("--yes", "no confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      onExit(await runFolderClear(options, deps));
    });
  return folder;
}
