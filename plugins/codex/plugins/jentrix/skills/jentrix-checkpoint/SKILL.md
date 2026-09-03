---
name: jentrix-checkpoint
description: Distill verified session state into a typed Jentrix checkpoint that survives compaction or handoff.
---
<!-- Source of truth: plugins/codex in jentrix-au/jentrix. Shipped verbatim in the npm package. -->

# Write a checkpoint

Write only what a fresh task could not cheaply rediscover:

- decisions and reasons;
- verified files, records, and ids changed;
- open questions and failed approaches;
- the single next step.

Do not summarize the transcript or promote guesses to facts. Push durable knowledge
with `jentrix push learning --title "Checkpoint — <topic>"`; otherwise use
`jentrix push report`. Relay the artifact id and explain the chosen kind. If task
status is stale, read the real columns and correct it.

The compact hooks preserve only the approved evidence boundary; this skill performs
the model-authored distillation.

**Cadence duty (evidence floor).** Checkpoint after EVERY commit, not only at the
end: push the `decision` (with `--basis`) the commit rested on the moment it lands,
and run its gates through `jentrix push log --from-cmd "<command>"` so the exit code
and output tail land as a LOG. `jentrix session end` enforces this — it refuses on
commits with no decision record and on sectioned reports with no typed artifacts;
a deliberate exception is an ordinary `jentrix push gap`.
