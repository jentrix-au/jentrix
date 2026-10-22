/**
 * `jentrix project link|unlink|status` — linked workspaces (JEN-567/JEN-568):
 * hand-written wrappers over `add_project_link`/`remove_project_link` with
 * `targetType: "WORKSPACE"` and the `get_project.linkedWorkspaces` rollup.
 * The server resolves the workspace slug, refuses the project's own
 * workspace, and needs ADMIN in both workspaces. The rollup is read live
 * under the caller's membership — nothing is copied across workspaces.
 */

import { Command } from "commander";

import { EXIT_CODES } from "../errors";
import { requireFolderBinding } from "../binding";
import { callStructured, ToolCallError, UsageError } from "../tool-client";
import { inspectCheckout, reportError, withCaller } from "../session/runtime";
import { type SessionCommandDeps } from "../session/deps";
import { resolveProject } from "./task-project";

type LinkedWorkspace = {
  workspaceId: string;
  label: string | null;
  access: boolean;
  name: string | null;
  slug: string | null;
  taskCount: number | null;
  lastUpdatedAt: string | null;
  boards: Array<{
    name: string;
    slug: string;
    taskCount: number;
    columns: Array<{ name: string; taskCount: number }>;
  }>;
};

/** Slug fallback only: the folder's bound workspace. */
async function boundWorkspaceId(deps: SessionCommandDeps): Promise<string> {
  const target = deps.resolveTarget();
  const inspection = await inspectCheckout(deps);
  return requireFolderBinding(inspection.root, {
    endpoint: target.url,
    repoOwnerName: inspection.repoOwnerName,
  }).workspaceId;
}

export async function runProjectLink(
  action: "link" | "unlink",
  flags: { project?: string; workspace?: string },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    const workspace = flags.workspace?.trim();
    if (!flags.project || !workspace) {
      throw new UsageError(
        "--project <id-or-slug> and --workspace <id-or-slug> are both required",
      );
    }
    return await withCaller(deps, async (caller) => {
      const project = await resolveProject(
        caller,
        () => boundWorkspaceId(deps),
        flags.project!,
      );
      await callStructured(
        caller,
        action === "link" ? "add_project_link" : "remove_project_link",
        { projectId: project.id, targetType: "WORKSPACE", targetId: workspace },
      );
      deps.writeOut(
        action === "link"
          ? `Workspace ${workspace} linked to project ${project.name}. (Linking an existing workspace is a no-op.) Read it back: jentrix project status --project ${project.id}`
          : `Workspace ${workspace} unlinked from project ${project.name}. (Unlinking a missing link is a no-op.)`,
      );
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

function when(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

function tasks(count: number | null): string {
  return `${count} task${count === 1 ? "" : "s"}`;
}

export function renderLinkedWorkspaces(
  projectName: string,
  linked: LinkedWorkspace[],
): string {
  if (linked.length === 0) {
    return `Project ${projectName} links no workspaces. Link one: jentrix project link --project <id-or-slug> --workspace <id-or-slug>`;
  }
  const lines = [
    `Project ${projectName} — ${linked.length} linked workspace${linked.length === 1 ? "" : "s"}`,
  ];
  for (const ws of linked) {
    const label = ws.label ? ` — ${ws.label}` : "";
    lines.push("");
    // access:false means the caller is not a member there: its fields are
    // null, never zero, so the line says so instead of printing counts.
    if (!ws.access) {
      lines.push(
        `${ws.workspaceId}${label} · no access (you are not a member there)`,
      );
      continue;
    }
    lines.push(
      `${ws.name} (${ws.slug})${label} · ${tasks(ws.taskCount)} · last update ${when(ws.lastUpdatedAt)}`,
    );
    if (ws.boards.length === 0) lines.push("  no boards");
    for (const board of ws.boards) {
      lines.push(`  ${board.name} (${board.slug}) · ${tasks(board.taskCount)}`);
      if (board.columns.length > 0)
        lines.push(
          `    ${board.columns.map((c) => `${c.name} ${c.taskCount}`).join(" · ")}`,
        );
    }
  }
  return lines.join("\n");
}

export async function runProjectStatus(
  flags: { project?: string; json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    if (!flags.project)
      throw new UsageError("--project <id-or-slug> is required");
    return await withCaller(deps, async (caller) => {
      const project = await resolveProject(
        caller,
        () => boundWorkspaceId(deps),
        flags.project!,
      );
      // A slug resolved through list_projects carries no rollup yet.
      const record =
        project.record ??
        (await callStructured(caller, "get_project", {
          projectId: project.id,
        }));
      const linked = record.linkedWorkspaces;
      if (!Array.isArray(linked)) {
        throw new ToolCallError(
          "get_project returned no linkedWorkspaces — the server predates contract 1.8.0",
          "INTERNAL",
        );
      }
      deps.writeOut(
        flags.json === true
          ? JSON.stringify(
              {
                projectId: project.id,
                name: project.name,
                linkedWorkspaces: linked,
              },
              null,
              2,
            )
          : renderLinkedWorkspaces(project.name, linked as LinkedWorkspace[]),
      );
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

/**
 * Reuses the `project` group the generated tree mounts its tool verbs into
 * (`project get`, `project add-link`, …); registered first, so the generated
 * leaves join this group instead of shadowing it.
 */
export function registerProjectCommands(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  const project =
    program.commands.find((command) => command.name() === "project") ??
    program
      .command("project")
      .description(
        "link, unlink, status (linked workspaces) — plus the project tools",
      );
  project
    .command("link")
    .description(
      "Link another workspace to a project (idempotent; ADMIN in both workspaces)",
    )
    .option("--project <id-or-slug>", "the project")
    .option("--workspace <id-or-slug>", "the workspace to link")
    .action(async (options: { project?: string; workspace?: string }) => {
      onExit(await runProjectLink("link", options, deps));
    });
  project
    .command("unlink")
    .description("Unlink a workspace from a project (idempotent; ADMIN)")
    .option("--project <id-or-slug>", "the project")
    .option("--workspace <id-or-slug>", "the linked workspace")
    .action(async (options: { project?: string; workspace?: string }) => {
      onExit(await runProjectLink("unlink", options, deps));
    });
  project
    .command("status")
    .description(
      "Summarize every linked workspace: tasks, last update, per-column counts",
    )
    .option("--project <id-or-slug>", "the project")
    .option("--json", "print the linkedWorkspaces rollup as JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      onExit(await runProjectStatus(options, deps));
    });
  return project;
}
