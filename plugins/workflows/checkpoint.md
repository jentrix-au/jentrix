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
3. **If the checkpoint claims a gate, run the gate first.** A checkpoint that
   says "typecheck green" without an attested LOG behind it is a claim, and
   `jentrix session end` now REFUSES a close whose report claims a gate family
   (`typecheck` · `lint` · `test` · `e2e`) with no attested LOG of that same
   family. So, before writing the body: for each gate you are about to name,
   check whether this session already has an attested LOG for it, and if not,
   run it —

   ```
   jentrix push log --from-cmd "<the gate command>"
   ```

   — then cite the returned artifact id in the checkpoint beside the claim.
   The command exits with the GATE's own code, so a red gate stays red and you
   report it red. If you are not going to run it, do not claim it: say what was
   not run and why.

4. **`## Code contact`** — the files the objective named, and which of them
   this session actually opened:

   ```
   jentrix session contact --paths <the files the PROMPT/GOAL named>
   ```

   List the never-opened ones under that heading, verbatim. This is the check
   that catches the expensive failure: work built on a file nobody read. If the
   answer says no local activity skeleton exists, say THAT — "never opened" by
   absence is not the same claim as "never opened" by evidence.

5. Push it — as an ARTIFACT, never as a comment. A "Checkpoint" posted as a
   comment is not a checkpoint: the summary counts REPORTs titled
   `Checkpoint — …` and prints `checkpoints: N`, and a comment counts zero.
   - `jentrix push learning --title "Checkpoint — <topic>"` when it is durable
     knowledge worth carrying past this work;
   - `jentrix push report --title "Checkpoint — <topic>"` when it is the
     state of THIS work.
   Content goes on stdin.
6. Relay the returned `artifactId` to the operator, and say which kind you
   chose and why.
7. If the session's task status no longer matches reality, fix it now:
   `jentrix column list --board <boardId>` then
   `jentrix task move --task <id> --to-column-id <id>`. Only the columns the
   board actually has.

**Cadence duty (evidence floor).** Checkpoint after EVERY commit, not only at
the end: push the `decision` the commit rested on the moment it lands — with
`--basis <artifact-id-or-url>`, or `--no-basis "<reason>"` when it rested on
your own reading and there is nothing filed to cite (the command REFUSES
without one of the two) — and run its gates through `jentrix push log
--from-cmd "<command>"` so the exit code and output tail are recorded as a LOG.
Record quality must track the work, not end-of-session diligence — `jentrix
session end` enforces this: it refuses on commits with no decision record that
names its basis, on sectioned reports with no typed artifacts, and on a gate
claimed in prose with no attested LOG of that gate family. A deliberate
exception is an ordinary `jentrix push gap` — but a gap that names a file in
the checkout this session never opened is itself refused, because that is not a
limitation, it is an unread file.

Note for the operator: this records the distillation. On a session aligned
with `--capture`, the raw pre-compaction range is preserved separately and
automatically by the `PreCompact` hook, so the bytes survive even when this
command is never run — but only the bytes. On a capture-off session (the MVP
default) the hook records the boundary and nothing else, so this command is
the only thing that carries the work forward.
