/**
 * `jentrix task context` and `jentrix subtask list` (hardening PRD D3/D4) —
 * hand-written compositions over tools that already exist. NO new MCP tool and
 * no contract change: the frozen product surface is worth more than one hop.
 *
 * The defect these answer (§4 G5): no single call returned a card with its
 * links, its artifacts and its recent comments, so both JEN-484 agents spent
 * their opening turns on `get_task` + `search_tasks` + `list_comments` and got
 * back nothing they could use — `list_artifacts` was never even reached. Turns
 * that should have gone to reading the code went to an index that had nothing
 * to say and took fourteen calls to say it.
 */

import { Command } from "commander";

import { requireFolderBinding } from "../binding";
import { EXIT_CODES } from "../errors";
import { isTaskKey, taskLookupArgs } from "../task-resolution";
import {
  callStructured,
  UsageError,
  type SessionToolCaller,
} from "../tool-client";
import { type SessionCommandDeps } from "../session/deps";
import {
  relatedArtifactsOf,
  relatedNoticeOf,
  renderRelatedEvidence,
  type RelatedArtifactHit,
} from "../session/related-evidence";
import { inspectCheckout, reportError, withCaller } from "../session/runtime";

/** How many of a card's most recent comments the bundle carries (D3). */
const RECENT_COMMENTS = 5;

interface ContextBundle {
  task: Record<string, unknown>;
  /** The latest artifact of each type on the card, newest first. */
  artifacts: Record<string, unknown>[];
  comments: Record<string, unknown>[];
  /**
   * Semantic recall (cli 0.10.0, AC5.3): what OTHER work already said about
   * this card — `find_related_artifacts` by task (its own and linked
   * artifacts excluded, at most ten, similarity ranked). Null when the read
   * did not happen (named in `unavailable`), so "none" is never claimed for
   * a read that failed.
   */
  related: RelatedArtifactHit[] | null;
  relatedNotice?: string;
  /**
   * A side read that FAILED, named. A bundle that quietly drops a section it
   * could not fetch says "no artifacts" about a card that has twelve — which
   * is the same lie this command exists to stop telling.
   */
  unavailable: string[];
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  const list = (value as Record<string, unknown> | null)?.[key];
  return Array.isArray(list)
    ? list.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      )
    : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The LATEST artifact of each type (D3) — the card's shape, not its history.
 * `list_artifacts` returns newest first, so the first sighting of a type wins.
 */
function latestPerType(
  artifacts: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const kept: Record<string, unknown>[] = [];
  for (const artifact of artifacts) {
    const type = str(artifact.type) || "(untyped)";
    if (seen.has(type)) continue;
    seen.add(type);
    kept.push(artifact);
  }
  return kept;
}

/** Resolve the workspace for a human key; ids need no folder binding. */
async function workspaceForKey(
  wanted: string,
  deps: SessionCommandDeps,
): Promise<string | undefined> {
  if (!isTaskKey(wanted)) return undefined;
  const target = deps.resolveTarget();
  const inspection = await inspectCheckout(deps);
  return requireFolderBinding(inspection.root, {
    endpoint: target.url,
    repoOwnerName: inspection.repoOwnerName,
  }).workspaceId;
}

async function loadBundle(
  caller: SessionToolCaller,
  wanted: string,
  workspaceId: string | undefined,
): Promise<ContextBundle> {
  const task = await callStructured(caller, "get_task", {
    ...taskLookupArgs(wanted, workspaceId),
    response_format: "detailed",
  });
  const taskId = str(task.id);
  const unavailable: string[] = [];
  const side = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      return await callStructured(caller, tool, args);
    } catch (error) {
      unavailable.push(
        `${tool}: ${error instanceof Error ? error.message : "unavailable"}`,
      );
      return null;
    }
  };
  // Two more reads, in parallel: this command exists to cost ONE round of
  // waiting, not three. `list_artifacts` is workspace-scoped and task-filtered
  // — the task's OWN workspace, read back from the card, never a config guess.
  const [artifacts, comments, related] = await Promise.all([
    side("list_artifacts", { workspaceId: str(task.workspaceId), taskId }),
    side("list_comments", { taskId }),
    // Semantic recall: the same round of waiting, one more read — the
    // evidence the card's own record does not carry.
    side("find_related_artifacts", { taskId }),
  ]);
  return {
    task,
    artifacts: latestPerType(rows(artifacts, "artifacts")),
    // The server returns comments oldest-first, so the LAST five are the tail.
    comments: rows(comments, "comments").slice(-RECENT_COMMENTS),
    related:
      related === null
        ? null
        : relatedArtifactsOf({
            relatedArtifacts: (related as Record<string, unknown>).artifacts,
          }),
    ...(related !== null &&
    typeof (related as Record<string, unknown>).notice === "string"
      ? { relatedNotice: (related as Record<string, unknown>).notice as string }
      : {}),
    unavailable,
  };
}

/**
 * Both link directions, with titles, as printable lines. `get_task` detailed
 * returns `links: { incoming: [...], outgoing: [...] }`, each row carrying the
 * OTHER task's key/title inline — so a reader sees what a link points AT
 * without a second call, which is the whole point of the bundle.
 */
function linkLines(task: Record<string, unknown>): string[] {
  const links = task.links;
  if (typeof links !== "object" || links === null) return [];
  const lines: string[] = [];
  for (const [key, arrow] of [
    ["outgoing", "→"],
    ["incoming", "←"],
  ] as const) {
    for (const link of rows(links, key)) {
      const kind = str(link.kind) || "RELATES_TO";
      const other = str(link.key) || str(link.taskId);
      const title = str(link.title);
      const board = str((link.board as Record<string, unknown>)?.name);
      lines.push(
        `  ${arrow} ${kind} ${other}${title ? `  ${title}` : ""}${board ? `  · ${board}` : ""}`,
      );
    }
  }
  return lines;
}

export function renderContext(bundle: ContextBundle): string {
  const { task } = bundle;
  const lines: string[] = [];
  lines.push(`${str(task.key) || str(task.id)}  ${str(task.title)}`.trimEnd());
  const facets = [
    str(task.boardName),
    str(task.columnName),
    str(task.priority),
    task.updatedAt ? `updated ${str(task.updatedAt)}` : "",
  ].filter(Boolean);
  if (facets.length) lines.push(facets.join(" · "));
  const labels = rows(task, "labels")
    .map((l) => str(l.name))
    .filter(Boolean);
  if (labels.length) lines.push(`labels: ${labels.join(", ")}`);
  const description = str(task.description).trim();
  if (description) {
    lines.push("", description);
  }

  const links = linkLines(task);
  const subtasks = rows(task, "subtasks");
  const { artifacts, comments, related, unavailable } = bundle;

  // D3/AC2.3 — a card with nothing to discover says so in ONE line, so the
  // agent stops looking instead of spending three more calls proving it.
  // Semantic recall AC5.3: a fresh card also has no related evidence, and the
  // line says so — the read happened and found nothing.
  if (
    links.length === 0 &&
    artifacts.length === 0 &&
    comments.length === 0 &&
    (related === null || related.length === 0) &&
    unavailable.length === 0
  ) {
    lines.push(
      "",
      related === null
        ? "no links · no artifacts · no comments"
        : "no links · no artifacts · no comments · no related evidence",
    );
    return lines.join("\n");
  }

  if (links.length) lines.push("", `links (${links.length}):`, ...links);
  if (subtasks.length) {
    lines.push("", `subtasks (${subtasks.length}):`);
    for (const subtask of subtasks) {
      lines.push(
        `  [${subtask.completed === true ? "x" : " "}] ${str(subtask.title)}  ${str(subtask.id)}`,
      );
    }
  }
  if (artifacts.length) {
    lines.push("", `artifacts (latest per type, ${artifacts.length}):`);
    for (const artifact of artifacts) {
      lines.push(
        `  ${str(artifact.type).padEnd(14)} ${str(artifact.id)}  ${str(artifact.title)}`.trimEnd(),
      );
    }
  }
  // Semantic recall: after the card's OWN artifacts, what other work said —
  // the same block `session align` prints, rendered by the same function.
  const evidence = renderRelatedEvidence(related, bundle.relatedNotice);
  if (evidence.length) lines.push("", ...evidence);
  if (comments.length) {
    lines.push("", `comments (last ${comments.length}):`);
    for (const comment of comments) {
      const body = str(comment.body).replace(/\s+/g, " ").slice(0, 140);
      lines.push(`  ${str(comment.createdAt)}  ${body}`);
    }
  }
  if (unavailable.length) {
    lines.push("", `not read: ${unavailable.join("; ")}`);
  }
  return lines.join("\n");
}

export async function runTaskContext(
  flags: { task?: string; json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    if (!flags.task) throw new UsageError("--task <id-or-key> is required");
    const workspaceId = await workspaceForKey(flags.task, deps);
    return await withCaller(deps, async (caller) => {
      const bundle = await loadBundle(caller, flags.task!, workspaceId);
      deps.writeOut(
        flags.json === true
          ? JSON.stringify(bundle, null, 2)
          : renderContext(bundle),
      );
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

export async function runSubtaskList(
  flags: { task?: string; json?: boolean },
  deps: SessionCommandDeps,
): Promise<number> {
  try {
    if (!flags.task) throw new UsageError("--task <id-or-key> is required");
    const workspaceId = await workspaceForKey(flags.task, deps);
    return await withCaller(deps, async (caller) => {
      // ONE call (AC2.4): subtasks ride on the detailed task, and always did —
      // `jentrix subtask list` simply did not exist, so an agent asking for
      // them got "unknown command" and went looking elsewhere.
      const task = await callStructured(caller, "get_task", {
        ...taskLookupArgs(flags.task!, workspaceId),
        response_format: "detailed",
      });
      const subtasks = rows(task, "subtasks");
      if (flags.json === true) {
        deps.writeOut(JSON.stringify({ subtasks }, null, 2));
        return EXIT_CODES.OK;
      }
      deps.writeOut(
        subtasks.length === 0
          ? "no subtasks"
          : subtasks
              .map(
                (subtask) =>
                  `[${subtask.completed === true ? "x" : " "}] ${str(subtask.title)}  ${str(subtask.id)}`,
              )
              .join("\n"),
      );
      return EXIT_CODES.OK;
    });
  } catch (error) {
    return reportError(error, deps);
  }
}

export function registerTaskContextCommands(
  program: Command,
  deps: SessionCommandDeps,
  onExit: (code: number) => void,
): void {
  const task =
    program.commands.find((command) => command.name() === "task") ??
    program.command("task");
  task
    .command("context")
    .description(
      "The card in ONE call: description, links both ways, subtasks, the latest artifact of each type, and the last five comments.",
    )
    .option("--task <id-or-key>", "the task (id or key like JEN-42)")
    .option("--json", "print the same bundle as one JSON object")
    .action(async (options: { task?: string; json?: boolean }) => {
      onExit(await runTaskContext(options, deps));
    });

  const subtask =
    program.commands.find((command) => command.name() === "subtask") ??
    program.command("subtask");
  subtask
    .command("list")
    .description(
      "List a task's subtasks with ids and completion (one get_task call).",
    )
    .option("--task <id-or-key>", "the task (id or key like JEN-42)")
    .option("--json", "print the subtasks as JSON")
    .action(async (options: { task?: string; json?: boolean }) => {
      onExit(await runSubtaskList(options, deps));
    });
}
