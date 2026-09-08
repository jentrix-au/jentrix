/** Task IDs are global; human keys require one explicitly trusted workspace. */
import {
  callStructured,
  ToolCallError,
  UsageError,
  type SessionToolCaller,
} from "./tool-client";

const TASK_KEY = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
export function isTaskKey(wanted: string): boolean {
  return TASK_KEY.test(wanted.trim());
}

export function taskLookupArgs(
  wanted: string,
  workspaceId?: string,
): Record<string, unknown> {
  const value = wanted.trim();
  if (!value) throw new UsageError("--task requires a task id or human key");
  const key = TASK_KEY.exec(value);
  if (!key) return { taskId: value, response_format: "concise" };
  const number = Number(key[2]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new UsageError(
      "TASK_KEY_INVALID: task number must be a positive safe integer",
    );
  }
  if (!workspaceId?.trim()) {
    throw new UsageError(
      "TASK_WORKSPACE_REQUIRED: a human task key needs one trusted workspace. Run `jentrix folder align`, or use the task id.",
    );
  }
  return { workspaceId, number, response_format: "concise" };
}

export async function resolveTask(
  caller: SessionToolCaller,
  wanted: string,
  workspaceId?: string,
): Promise<{ id: string; key: string; workspaceId: string }> {
  const args = taskLookupArgs(wanted, workspaceId);
  const task = await callStructured(caller, "get_task", args);
  if (
    typeof task.id !== "string" ||
    !task.id ||
    typeof task.key !== "string" ||
    typeof task.workspaceId !== "string"
  ) {
    throw new ToolCallError(
      "get_task returned no usable task identity",
      "INTERNAL",
    );
  }
  if (args.number !== undefined) {
    const prefix = wanted
      .trim()
      .slice(0, wanted.trim().lastIndexOf("-"))
      .toUpperCase();
    if (
      task.workspaceId !== workspaceId ||
      task.key.toUpperCase() !== `${prefix}-${args.number}`
    ) {
      throw new ToolCallError(
        `TASK_KEY_MISMATCH: ${wanted.trim()} does not identify the returned task in the selected workspace`,
        "NOT_FOUND",
      );
    }
  } else if (task.id !== args.taskId) {
    throw new ToolCallError(
      "get_task returned a different task id",
      "INTERNAL",
    );
  }
  return { id: task.id, key: task.key, workspaceId: task.workspaceId };
}

/** Alignment only needs the ID; its mutation validates ID-based access itself. */
export async function resolveTaskId(
  caller: SessionToolCaller,
  wanted: string,
  workspaceId: string,
): Promise<string> {
  const args = taskLookupArgs(wanted, workspaceId);
  return typeof args.taskId === "string"
    ? args.taskId
    : (await resolveTask(caller, wanted, workspaceId)).id;
}
