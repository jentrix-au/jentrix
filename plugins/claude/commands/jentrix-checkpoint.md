---
description: Write a distilled state-of-play for this session and push it as a typed Jentrix artifact
allowed-tools: Bash(jentrix push:*), Bash(jentrix session:*), Bash(jentrix task:*), Bash(jentrix column:*)
---
<!-- Source of truth: plugins/claude in jentrix-au/jentrix. Shipped verbatim in the npm package. -->

Write down what this session currently knows, and push it.

This is the half a hook provably cannot do. A hook is a shell command with a
small JSON payload on stdin and no model turn: it can move bytes and nothing
else. Distilling 400k tokens into the six facts that mattered requires a model
turn. That is this command.

It matters most on a **capture-off** session, which is the MVP default. There
the `PreCompact` hook records only that a compaction happened — it does not
preserve the transcript, because `capture: "off"` means the operator asked for
typed artifacts and no transcript. The bytes stay on the local machine and
nothing carries their meaning into Jentrix unless you write it. So on a
capture-off session this command is not a nicety; it is the only thing that
survives the compaction.

Run it at real boundaries: before a `/compact`, after a decision that changes
the plan, when a long investigation resolves, or before handing the work over.

## Steps

1. Write the checkpoint. Cover only what a fresh session would need and could
   not re-derive cheaply:
   - **Decisions taken** — and, for each, the reason, because the reason is
     what gets lost first.
   - **What actually changed** — files, records, ids. Concrete, not "made
     progress".
   - **Open questions and dead ends** — including what was tried and did not
     work, which is the most expensive thing to rediscover.
   - **Next step** — the single thing to do next.
2. Do not summarize the transcript. Do not restate the prompt. Do not include
   anything you have not verified this session — a checkpoint that carries a
   guess as a fact poisons every session that reads it.
3. Push it:
   - `jentrix push learning --title "Checkpoint — <topic>"` when it is durable
     knowledge worth carrying past this work;
   - `jentrix push report --title "Checkpoint — <topic>"` when it is the
     state of THIS work.
   Content goes on stdin.
4. Relay the returned `artifactId` to the operator, and say which kind you
   chose and why.
5. If the session's task status no longer matches reality, fix it now:
   `jentrix column list --board <boardId>` then
   `jentrix task move --task <id> --to-column-id <id>`. Only the columns the
   board actually has.

**Cadence duty (evidence floor).** Checkpoint after EVERY commit, not only at
the end: push the `decision` (with `--basis`) the commit rested on the moment
it lands, and run its gates through `jentrix push log --from-cmd "<command>"`
so the exit code and output tail are recorded as a LOG. Record quality must
track the work, not end-of-session diligence — `jentrix session end` enforces
this (it refuses on commits with no decision record and on sectioned reports
with no typed artifacts; a deliberate exception is an ordinary
`jentrix push gap`).

Note for the operator: this records the distillation. On a session aligned
with `--capture`, the raw pre-compaction range is preserved separately and
automatically by the `PreCompact` hook, so the bytes survive even when this
command is never run — but only the bytes. On a capture-off session (the MVP
default) the hook records the boundary and nothing else, so this command is
the only thing that carries the work forward.
