/**
 * `jentrix push <kind> [file]` — the Jentrix MVP typed-artifact pipeline
 * (stacks-mvp PRD §6). Thin: read file or stdin, redact LOCALLY, POST the
 * bounded body to the session's typed-artifact ingestion boundary (which
 * re-redacts server-side and links the artifact to the aligned subject).
 *
 * The aligned session comes from the local alignment marker `jentrix align`
 * wrote for this checkout; an unaligned checkout (or an unaligned session,
 * refused server-side) names the align command (AC6).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { Command } from "commander";

import { EXIT_CODES } from "../errors";
import { createSessionRedactor } from "../session-host/session-redact";
import { inspectRepository } from "../repo";
import {
  callStructured,
  readAlignmentMarker,
  readCurrentProviderHookContext,
  stacksBaseUrlOf,
  ToolCallError,
  UsageError,
  withCaller,
  type SessionCommandDeps,
} from "./session";

/**
 * mvp-hardening AC9/AC11 — ONE wording for "this lands on no task" (moved
 * here from the retired alignment wizard; this is its only consumer).
 */
const SESSION_LEVEL_ARTIFACT_DISCLOSURE =
  "artifacts from this session attach to the workspace only — they appear on NO task card. Align to a work item (`jentrix session align --task <id-or-key>`), or push with `jentrix push <kind> --task <id>`, to put them on a task.";

export const PUSH_KINDS = [
  "plan",
  "decision",
  "findings",
  "report",
  "diff",
  "deliverable",
  "learning",
  "prompt",
  "goal",
  "prd",
  "gap",
  "issue",
  "context",
  "log",
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

/**
 * The kind → ArtifactType table (mirrors src/lib/work-layers.ts, which the CLI
 * package cannot import). ONE vocabulary covers both writes: `jentrix push`
 * sends the kind and the server maps it, and `jentrix artifact upload --kind`
 * maps it here so an upload files under the same type, hence the same review
 * category. `prompt`/`goal`/`prd` are the STA-26 INPUT kinds; `gap`/`issue`/
 * `context` complete the review taxonomy (session-review-taxonomy PRD §4 —
 * `context` reuses SOURCE_DIGEST, deliberately no enum change).
 */
export const ARTIFACT_TYPE_BY_PUSH_KIND: Record<PushKind, string> = {
  plan: "PLAN",
  decision: "DECISION_MEMO",
  findings: "FINDINGS",
  report: "REPORT",
  diff: "DIFF",
  deliverable: "DELIVERABLE",
  learning: "LEARNING",
  prompt: "PROMPT",
  goal: "GOAL",
  prd: "PRD",
  gap: "GAP",
  issue: "ISSUE",
  context: "SOURCE_DIGEST",
  log: "LOG",
};

export interface PushFlags {
  title?: string;
  /**
   * Taxonomy AC2.1 — what a decision rested on, repeatable. Each ref is a URL
   * (recorded verbatim) or an artifact id (resolved and refused when it does
   * not exist — filing the context FIRST is the ordering a reviewer wants).
   * Written as the structured "Based on:" block at the TOP of the memo body
   * (D6: convention over schema; the server stays dumb).
   */
  basis?: string[];
  session?: string;
  /** mvp-hardening AC4: address the push by TASK — no session, no marker. */
  task?: string;
  /**
   * control-room AC2.4: the producer for THIS push. A session-addressed push
   * without it inherits the session's own `--agent` label; a task-addressed
   * push without it is the operator's own and stays unattributed.
   */
  agent?: string;
  agentEmoji?: string;
  /**
   * control-room AC7.2 — reference an EXISTING artifact from this task instead
   * of uploading bytes. Addressing, not an eighth kind: the seven push kinds
   * are frozen and untouched.
   */
  ref?: string;
  /**
   * control-room AC7.5/AC7.7/AC7.8 — accept the offers (mint a card,
   * link a duplicate) without a prompt, for a non-interactive caller. Absent,
   * the offer is PRINTED with the command that takes it and nothing is
   * written: an offer that acts on its own is not an offer.
   */
  yes?: boolean;
  /**
   * Taxonomy AC3.3 — an accepted mint links the card BLOCKS the anchor
   * (acceptance-blocking; lights the red Blocked badge) instead of the
   * default RELATES_TO.
   */
  blocks?: boolean;
  /**
   * Session evidence floor (PRD §5): `push log --from-cmd "<command>"` runs
   * the command CLI-LOCALLY, captures exit code + a 64 KB tail-biased output
   * tail, and pushes an ATTESTED LOG whose body opens with the command and
   * exit code. The CLI then exits with the COMMAND's code (a green push over
   * a red gate must not read as green), so gates can run through it.
   */
  fromCmd?: string;
  json?: boolean;
}

/** §5 — the bounded output tail a `--from-cmd` LOG keeps. */
export const MAX_FROM_CMD_OUTPUT_BYTES = 64 * 1024;

/**
 * PURE body builder for the `--from-cmd` LOG (D4: opens with the command and
 * exit code; tail-biased truncation is DECLARED). Exported for tests.
 */
export function fromCmdLogBody(
  command: string,
  exitCode: number,
  output: string,
): string {
  const header = `$ ${command}\nexit code: ${exitCode}\n\n`;
  if (Buffer.byteLength(output, "utf8") <= MAX_FROM_CMD_OUTPUT_BYTES) {
    return header + (output || "(no output)");
  }
  const notice = `[head truncated: output exceeded ${MAX_FROM_CMD_OUTPUT_BYTES / 1024} KB — tail retained]\n`;
  const tail = Buffer.from(output, "utf8")
    .subarray(-MAX_FROM_CMD_OUTPUT_BYTES)
    .toString("utf8")
    .replace(/^�+/, "");
  return header + notice + tail;
}

interface PushTarget {
  /** Which boundary route the body goes to. */
  path: string;
  /** How the success line names where it landed. */
  label: string;
}

function sessionTarget(sessionId: string): PushTarget {
  return {
    path: `/api/agent-sessions/${sessionId}/artifacts`,
    label: `session ${sessionId}`,
  };
}

function taskTarget(taskId: string): PushTarget {
  return { path: `/api/tasks/${taskId}/artifacts`, label: `task ${taskId}` };
}

export interface PushDeps extends SessionCommandDeps {
  /** Injectable stdin reader (tests); default drains process.stdin. */
  readStdin?(): Promise<string>;
  fetchImpl?: typeof fetch;
  /** Injectable `--from-cmd` runner (tests); default spawns a local shell. */
  runCommand?(command: string): Promise<{ code: number; output: string }>;
}

/**
 * Default `--from-cmd` execution: the operator's own shell command, run
 * locally with stdout+stderr interleaved and only the LAST 64 KB retained in
 * memory (tail-biased — the verdict lives at the end of a gate's output).
 * No server execution, no shell composition server-side (D4).
 */
function defaultRunCommand(
  command: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, windowsHide: true });
    let tail = Buffer.alloc(0);
    const keep = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.byteLength > MAX_FROM_CMD_OUTPUT_BYTES * 2) {
        tail = tail.subarray(-MAX_FROM_CMD_OUTPUT_BYTES);
      }
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.once("error", (error) =>
      resolve({ code: 127, output: `${error.message}\n` }),
    );
    child.once("exit", (code, signal) =>
      resolve({
        code: code ?? (signal ? 130 : 1),
        output: tail.toString("utf8"),
      }),
    );
  });
}

async function drainStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runPush(
  kind: string,
  file: string | undefined,
  flags: PushFlags,
  deps: PushDeps,
): Promise<number> {
  try {
    if (!(PUSH_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(
        `unknown kind "${kind}" — expected one of: ${PUSH_KINDS.join(", ")}`,
      );
    }
    // AC2.1: --basis is the decision-memo contract; on any other kind it is a
    // mistake worth stopping, not silently dropping.
    if (flags.basis?.length && kind !== "decision") {
      throw new UsageError(
        "--basis records what a decision rested on — it only applies to `jentrix push decision`",
      );
    }
    // Evidence floor §5: --from-cmd is the LOG kind's attested capture — the
    // CLI runs the command and the body is what it observed, never a file.
    if (flags.fromCmd !== undefined) {
      if (kind !== "log") {
        throw new UsageError(
          '--from-cmd captures a command\'s exit code and output as a LOG — it only applies to `jentrix push log --from-cmd "<command>"`',
        );
      }
      if (file || flags.ref) {
        throw new UsageError(
          "--from-cmd generates the LOG body from the command run — drop the file/--ref",
        );
      }
      if (!flags.fromCmd.trim()) {
        throw new UsageError("--from-cmd needs a non-empty command");
      }
    }
    // AC7.2: a reference push uploads nothing, so it reads nothing — and it
    // needs no alignment either, which is why this sits ABOVE target
    // resolution. Refused without --task because a reference is meaningless
    // without a destination, and refused with a file because the two are
    // different requests and guessing between them is how an operator loses a
    // body.
    if (flags.ref) {
      if (flags.basis?.length) {
        throw new UsageError(
          "--ref references an existing artifact, so there is no body to carry a basis block — drop --basis",
        );
      }
      if (!flags.task) {
        throw new UsageError(
          "--ref needs --task <id>: a reference links an existing artifact TO a task",
        );
      }
      if (file) {
        throw new UsageError(
          "--ref references an existing artifact, so it takes no file — drop one or the other",
        );
      }
      return await runRefPush(kind, flags.ref, flags.task, flags, deps);
    }

    // Resolution order (mvp-hardening Slice 1):
    //   1. --session <id>  → session mode;
    //   2. --task <id>     → task mode, no session and no marker needed;
    //   3. the checkout's alignment marker → session mode, with a fallback to
    //      the marker's OWN taskId when the session turns out to be sealed.
    if (flags.session && flags.task) {
      throw new UsageError(
        "pass --session <id> or --task <id>, not both — they address the same push two different ways",
      );
    }
    let target: PushTarget;
    /** The marker's task, i.e. what a sealed session falls back to. */
    let fallbackTaskId: string | null = null;
    /**
     * STA-26 — the VALIDATED session this push is correlated with (an
     * explicit --session or the checkout's alignment marker; never a
     * model-authored id). Carried into the issue-mint offer so the minted
     * card's TASK_CREATED activity lands in this session's RUN_SUMMARY.
     */
    let correlatedSessionId: string | null = null;
    if (flags.session) {
      target = sessionTarget(flags.session);
      correlatedSessionId = flags.session;
    } else if (flags.task) {
      target = taskTarget(flags.task);
    } else {
      const inspection = await inspectRepository(deps.cwd(), deps.git);
      if (!inspection) {
        throw new UsageError(
          "the current directory is not inside a git work tree — run from the aligned checkout, or pass --session <id> or --task <id>",
        );
      }
      // Slice 6: resolve THIS provider session's entry, so two Claude Code
      // sessions in one checkout never resolve to each other's alignment.
      const marker = readAlignmentMarker(
        deps.configPath,
        inspection.root,
        readCurrentProviderHookContext(deps)?.sessionId ?? null,
      );
      if (!marker) {
        // AC6: an unaligned session refuses with the align command named. It
        // says THIS SESSION, not this checkout: a checkout can hold several
        // aligned sessions, and pushing into a neighbour's would be worse than
        // refusing.
        throw new UsageError(
          "this session has no alignment — run `jentrix session align --task <id-or-key>` (or /jentrix-align in Claude Code) first, or pass --session <id> or --task <id>",
        );
      }
      target = sessionTarget(marker.sessionId);
      correlatedSessionId = marker.sessionId;
      fallbackTaskId = marker.taskId;
    }

    // §5 — the attested capture: run the command, remember its exit code (the
    // CLI's own exit code after a successful push), body opens with both.
    let commandExit: number | null = null;
    let raw: string;
    if (flags.fromCmd !== undefined) {
      const command = flags.fromCmd.trim();
      deps.writeErr(`running: ${command}`);
      const ran = await (deps.runCommand ?? defaultRunCommand)(command);
      commandExit = ran.code;
      raw = fromCmdLogBody(command, ran.code, ran.output);
    } else {
      raw = file
        ? readFileSync(file, "utf8")
        : await (deps.readStdin ?? drainStdin)();
    }
    if (!raw.trim()) {
      throw new UsageError(
        file
          ? `${file} is empty`
          : "stdin is empty — pipe the content or name a file",
      );
    }
    // AC2.1 — resolve the basis refs BEFORE anything is written: an
    // artifact-id ref that does not exist refuses the whole push, so a memo
    // can never cite context that was not filed first. The block goes at the
    // TOP of the body — that is what lets the server read it back off the
    // stored row's snippet without a second storage field (D6).
    const withBasis = flags.basis?.length
      ? `${await basisBlock(flags.basis, deps)}\n\n${raw}`
      : raw;

    // Local redaction BEFORE anything leaves the process (PRD §6).
    const body = createSessionRedactor({ env: deps.env }).text(withBasis);

    const credentials = deps.resolveTarget();
    const post = (to: PushTarget) =>
      (deps.fetchImpl ?? fetch)(
        new URL(to.path, stacksBaseUrlOf(credentials.url)),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credentials.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind,
            ...(flags.title ? { title: flags.title } : {}),
            ...(flags.agent ? { producerLabel: flags.agent } : {}),
            ...(flags.agentEmoji ? { producerEmoji: flags.agentEmoji } : {}),
            // D4: only the CLI-generated capture is attested — never a piped
            // body, whatever its kind.
            ...(commandExit !== null ? { attested: true } : {}),
            body,
          }),
        },
      );

    let response = await post(target);
    let payload = (await response.json().catch(() => ({}))) as {
      artifactId?: string;
      type?: string;
      checksum?: string;
      deduped?: boolean;
      taskId?: string | null;
      /** control-room AC7.4 — same bytes already on another task here. */
      sameBytesOnTaskId?: string;
      error?: string;
      detail?: string;
    };
    let sealedFallback = false;
    if (
      !response.ok &&
      fallbackTaskId &&
      String(payload.detail ?? payload.error ?? "").includes(
        "SESSION_NOT_ACTIVE",
      )
    ) {
      // AC3 — the whole point of the slice: a dead background process must
      // never cost the operator an artifact. The session is sealed, but the
      // marker still names the task it was aligned to, and an artifact is a
      // durable fact about that task.
      const sealed = target.label;
      target = taskTarget(fallbackTaskId);
      response = await post(target);
      payload = (await response.json().catch(() => ({}))) as typeof payload;
      sealedFallback = response.ok;
      if (sealedFallback) {
        // The session is sealed — correlating later writes with it would be
        // refused server-side (SESSION_NOT_ACTIVE), so the mint runs plain.
        correlatedSessionId = null;
        deps.writeErr(
          `note: the aligned ${sealed} has ended — this artifact went straight to task ${fallbackTaskId}. Run \`jentrix session align --task <id-or-key>\` to bind a new session.`,
        );
      }
    }
    if (!response.ok) {
      const message =
        payload.detail ?? payload.error ?? `HTTP ${response.status}`;
      if (message.includes("SESSION_NOT_ALIGNED")) {
        throw new UsageError(`${message}`, EXIT_CODES.CONFLICT);
      }
      if (response.status === 403) {
        throw new UsageError(message, EXIT_CODES.FORBIDDEN);
      }
      if (response.status === 404) {
        throw new UsageError(
          `${message} — the aligned session may have ended; re-run \`jentrix session align --task <id-or-key>\``,
          EXIT_CODES.NOT_FOUND,
        );
      }
      throw new UsageError(
        message,
        response.status === 409 ? EXIT_CODES.CONFLICT : 1,
      );
    }
    // AC11: a push that landed on NO task says so, and still exits 0 — this
    // is a disclosure, not a refusal. Read off the server's answer, not off a
    // local guess, so it is right however the push was addressed.
    if (payload.taskId === null) {
      deps.writeErr(`note: ${SESSION_LEVEL_ARTIFACT_DISCLOSURE}`);
    }
    deps.writeOut(
      flags.json
        ? JSON.stringify(payload)
        : `Pushed ${kind} → artifact ${payload.artifactId}${payload.deduped ? " (already stored — identical content)" : ""} · ${target.label}`,
    );

    // AC7.4 — the same bytes already live on another task. The report's only
    // cross-task handoff was exactly this, filed as two rows. OFFERED, never
    // performed: the operator asked for a push and got one.
    if (payload.sameBytesOnTaskId && payload.taskId) {
      deps.writeErr(
        `note: identical content is already stored on task ${payload.sameBytesOnTaskId}. ` +
          `One truth per artifact: \`jentrix push ${kind} --ref <artifactId> --task ${payload.taskId}\` ` +
          `references it instead of keeping two rows that will disagree once one is revised.`,
      );
    }

    // AC7.5/AC7.6 + taxonomy AC3.1 — findings, gaps, and issues are where
    // cards come from. Offer the card; never mint one unasked.
    if (isMintableKind(kind) && payload.taskId) {
      await offerCardMint(kind, payload, flags, deps, correlatedSessionId);
    }
    // §5: a --from-cmd push exits with the COMMAND's code — the LOG records a
    // red gate, it never turns it green.
    if (commandExit !== null && commandExit !== 0) {
      deps.writeErr(
        `command exited ${commandExit} — recorded in the LOG; exiting with the command's code`,
      );
    }
    return commandExit ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.writeErr(`error: ${error.message}`);
      return error.exitCode;
    }
    deps.writeErr(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

// ---------------------------------------------------------------------------
// control-room 04-6 — the handoff half. Everything here OFFERS; nothing here
// acts on its own. An offer that performs is not an offer, and a push whose
// side effects the operator did not ask for is worse than no offer at all.
// ---------------------------------------------------------------------------

/**
 * AC2.1 — the structured "Based on:" block (D6: convention over schema). URLs
 * are recorded verbatim; artifact ids must RESOLVE — one MCP connection for
 * all of them, and any miss refuses the push with the offending ref named.
 * The literal format is pinned by test on both sides of the wire: the server
 * (src/lib/decision-basis.ts) parses exactly what this writes.
 */
async function basisBlock(refs: string[], deps: PushDeps): Promise<string> {
  const lines: string[] = [];
  const ids = refs.filter((ref) => !/^https?:\/\//i.test(ref));
  const titles = new Map<string, string>();
  if (ids.length) {
    await withCaller(deps, async (caller) => {
      for (const id of ids) {
        try {
          const result = await callStructured(caller, "get_artifact", {
            artifactId: id,
          });
          // get_artifact nests the row under `artifact` (beside downloadUrl).
          const record = (result.artifact ?? result) as { title?: unknown };
          titles.set(id, String(record.title ?? ""));
        } catch (error) {
          // STA-116 — only a NOT_FOUND/FORBIDDEN verdict means the ref is
          // bad. A rate limit or server failure says nothing about the ref;
          // refusing with "does not resolve" sent operators fixing refs that
          // were fine.
          const code = error instanceof ToolCallError ? error.code : null;
          if (code === "RATE_LIMITED") {
            throw new UsageError(
              `--basis ${id} could not be verified — the server is rate limiting reads; the ref may be fine. Retry the push shortly.`,
              EXIT_CODES.RATE_LIMITED,
            );
          }
          if (code && code !== "NOT_FOUND" && code !== "FORBIDDEN") {
            throw new UsageError(
              `--basis ${id} could not be verified (${code}) — the ref may be fine. Retry the push.`,
              EXIT_CODES.INTERNAL,
            );
          }
          throw new UsageError(
            `--basis ${id} does not resolve to an artifact you can read — push the context first (\`jentrix push context\`), or pass a URL`,
            EXIT_CODES.NOT_FOUND,
          );
        }
      }
    });
  }
  for (const ref of refs) {
    const title = titles.get(ref);
    lines.push(
      title !== undefined ? `- artifact ${ref} — ${title}` : `- ${ref}`,
    );
  }
  return `Based on:\n${lines.join("\n")}`;
}

/**
 * AC7.2/AC7.3 — reference an existing artifact from another task. No bytes
 * move: one artifact row, N tasks, provenance unchanged. A cross-workspace
 * reference is refused SERVER-side; this reports that refusal verbatim.
 */
async function runRefPush(
  kind: string,
  artifactId: string,
  taskId: string,
  flags: PushFlags,
  deps: PushDeps,
): Promise<number> {
  const credentials = deps.resolveTarget();
  const response = await (deps.fetchImpl ?? fetch)(
    new URL(taskTarget(taskId).path, stacksBaseUrlOf(credentials.url)),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ refArtifactId: artifactId }),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as {
    artifactId?: string;
    taskId?: string;
    created?: boolean;
    error?: string;
    detail?: string;
  };
  if (!response.ok) {
    const message =
      payload.detail ?? payload.error ?? `HTTP ${response.status}`;
    throw new UsageError(
      message,
      response.status === 403
        ? EXIT_CODES.FORBIDDEN
        : response.status === 404
          ? EXIT_CODES.NOT_FOUND
          : response.status === 409
            ? EXIT_CODES.CONFLICT
            : 1,
    );
  }
  deps.writeOut(
    flags.json
      ? JSON.stringify(payload)
      : payload.created
        ? `Linked artifact ${artifactId} → task ${taskId} (one artifact, two tasks — no copy)`
        : `Artifact ${artifactId} was already reachable from task ${taskId} — nothing to do`,
  );
  void kind;
  return 0;
}

/**
 * AC7.5/AC7.6/AC7.8 + taxonomy AC3.1 — after a findings/gap/issue push, offer
 * to mint a card.
 *
 * This is the product vision's "mints issues and bugs from active-session
 * findings" made real, generalized to the whole revision queue: gaps and
 * issues become ordinary cards a next session can align to. It OFFERS:
 * without --yes it prints the command and writes nothing. It never invents a
 * board or a column, because a board created by a side effect is a board
 * nobody agreed to.
 */

/** The push kinds whose artifacts are offered as cards (taxonomy AC3.1). */
const MINTABLE_PUSH_KINDS = ["findings", "gap", "issue"] as const;

export function isMintableKind(kind: string): boolean {
  return (MINTABLE_PUSH_KINDS as readonly string[]).includes(kind);
}

/** The ArtifactTypes the standalone mint command accepts (AC3.1). */
const MINTABLE_ARTIFACT_TYPES = ["FINDINGS", "GAP", "ISSUE"] as const;

/** The card-title noun per mintable artifact type. */
function mintNoun(type: string): string {
  return type === "GAP" ? "Gap" : type === "ISSUE" ? "Issue" : "Finding";
}

async function offerCardMint(
  kind: string,
  payload: { artifactId?: string; taskId?: string | null },
  flags: PushFlags,
  deps: PushDeps,
  /** STA-26 — validated correlation for the mint's writes; null = none. */
  sessionId: string | null = null,
): Promise<void> {
  if (!payload.artifactId || !payload.taskId) return;
  try {
    const board = await findMintBoard(deps, payload.taskId);
    if (!board) {
      // D7's last rung: named, not silent. An operator who expected a card
      // needs to know why there is none.
      deps.writeErr(
        "note: no board can take a card here (no BUGS board, and the task's own board has no column), so nothing was minted. File the card by hand.",
      );
      return;
    }
    if (!flags.yes) {
      const noun = kind === "findings" ? "issues" : "follow-up cards";
      // JEN-274: a push addressed with --session <id> has no marker for the
      // mint to fall back on, so the printed command carries the session —
      // otherwise running it exactly as printed mints an uncorrelated card.
      deps.writeErr(
        `note: ${kind} pushes usually become ${noun}. \`${mintIssueCommandHint(payload.artifactId, payload.taskId, flags.session ?? null)}\` opens a card on ${board.name}, links this artifact to it, and relates it back to this task${flags.blocks ? "" : " (add --blocks when it blocks acceptance)"}. Nothing was created.`,
      );
      return;
    }
    const minted = await mintCard(deps, {
      board,
      artifactId: payload.artifactId,
      anchorTaskId: payload.taskId,
      noun: mintNoun(
        ARTIFACT_TYPE_BY_PUSH_KIND[kind as PushKind] ?? "FINDINGS",
      ),
      // STA-128: the operator's own claim title, when one was given.
      artifactTitle: flags.title?.trim() || null,
      blocks: Boolean(flags.blocks),
      sessionId,
    });
    deps.writeOut(
      `Minted ${minted.key ?? minted.id} on ${board.name} · ${minted.artifactLinked ? "artifact linked" : "artifact NOT linked (see note)"} · ${flags.blocks ? "BLOCKS" : "RELATES_TO"} ${payload.taskId}`,
    );
  } catch (error) {
    // AC7.8/D7: an offer must never cost the operator their push. The artifact
    // is already durable; a failed convenience is a note, not an exit code.
    deps.writeErr(
      `note: could not offer a card (${error instanceof Error ? error.message : "unknown"}). The artifact is stored; file the card by hand.`,
    );
  }
}

/**
 * The one wording of the standalone mint command — the printed offer and the
 * registered `jentrix artifact mint-issue` subcommand stay in sync through it
 * (test/push.test.ts pins the pairing).
 */
export function mintIssueCommandHint(
  artifactId: string,
  taskId: string,
  /** JEN-274: the session the push was addressed with (--session), if any. */
  sessionId: string | null = null,
): string {
  return `jentrix artifact mint-issue --artifact ${artifactId} --from-task ${taskId}${sessionId ? ` --session ${sessionId}` : ""}`;
}

/**
 * Where a minted card lands (D7, in order): the workspace's BUGS board where
 * one exists (current behavior), else the ANCHOR TASK'S OWN BOARD — necessary
 * on a TASKS-only workspace, where the BUGS lookup comes up empty and the
 * offer used to degrade to "file by hand". Always the board's first column.
 * Null only when neither board has a column to receive a card.
 */
async function findMintBoard(
  deps: PushDeps,
  taskId: string,
): Promise<{ id: string; name: string; columnId: string } | null> {
  return withCaller(deps, async (caller) => {
    // The task names its workspace AND its own board (the fallback target).
    const task = await callStructured(caller, "get_task", { taskId });
    const workspaceId = String(task.workspaceId ?? "");
    if (!workspaceId) return null;
    const boards = (
      (await callStructured(caller, "list_boards", { workspaceId }))
        .boards as Array<{
        id: string;
        name: string;
        kind: string;
        archivedAt: string | null;
      }>
    ).filter((b) => b.kind === "BUGS" && !b.archivedAt);
    const candidates: Array<{ id: string; name: string }> = [
      ...boards,
      ...(task.boardId
        ? [
            {
              id: String(task.boardId),
              name: String(task.boardName ?? "board"),
            },
          ]
        : []),
    ];
    for (const board of candidates) {
      const columns = (
        await callStructured(caller, "list_columns", { boardId: board.id })
      ).columns as Array<{ id: string; name: string }>;
      const first = columns[0];
      // A board with no column cannot receive a card, and creating one would
      // be inventing board structure nobody agreed to — try the next rung.
      if (first) {
        return { id: board.id, name: board.name, columnId: first.id };
      }
    }
    return null;
  });
}

/**
 * Create the card, link the artifact to it, and relate it back to the anchor.
 * Three writes, each through the shipped ops core — no new path. Idempotent
 * per artifact (`mint-<artifactId>`, AC3.4): a retried mint converges on the
 * same card, and a declined offer wrote nothing to decline.
 */
async function mintCard(
  deps: PushDeps,
  input: {
    board: { id: string; name: string; columnId: string };
    artifactId: string;
    anchorTaskId: string;
    /** "Finding" | "Gap" | "Issue" — the card title's noun. */
    noun: string;
    /**
     * STA-128 — the artifact's own title. The taxonomy title convention says
     * titles ARE claims ("Windows hook path untested"), and the board card is
     * where a reviewer triages — so the card carries the claim, not a generic
     * "Gap from STA-122". Null when the caller does not know it (an untitled
     * push); the anchor-key form is then the honest fallback.
     */
    artifactTitle: string | null;
    /** AC3.3 — the card BLOCKS the anchor (default: RELATES_TO). */
    blocks: boolean;
    /**
     * STA-26 — when the push was session-correlated, the mint's MCP calls
     * carry the SAME validated session id (`X-Stacks-Session-Id`), so the
     * created task's TASK_CREATED payload names the session and the
     * RUN_SUMMARY's "Work created" section lists the card. Server-validated:
     * a wrong id refuses the call rather than stamping a foreign session.
     */
    sessionId: string | null;
  },
): Promise<{ id: string; key?: string; artifactLinked: boolean }> {
  return withCaller(
    deps,
    async (caller, target) => {
      const anchor = await callStructured(caller, "get_task", {
        taskId: input.anchorTaskId,
      });
      const claim = input.artifactTitle?.trim();
      const created = await callStructured(caller, "create_task", {
        columnId: input.board.columnId,
        // The task-title cap is 200 chars; the claim form truncates into it.
        title: (claim
          ? `${input.noun}: ${claim}`
          : `${input.noun} from ${String(anchor.key ?? input.anchorTaskId)}`
        ).slice(0, 200),
        description: `Minted from a ${input.noun.toLowerCase()} artifact pushed on ${String(anchor.key ?? input.anchorTaskId)}. Origin session artifact: ${input.artifactId}.`,
        idempotencyKey: `mint-${input.artifactId}`,
      });
      const issueId = String(created.id);
      // The SAME artifact, referenced — never a copy (AC7.1). Carries the same
      // validated session correlation as the sibling MCP calls, so the link's
      // activity is stamped too — one flow, one attribution.
      const linkResponse = await (deps.fetchImpl ?? fetch)(
        new URL(taskTarget(issueId).path, stacksBaseUrlOf(target.url)),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${target.token}`,
            "content-type": "application/json",
            ...(input.sessionId
              ? { "X-Stacks-Session-Id": input.sessionId }
              : {}),
          },
          body: JSON.stringify({ refArtifactId: input.artifactId }),
        },
      );
      // STA-115/AC7.8 — a failed link must not cost the mint, but it must not
      // pass as "artifact linked" either: the card would carry no evidence.
      const artifactLinked = linkResponse.ok;
      if (!artifactLinked) {
        deps.writeErr(
          `note: minted the card but linking artifact ${input.artifactId} to it failed (HTTP ${linkResponse.status}) — link it by hand: jentrix push ${pushKindForNoun(input.noun)} --task ${issueId} --ref ${input.artifactId}`,
        );
      }
      // AC3.3 — an acceptance-blocking card BLOCKS the anchor (lights the red
      // Blocked badge); everything else stays RELATES_TO.
      await callStructured(caller, "add_task_link", {
        fromTaskId: issueId,
        toTaskId: input.anchorTaskId,
        kind: input.blocks ? "BLOCKS" : "RELATES_TO",
      });
      return {
        id: issueId,
        key: created.key as string | undefined,
        artifactLinked,
      };
    },
    input.sessionId ? { sessionId: input.sessionId } : undefined,
  );
}

/** The push kind whose --ref re-links an artifact of this card noun. */
function pushKindForNoun(noun: string): string {
  return noun === "Gap" ? "gap" : noun === "Issue" ? "issue" : "findings";
}

/**
 * `jentrix artifact mint-issue` — the offer's command form (AC7.5/AC7.7,
 * generalized by taxonomy AC3.1). The push path prints
 * {@link mintIssueCommandHint}; this is the subcommand it names, running the
 * SAME mint (find the board per D7, create the card, link the artifact,
 * relate — or with --blocks, block — the anchor) as `jentrix push
 * findings|gap|issue --yes`. It accepts FINDINGS, GAP, and ISSUE artifacts
 * and refuses everything else by type.
 */
export async function runMintIssue(
  flags: {
    artifact: string;
    fromTask: string;
    /** JEN-274: explicit correlation — the session the push was addressed with. */
    session?: string;
    blocks?: boolean;
    json?: boolean;
  },
  deps: PushDeps,
): Promise<number> {
  try {
    // Same correlation resolution as a push: an explicit --session <id>
    // first (JEN-274 — the documented path for a checkout with no marker:
    // headless runs, CI, a second checkout; the server validates the id and
    // refuses a foreign one), else THIS provider session's alignment marker
    // for this checkout — so a mint run from the printed hint still lands in
    // the session's RUN_SUMMARY.
    let sessionId: string | null = flags.session?.trim() || null;
    const inspection = sessionId
      ? null
      : await inspectRepository(deps.cwd(), deps.git);
    if (inspection) {
      const marker = readAlignmentMarker(
        deps.configPath,
        inspection.root,
        readCurrentProviderHookContext(deps)?.sessionId ?? null,
      );
      sessionId = marker?.sessionId ?? null;
    }
    // AC3.1 — the standalone command validates the artifact's TYPE: only the
    // mintable kinds become cards; a plan or a report does not.
    const result = await withCaller(deps, (caller) =>
      callStructured(caller, "get_artifact", { artifactId: flags.artifact }),
    );
    // get_artifact nests the row under `artifact` (beside downloadUrl).
    const record = (result.artifact ?? result) as {
      type?: unknown;
      title?: unknown;
    };
    const type = String(record.type ?? "");
    if (!(MINTABLE_ARTIFACT_TYPES as readonly string[]).includes(type)) {
      throw new UsageError(
        `artifact ${flags.artifact} is ${type || "of unknown type"} — only FINDINGS, GAP, and ISSUE artifacts mint into cards`,
        EXIT_CODES.CONFLICT,
      );
    }
    const board = await findMintBoard(deps, flags.fromTask);
    if (!board) {
      throw new UsageError(
        "no board can take a card here (no BUGS board, and the task's own board has no column). Create one and retry, or file the card by hand.",
        EXIT_CODES.NOT_FOUND,
      );
    }
    const minted = await mintCard(deps, {
      board,
      artifactId: flags.artifact,
      anchorTaskId: flags.fromTask,
      noun: mintNoun(type),
      // STA-128: the stored artifact's claim title rides onto the card.
      artifactTitle: typeof record.title === "string" ? record.title : null,
      blocks: Boolean(flags.blocks),
      sessionId,
    });
    deps.writeOut(
      flags.json
        ? JSON.stringify({
            issueId: minted.id,
            issueKey: minted.key ?? null,
            boardId: board.id,
            artifactId: flags.artifact,
            artifactLinked: minted.artifactLinked,
            relatedTaskId: flags.fromTask,
            linkKind: flags.blocks ? "BLOCKS" : "RELATES_TO",
            correlatedSessionId: sessionId,
          })
        : // JEN-274: a mint with no correlation says so — the card exists but
          // no session's RUN_SUMMARY will list it. A silent gap is the defect.
          `Minted ${minted.key ?? minted.id} on ${board.name} · ${minted.artifactLinked ? "artifact linked" : "artifact NOT linked (see note)"} · ${flags.blocks ? "BLOCKS" : "RELATES_TO"} ${flags.fromTask}${sessionId ? "" : " · card not correlated to a session"}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.writeErr(`error: ${error.message}`);
      return error.exitCode;
    }
    deps.writeErr(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/** Mounts `mint-issue` on the `artifact` group (flags exactly as the hint prints). */
export function registerMintIssueCommand(
  artifact: Command,
  deps: PushDeps,
  onExit: (code: number) => void,
): void {
  artifact
    .command("mint-issue")
    .description(
      "Mint a card from a findings/gap/issue artifact: opens a card on the workspace's BUGS board (else the task's own board), links the artifact to it, and relates it back to the source task.",
    )
    .requiredOption(
      "--artifact <id>",
      "the findings/gap/issue artifact to link",
    )
    .requiredOption(
      "--from-task <id>",
      "the task the artifact was pushed on (the card RELATES_TO it)",
    )
    .option(
      "--session <id>",
      "correlate the mint with this session (the one the push was addressed with); default: this checkout's alignment",
    )
    .option(
      "--blocks",
      "the card BLOCKS the source task (acceptance-blocking) instead of RELATES_TO",
    )
    .option("--json", "stable JSON output")
    .action(
      async (flags: {
        artifact: string;
        fromTask: string;
        session?: string;
        blocks?: boolean;
        json?: boolean;
      }) => onExit(await runMintIssue(flags, deps)),
    );
}

export function registerPushCommand(
  program: Command,
  deps: PushDeps,
  onExit: (code: number) => void,
): void {
  program
    .command("push <kind> [file]")
    .description(
      `Push a typed artifact (${PUSH_KINDS.join("|")}) from a file or stdin to the ALIGNED session — redacted locally and server-side, linked to the aligned project/task.`,
    )
    .option("--title <title>", "artifact title (defaults to kind + date)")
    .option(
      "--basis <ref>",
      'decision pushes only, repeatable: an artifact id (must resolve) or URL the decision rested on — written as the structured "Based on:" block',
      (ref: string, prior: string[]) => [...prior, ref],
      [] as string[],
    )
    .option(
      "--session <id>",
      "explicit session id (default: this checkout's alignment)",
    )
    .option(
      "--task <id>",
      "push straight to a task — no session, no alignment marker, no running host",
    )
    .option(
      "--agent <name>",
      "producer label for this push (defaults to the session's own label)",
    )
    .option("--agent-emoji <emoji>", "emoji shown before the producer label")
    .option(
      "--ref <artifactId>",
      "reference an EXISTING artifact from --task instead of uploading (one artifact, N tasks)",
    )
    .option(
      "--yes",
      "accept the offers this push makes (mint a card from findings/gap/issue) without prompting",
    )
    .option(
      "--blocks",
      "with --yes on a findings/gap/issue push: the minted card BLOCKS the aligned task (acceptance-blocking) instead of RELATES_TO",
    )
    .option(
      "--from-cmd <command>",
      'log pushes only: run the command locally, capture exit code + a 64 KB tail-biased output tail, and push an ATTESTED LOG opening with both — then exit with the command\'s own code ("tests green" claims carry evidence)',
    )
    .option("--json", "stable JSON output")
    .action(async (kind: string, file: string | undefined, flags: PushFlags) =>
      onExit(await runPush(kind, file, flags, deps)),
    );
}
