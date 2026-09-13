Decompose the work the operator just asked for into a goal and a short task
list, **confirm both before creating anything**, then create them.

`{{prefix}}jentrix-align` binds at most ONE task and is scrupulous that its title is the
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
- **The prompt is provenance, the tasks are commitments, the plan is the
  record of the decomposition.** Save the prompt once, verbatim, as a
  `prompt` artifact; do not transcribe it into task titles. The approved goal
  is its own `goal` artifact, and the decomposition itself — goal, task
  titles, what was approved and what is still pending — is a `plan` artifact.
  The inputs are typed records the RUN_SUMMARY's Intent and Plan history
  cite, not prose folded into chat. The PLAN exists whether or not any card
  gets created: it records what was proposed and decided.
- **Never fabricate approval.** When the native choice UI cannot answer
  (a non-interactive run, an operator who has not replied), the approvals
  already in hand still stand — the aligned task's title is the operator's
  words, and a goal the opening prompt states in its own terms is the
  operator's goal — but a title they have not seen is only a proposal.
  Preserve the proposals as the PLAN, create no cards for them, and say in
  your reply which decisions are pending. Silence is not a yes.
- Read the board's real columns before placing anything. Never invent a
  column or a status.

## Steps

1. Confirm the session is aligned: `jentrix session status`. If it is not, stop
   and point the operator at `{{prefix}}jentrix-align` — an unanchored plan has no board
   to land on, and creating tasks somewhere else is worse than creating none.
2. Read the board's columns:
   `jentrix column list --board <boardId> --json`. The first column is the
   normal home for new work unless the operator says otherwise.
3. Draft, in your own analysis and NOT yet on the board:
   - **one goal sentence** — what "done" means for this work, and how it will
     be judged;
   - **1–4 task titles**, each a unit of work someone could pick up alone.
4. Present them for confirmation through the native choice UI
   described in the provider entry, one decision at a time, showing your
   proposed wording verbatim and allowing replacements. Their words win;
   use a replacement exactly, do not "clean it up".
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
     `jentrix push prd --title "<PRD title>"` with the PRD body on stdin;
   - push the plan — ALWAYS, even when the operator approved nothing yet or
     declined every card: `jentrix push plan --title "Plan"` with, on stdin,
     the goal sentence, each proposed task title marked `approved` /
     `pending` / `declined`, the ids and keys of the cards that were
     created, and the column they landed in. A plan with every title
     `pending` is a true record of a headless run; a session with no PLAN
     artifact has no record that a decomposition happened at all.
6. Report the created ids and keys back to the operator, and say which task
   you are starting on. Move that one into the working column
   (`jentrix task move --task <id> --to-column-id <id>`). When confirmation
   is still pending, say so and continue with the aligned task — do not wait
   on an answer that cannot arrive.

If the operator declines the plan, create nothing and say so plainly. An
un-decomposed prompt is a normal outcome; a board full of speculative tasks is
not.
