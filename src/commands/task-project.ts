/**
 * `jentrix task project add|remove` — Project labels on a task
 * (client-runtime v2 §7.4/§15.4): hand-written ergonomic wrappers over
 * `get_task`/`get_project` + `add_project_link`/`remove_project_link` — no
 * new MCP tool. Session-independent, idempotent, ADMIN/OWNER-gated by the
 * server, and every mutation DISCLOSES the governed-worker consequence: the
 * ProjectLink graph is also the ownership graph project-bound workers are
 * scoped by.
 */

import { Command } from "commander";

import { EXIT_CODES } from "../errors";
import {
  callStructured,
  reportError,
  UsageError,
  withCaller,
  type SessionCommandDeps,
  type SessionToolCaller,
} from "./session";

const OWNERSHIP_DISCLOSURE =
  "note: Project labels are also the governed-worker ownership graph — adding/removing one can change which project-bound workers may act on this task (workspace-wide workers are unaffected).";

async function resolveTask(
  caller: SessionToolCaller,
  wanted: string,
): Promise<{ id: string; key: string; workspaceId: string }> {
  const key = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(wanted.trim());
  const task = await callStructured(
    caller,
    "get_task",
    key
      ? { key: wanted.trim().toUpperCase(), response_format: "concise" }
      : { taskId: wanted.trim(), response_format: "concise" },
  );
  return {
    id: String(task.id),
    key: String(task.key),
    workspaceId: String(task.workspaceId),
  };
}

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
    if (row.id) return { id: String(row.id), name: String(row.name ?? row.id) };
  } catch {
    // fall through to slug resolution
  }
  const listed = await callStructured(caller, "list_projects", { workspaceId });
  const rows =
    (listed.projects as Array<{ id: string; name: string; slug: string }>) ??
    [];
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
    return await withCaller(deps, async (caller) => {
      const task = await resolveTask(caller, flags.task!);
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
      deps.writeOut(OWNERSHIP_DISCLOSURE);
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
      "Add or remove a Project LABEL on a task — optional classification that is also the governed-worker ownership graph",
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
