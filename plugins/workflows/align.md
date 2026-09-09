Anchor THIS session's next work and telemetry to a task with an accountable
owner (client-runtime v2 — alignment is a narrow flag-driven command, not a
wizard; a Project is an optional task label and is never part of it).

1. If the operator named a work item (e.g. `{{prefix}}jentrix-align JEN-42`), run with
   the provider's command tool:

   ```
   jentrix session align --provider {{provider}} --task <that value> --json
   ```

   For explicit session-level work ("no task"), run
   `jentrix session align --provider {{provider}} --session-level --json` instead — but only when the
   operator SAID so; never decide that yourself.

2. If no work item was named, ask the operator through the native choice UI
   (described in the provider entry above): list open tasks from the current board
   (`jentrix task list --board <id> --json` — read the board's real columns,
   never invent one) or let them type a key through "Other…". The task title
   they pick is theirs; you never invent board-permanent labels. Then run the
   command above with their choice.

3. Relay the returned `alignment` snapshot VERBATIM — it is the
   server-confirmed "we agree" record. The JSON also carries `boundary`
   (`FLUSHED | UNFLUSHED | NOT_REQUIRED`): when it is `UNFLUSHED`, relay the
   printed disclosure line (mid-switch spend stays bounded by one heartbeat
   window) rather than summarizing it away.

4. Move the aligned task to the board's working column when you start work on
   it: read the real columns (`jentrix column list --board <boardId>`) and
   move with `jentrix task move --task <taskId> --to-column-id <columnId>`.
   `{{prefix}}jentrix-end` moves it to In review when the work is genuinely finished —
   the terminal move is the operator's Accept, never yours.

5. **Finish by reading the card**, and relay what comes back:

   ```
   jentrix task context --task <that task>
   ```

   One call returns the description, the links BOTH ways with their titles,
   the subtasks, the latest artifact of each type with its id, and the last
   five comments. Read it before you touch any code: a linked card is usually
   where the prior round's reasoning lives, and its artifacts are the context
   you would otherwise reconstruct from scratch. If it prints
   `no links · no artifacts · no comments`, the card has nothing to give and
   you stop looking — that single line is the answer, not an invitation to run
   `task get`, `task search` and `comment list` to confirm it.

Notes for you (the assistant):

- Do NOT pass `--provider-session` — the CLI reads the current session id and
  transcript from the TRUSTED lifecycle-hook context this plugin's hooks
  recorded; model-authored ids are never accepted.
- `FOLDER_NOT_ALIGNED` means the checkout has no workspace binding: run
  `jentrix folder align` (interactive picker), then retry. Never invent a
  workspace or task id.
- Settings ride the same command on a SAME-task re-align without fragmenting
  attribution: `--owner <user-id>`, `--agent <label>`, `--agent-emoji <e>`,
  `--budget <tokens>|--no-budget`, `--capture|--no-capture`,
  `--skeleton|--no-skeleton`. Only pass what the operator asked for.
- Project labels are separate and optional:
  `jentrix task project add --task <id-or-key> --project <id-or-slug>`
  (ADMIN/OWNER authorization remains enforced by the server).
- If a command fails, show its error verbatim — it names the blocker and the
  fix. Do not improvise a workaround.
