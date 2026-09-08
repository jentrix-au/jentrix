Run the category walk over one session's record (docs: Reviewing a session).
Read-only until the final comment; never modify the tree, the board, or the
artifacts under review.

1. Resolve the session: the argument if one was given, else the checkout's
   aligned session (`jentrix session status`). Note its aligned task — the
   verdict lands there.
2. List the record:
   `jentrix artifact list --workspace <id> --session-id <sessionId> --json`
   (or `jentrix tool list_artifacts --args '{"workspaceId":"…","sessionId":"…"}'`).
   Group the rows by review category — input (PROMPT/GOAL/PRD/SOURCE_DIGEST),
   plan (PLAN), decision (DECISION_MEMO), output (DELIVERABLE/REPORT/DIFF/
   PATCH/PR/BRANCH/COMMIT/SCREENSHOT/RECORDING/MOCKUP/CSV/PDF/DOC + anything
   unmapped), issue (ISSUE/FINDINGS), gap (GAP), learning
   (LEARNING/MEMORY_NOMINATION), record (TRACE/RUN_SUMMARY/LOG/EVAL_REPORT/
   POLICY_REPORT) — and walk them in that order.
3. Read what needs reading: `jentrix artifact get --artifact-id <id>` returns a
   short-lived download URL; fetch the bodies of the RUN_SUMMARY, each
   DECISION_MEMO, and every output you are judging.
4. Check the readiness contract and verify it yourself — do not just quote
   the summary's verdict:
   - ≥ 1 input artifact;
   - every DECISION_MEMO body carries a `Based on:` block, and each
     artifact-id ref in it RESOLVES (`jentrix artifact get --artifact-id`) — a ref that
     404s is a finding;
   - ≥ 1 output artifact OR ≥ 1 gap explaining why there is none;
   - the RUN_SUMMARY's Capture integrity section reports complete capture or
     capture off by design.
5. Post the verdict as ONE comment on the aligned task
   (`jentrix comment create --task <id> --body …`): the per-category counts,
   each contract check with its evidence, what you actually opened, and the
   conclusion — review-ready or not, and what is missing. Verdicts are
   task-scoped; never move the card and never mark anything accepted —
   Accept/Return is the operator's control.
6. If the walk surfaced something broken that is not yet on the record,
   offer (never auto-run) `jentrix push issue` / `jentrix push gap` on the
   session, and the mint command for a card.
