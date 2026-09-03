---
description: End the connected Jentrix session (pushes the final artifacts, verifies capture, stores the RUN_SUMMARY)
allowed-tools: Bash(jentrix session:*), Bash(jentrix push:*), Bash(jentrix artifact:*), Bash(jentrix column:*), Bash(jentrix task:*), Bash(jentrix tool:*)
---
<!-- Source of truth: cli/plugins. Shipped verbatim in the npm package. -->

End the connected Jentrix session honestly. For an ALIGNED session (the MVP
pipeline), the typed artifacts ARE the record — push them before closing:

1. If this session is aligned (`jentrix session status` shows the alignment):
   - Push the final report: write a concise session report (what was done,
     what changed, what's next) and run
     `jentrix push report --title "<short title>"` with the content on stdin.
   - Push any decisions made this session that were not already pushed:
     `jentrix push decision --basis <artifact-id|url> …` (one per decision;
     `--basis` is repeatable and names what the decision rested on — file the
     context first so the ref resolves).
   - **Gap sweep**: every promised-but-undone item becomes a
     `jentrix push gap` — one per gap, title stating the claim ("Windows hook
     path untested"). A session with no output MUST have at least one gap
     explaining why. Push `jentrix push issue` for anything found broken and
     not yet recorded.
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
4. Run `jentrix session end` with the Bash tool and relay the output. With no
   id it closes THIS session's aligned session (the same resolution `jentrix
   session status` shows); pass an id only when the operator names a different
   session. Telemetry is recorded by the session host's attested path — never
   report token numbers yourself.
5. **Relay the closing telemetry line verbatim.** `session end` prints a
   `Telemetry:` line, and on stderr it may print `NO TOKEN TELEMETRY: …`.
   Exit 0 does NOT mean telemetry was recorded — on 2026-08-11 a real session
   closed at exit 0 having recorded none, and nothing said so. If the warning
   appears, show it in full: it names the cause (usually the host was watching
   another session's transcript) and the repair for the next session
   (`jentrix session align --task <id-or-key> --provider-session <id>
   --transcript-path <file>`). Do not restate the numbers as your own claim —
   quote the line.
6. The session is SEALED once ended: `jentrix push` refuses it
   (`SESSION_NOT_ACTIVE`), by design. Anything learned at the close —
   including the telemetry line above — belongs in the report you pushed in
   step 1, or in the next session. Do not try to reopen it.
7. Ending the Jentrix session does NOT terminate this Claude Code session —
   say so if the user seems to expect it.

**Evidence floor.** `jentrix session end` enforces fixed checks and will
REFUSE to close when they are unmet: E1 — HEAD moved but no attested DIFF
(the CLI pushes the real patch itself; just re-run `session end` from the
aligned checkout); E2 — commits with no `jentrix push decision` and no
declared-deviation `jentrix push gap`; E3 — a REPORT carrying `## Learnings`
/ `## Gaps` / `## Decisions` sections while the session has zero
corresponding typed artifacts (split them into `push learning|gap|decision`,
never one blob). Comply by pushing the named evidence and retrying, or
deviate honestly with a `gap` — `--acknowledge-evidence-gaps` closes anyway
and stamps each unmet check MISSING into Review readiness. Run every gate
through `jentrix push log --from-cmd "<command>"` (it records the exit code
and output tail as a LOG and exits with the command's own code), so "tests
green" claims carry evidence instead of tripping the E4 advisory.
