---
description: Turn the opening prompt into a goal and a small set of Jentrix tasks, confirmed by the operator before anything is created
allowed-tools: Bash(jentrix task:*), Bash(jentrix column:*), Bash(jentrix board:*), Bash(jentrix session:*), Bash(jentrix push:*)
---
<!-- Source of truth: plugins/claude in jentrix-au/jentrix. Shipped verbatim in the npm package. -->

Decompose the work the operator just asked for into a goal and a short task
list, **confirm both before creating anything**, then create them.

`/jentrix-align` binds at most ONE task and is scrupulous that its title is the
operator's own words. Every task after that used to be agent-invented with no
confirmation step at all — the principle was right and its coverage was one
task deep. This command extends the same rule to the rest.

## Rules that are not negotiable

- **You never create a board-permanent title the operator has not approved.**
  Propose; do not decide. The operator edits or replaces any title before it
  is created.
- **Propose few tasks.** A task is a commitment, not a restatement of the
  prompt. Two or three real units of work beat six that mirror your plan's
  headings. If the prompt is one unit of work, say so and create nothing.
- **The prompt is provenance, the tasks are commitments.** Save the prompt
  once, verbatim, as a `prompt` artifact; do not transcribe it into task
  titles. The approved goal is its own `goal` artifact — the inputs are typed
  records the RUN_SUMMARY's Intent cites, not prose folded into a plan.
- Read the board's real columns before placing anything. Never invent a
  column or a status.

## Steps

1. Confirm the session is aligned: `jentrix session status`. If it is not, stop
   and point the operator at `/jentrix-align` — an unanchored plan has no board
   to land on, and creating tasks somewhere else is worse than creating none.
2. Read the board's columns:
   `jentrix column list --board <boardId> --json`. The first column is the
   normal home for new work unless the operator says otherwise.
3. Draft, in your own analysis and NOT yet on the board:
   - **one goal sentence** — what "done" means for this work, and how it will
     be judged;
   - **1–4 task titles**, each a unit of work someone could pick up alone.
4. Present them for confirmation through the native choice UI
   (AskUserQuestion), one decision at a time, showing your proposed wording
   verbatim. Note that the choice UI has no free-text-only mode — it requires
   preset options — so "Other…" is the intended escape for the operator to
   type their own wording, and you must say so. Their words win; when they
   type a replacement, use it exactly, do not "clean it up".
5. Create only what was approved:
   - `jentrix task create --column-id <columnId> --title "<approved title>" --description "<one-line scope>" --idempotency-key "<stable-key>" --json`
   - record the goal on the aligned task (the card keeps its at-a-glance
     line; the artifact below is the record):
     `jentrix task update --task <alignedTaskId> --description "GOAL: <approved goal> …"`
   - push the opening prompt as provenance, VERBATIM:
     `jentrix push prompt --title "Opening prompt"` with the operator's prompt
     on stdin — never a paraphrase;
   - push the approved goal:
     `jentrix push goal --title "Goal"` with the approved goal sentence on
     stdin;
   - when a PRD exists for this work, push it too:
     `jentrix push prd --title "<PRD title>"` with the PRD body on stdin.
6. Report the created ids and keys back to the operator, and say which task
   you are starting on. Move that one into the working column
   (`jentrix task move --task <id> --to-column-id <id>`).

If the operator declines the plan, create nothing and say so plainly. An
un-decomposed prompt is a normal outcome; a board full of speculative tasks is
not.
