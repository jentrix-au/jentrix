---
name: jentrix-end
description: End a connected Jentrix session after preserving approved outputs, parking completed work in review, and reporting capture honestly.
---
<!-- Source of truth: cli/plugins. Shipped verbatim in the npm package. -->

# End the connected session

1. For an aligned session, offer to push a concise final `report`, any unrecorded
   `decision --basis <artifact-id|url>` or `learning`, and a useful `diff`. Run the
   **gap sweep**: every promised-but-undone item becomes a `jentrix push gap` (title
   states the claim), and anything found broken becomes `jentrix push issue`. Never
   invent content or record material the operator declined.
2. **Batched mint confirmations**: list this session's gap/issue/findings artifacts
   not yet minted and ask the operator once which should become cards; for each
   accepted one run `jentrix artifact mint-issue --artifact <id> --from-task <id>`
   (`--blocks` when it blocks acceptance). Idempotent per artifact
   (`mint-<artifactId>`); a declined mint leaves the artifact untouched.
3. If work is genuinely complete, read the board's real columns and move the task to
   **In review**. Never self-accept it into Done.
4. Run `jentrix session end <session-id>` and relay all output, including the exact
   telemetry line and any capture gap.
5. Report provider-reported Codex token receipts when the hook supplied a rollout
   path. If none were observed, keep token fields null; never report estimates.
6. A final-response artifact exists only when a prior `Stop` hook observed assistant
   text before closure. The assistant text produced by this closing turn occurs after
   the command and must not be claimed as captured.
7. The Jentrix session is sealed after end; do not retry pushes against it. Ending it
   does not terminate the Codex task.

**Evidence floor.** `jentrix session end` REFUSES to close on unmet checks: E1 —
HEAD moved but no attested DIFF (the CLI pushes the real patch itself; re-run
`session end` from the aligned checkout); E2 — commits with no `jentrix push
decision` and no declared-deviation `jentrix push gap`; E3 — a REPORT carrying
`## Learnings` / `## Gaps` / `## Decisions` sections while the session has zero
corresponding typed artifacts (split them into `push learning|gap|decision`).
Comply by pushing the named evidence and retrying, or deviate honestly with a
`gap`; `--acknowledge-evidence-gaps` closes anyway and stamps each unmet check
MISSING into Review readiness. Run every gate through
`jentrix push log --from-cmd "<command>"` (records exit code + output tail as a
LOG, exits with the command's own code) so gate claims carry evidence instead of
tripping the E4 advisory.
