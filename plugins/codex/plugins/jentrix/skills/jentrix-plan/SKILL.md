---
name: jentrix-plan
description: Turn the opening request into an operator-approved goal and small Jentrix task set, then store the prompt and goal as typed artifacts.
---
<!-- Source of truth: plugins/codex in jentrix-au/jentrix. Shipped verbatim in the npm package. -->

# Plan confirmed work

1. Confirm the session is aligned with `jentrix session status`; otherwise direct the
   operator to `$jentrix-align` and create nothing.
2. Read the board's real columns.
3. Draft one measurable goal and one to four independent task titles. If the request
   is already one unit of work, create no extra tasks.
4. Ask the operator to approve or replace the goal and every title. Their wording is
   authoritative; never silently clean it up.
5. Create only approved tasks with stable idempotency keys and record the goal on
   the aligned task. Then push the typed inputs — the provenance the RUN_SUMMARY's
   Intent cites: the opening prompt VERBATIM with
   `jentrix push prompt --title "Opening prompt"` (never a paraphrase), the
   approved goal with `jentrix push goal --title "Goal"`, and, when a PRD exists
   for this work, `jentrix push prd --title "<PRD title>"` with the PRD body on
   stdin.
6. Report created ids/keys and move only the task being started into the board's
   actual working column.

If approval is declined, write nothing.
