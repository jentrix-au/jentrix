End the connected Jentrix session honestly. For an ALIGNED session (the MVP
pipeline), the typed artifacts ARE the record — push them before closing:

1. If this session is aligned (`jentrix session status` shows the alignment):
   - Push the final report: write a concise session report (what was done,
     what changed, what's next) and run
     `jentrix push report --title "<short title>"` with the content on stdin.
   - Push any decisions made this session that were not already pushed. **Ask
     what the decision rested on BEFORE you write the memo** — the basis is
     not a field to fill in afterwards, it is the thing that makes the memo a
     decision rather than an assertion. For each one, answer "what did this
     rest on?" first, then push:
     `jentrix push decision --basis <artifact-id|url> …` (repeatable; file the
     context first so the ref resolves), or, when it genuinely rested on your
     own reading of the code and there is nothing filed to cite,
     `jentrix push decision --no-basis "<the reason>"`. The command REFUSES
     without one of the two, and a memo with neither would not have counted
     toward E2/E3 anyway.
   - **Gap sweep**: every promised-but-undone item becomes a
     `jentrix push gap` — one per gap, title stating the claim ("Windows hook
     path untested"). A session with no output MUST have at least one gap
     explaining why. Push `jentrix push issue` for anything found broken and
     not yet recorded. A gap that names a file in this checkout the session
     never OPENED is refused with the path and the remedy: read it or drop the
     path. That refusal is not an obstacle to route around — the one-line read
     that satisfies it is the read that would have told you whether the gap is
     real.
   - Push any durable lessons: `jentrix push learning …`.
   - Do NOT push a diff by hand. When HEAD moved, `jentrix session end`
     generates the real `git log --patch` for the session's range itself and
     pushes it as the attested DIFF (evidence check E1) — a model-authored
     diff would be a second, unattested copy.
   Ask the operator (native choice UI) before pushing anything they might
   not want recorded; never invent content — summarize what actually
   happened.
2. **Batched mint confirmations.** Collect this session's gap/issue/findings
   artifacts that are not yet cards (each push printed its offer) and ask the
   operator ONCE, as a single native choice list: which should become cards?
   For each accepted one run
   `jentrix artifact mint-issue --artifact <id> --from-task <taskId>`
   (add `--blocks` when it blocks acceptance of the aligned task). Mints are
   idempotent per artifact (`mint-<artifactId>`), so a retry converges on the
   same card. A declined mint leaves the artifact exactly as pushed — never
   nag again, never mint unasked.
3. Move the aligned task to the board's **"In review"** column when the work
   is finished — not to a terminal one. Acceptance is a human's to record
   (Accept / Return on the task panel writes who decided, when, and on which
   artifacts), and an agent grading its own work as Done is the cheapest habit
   to break now and the most expensive later. Read the board's real columns
   first — `jentrix column list --board <boardId>` — and move with
   `jentrix task move --task <taskId> --to-column-id <columnId>`. Use the
   column names the board has; never invent a status it does not carry, and
   never move a card whose work is unfinished. If the board has no in-review
   column, say so and leave the card where it is rather than moving it to a
   terminal column the operator never got to judge. If it is unclear whether
   the task is done, ask the operator through the native choice UI. Pushing a
   `findings` or `report` artifact is not by itself proof the task is done.
4. Run `jentrix session end` with the provider's command tool and relay the output. With no
   id it closes THIS session's aligned session (the same resolution `jentrix
   session status` shows); pass an id only when the operator names a different
   session. If the CLI reports ambiguous sessions, ask the operator which one;
   never choose a sibling. Telemetry is recorded by the session host's attested path — never
   report token numbers yourself.
5. **Relay the closing telemetry line verbatim.** `session end` prints a
   `Telemetry:` line, and on stderr it may print `NO TOKEN TELEMETRY: …`.
   Exit 0 does NOT mean telemetry was recorded — on 2026-08-11 a real session
   closed at exit 0 having recorded none, and nothing said so. If the warning
   appears, show it in full: it names the cause (usually the host was watching
   another session's transcript) and the repair for the next session
   (`jentrix session align --provider {{provider}} --task <id-or-key> --provider-session <id>
   --transcript-path <file>`). Do not restate the numbers as your own claim —
   quote the line.
6. The session is SEALED once ended: `jentrix push` refuses it
   (`SESSION_NOT_ACTIVE`), by design. Anything learned at the close —
   including the telemetry line above — belongs in the report you pushed in
   step 1, or in the next session. Do not try to reopen it.
7. Ending the Jentrix session does NOT terminate the provider session —
   say so if the user seems to expect it.

**Evidence floor.** `jentrix session end` enforces fixed checks and will
REFUSE to close when they are unmet:

- **E1** — HEAD moved but no attested DIFF (the CLI pushes the real patch
  itself; just re-run `session end` from the aligned checkout).
- **E2** — commits with no `jentrix push decision` **that names its basis**,
  and no declared-deviation `jentrix push gap`. Basis-less memos do not count,
  however many are pushed: the count was never the evidence.
- **E3** — a REPORT carrying `## Learnings` / `## Gaps` / `## Decisions`
  sections while the session has zero corresponding typed artifacts (split
  them into `push learning|gap|decision`, never one blob).
- **E4** — a REPORT that CLAIMS a gate refuses the close unless the session
  has an attested LOG (`jentrix push log --from-cmd`) whose command names the
  **same gate family**: `typecheck` · `lint` · `test` · `e2e`. Family, not
  exact command — "tests green" is covered by `pnpm test:mvp` and is NOT
  covered by `pnpm lint`. A pasted LOG covers nothing; the CLI warns
  `UNATTESTED LOG` when you push one, and the summary marks it.

Comply by pushing the named evidence and retrying, or deviate honestly with a
`gap`. `--acknowledge-evidence-gaps` closes anyway and stamps each unmet check
MISSING into Review readiness — reach for it when the gap is real, never to get
past a check you could satisfy by running the gate. A refusal leaves the
session AND its capture host running, so the comply work is still recorded.
