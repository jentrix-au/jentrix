/**
 * `jentrix task project add|remove` — Project labels on a task
 * (client-runtime v2 §7.4/§15.4): hand-written ergonomic wrappers over
 * `get_task`/`get_project` + `add_project_link`/`remove_project_link` — no
 * new MCP tool. Session-independent, idempotent, ADMIN/OWNER-gated by the
 * server. Projects are optional task labels within the task's workspace.
 */

import { Command } from "commander";

import { EXIT_CODES } from "../errors";
import { requireFolderBinding } from "../binding";
import { resolveTask, isTaskKey } from "../task-resolution";
import {
  callStructured,
  ToolCallError,
  UsageError,
  type SessionToolCaller,
} from "../tool-client";
import { inspectCheckout, reportError, withCaller } from "../session/runtime";
import { type SessionCommandDeps } from "../session/deps";

async function resolveProject(
  caller: SessionToolCaller,
  workspaceId: string,
  wanted: string,
): Promise<{ id: string; name: string }> {
  const trimmed = wanted.trim();
  // An id resolves directly; a slug goes through the workspace list.
  try {
    const project = await callStructured(caller, "get_project", {
      projectId: trimmed,
    });
    const row = (project.project ?? project) as { id?: string; name?: string };
    if (typeof row.id !== "string")
      throw new ToolCallError(
        "get_project returned no project identity",
        "INTERNAL",
      );
    return { id: row.id, name: String(row.name ?? row.id) };
  } catch (error) {
    // Only an actual lookup miss permits slug fallback. Auth/transport failures
    // must retain their real error and never trigger a second lookup.
    if (!(error instanceof ToolCallError) || error.code !== "NOT_FOUND")
      throw error;
  }
  const listed = await callStructured(caller, "list_projects", { workspaceId });
  if (
    !Array.isArray(listed.projects) ||
    !listed.projects.every(
      (row) =>
        row &&
        typeof row.id === "string" &&
        row.id &&
        typeof row.name === "string" &&
        typeof row.slug === "string",
    )
  ) {
    throw new ToolCallError(
      "list_projects returned an invalid project list",
      "INTERNAL",
    );
  }
  const rows = listed.projects as Array<{
    id: string;
    name: string;
    slug: string;
  }>;
  const match = rows.find(
    (p) => p.id === trimmed || p.slug === trimmed.toLowerCase(),
  );
  if (!match) {
    throw new UsageError(
      `--project ${wanted} matches no project in this task's workspace (slugs: ${
        rows.map((p) => p.slug).join(", ") || "none"
      })`,
      EXIT_CODES.NOT_FOUND,
    );
  }
  return { id: match.id, name: match.name };
}

export async function runTaskProject(
  action: "add" | "remove",
  flags: { task?: string; project?: string },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    if (!flags.task || !flags.project) {
      throw new UsageError(
        "--task <id-or-key> and --project <id-or-slug> are both required",
      );
    }
    const target = deps.resolveTarget();
    // IDs work outside a bound checkout. Keys never search arbitrary workspaces.
    let workspaceId: string | undefined;
    if (isTaskKey(flags.task)) {
      const inspection = await inspectCheckout(deps);
      workspaceId = requireFolderBinding(inspection.root, {
        endpoint: target.url,
        repoOwnerName: inspection.repoOwnerName,
      }).workspaceId;
    }
    return await withCaller(deps, async (caller) => {
      const task = await resolveTask(caller, flags.task!, workspaceId);
      const project = await resolveProject(
        caller,
        task.workspaceId,
        flags.project!,
      );
      await callStructured(
        caller,
        action === "add" ? "add_project_link" : "remove_project_link",
        { projectId: project.id, targetType: "TASK", targetId: task.id },
      );
      deps.writeOut(
        action === "add"
          ? `${task.key} labelled with project ${project.name}. (Adding an existing label is a no-op.)`
          : `Project ${project.name} removed from ${task.key}. (Removing a missing label is a no-op.)`,
      );
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

export function registerTaskProjectCommand(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): Command {
  const task = program
    .command("task")
    .description("Task helpers (Project labels live here — not on sessions)");
  const project = task
    .command("project")
    .description(
      "Add or remove an optional project label within the task workspace",
    );
  project
    .command("add")
    .description("Link a project to a task (idempotent; ADMIN/OWNER)")
    .option("--task <id-or-key>", "the task (id or key like JEN-42)")
    .option("--project <id-or-slug>", "the project")
    .action(async (options: { task?: string; project?: string }) => {
      onExit(await runTaskProject("add", options, deps));
    });
  project
    .command("remove")
    .description("Unlink a project from a task (idempotent; ADMIN/OWNER)")
    .option("--task <id-or-key>", "the task (id or key like JEN-42)")
    .option("--project <id-or-slug>", "the project")
    .action(async (options: { task?: string; project?: string }) => {
      onExit(await runTaskProject("remove", options, deps));
    });
  return task;
}
