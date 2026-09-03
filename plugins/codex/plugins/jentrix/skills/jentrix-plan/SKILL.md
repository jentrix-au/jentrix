---
name: jentrix-plan
description: Turn the opening request into an operator-approved goal and small Jentrix task set, then store the prompt and goal as typed artifacts.
---
<!-- Source of truth: cli/plugins. Shipped verbatim in the npm package. -->

# Plan confirmed work

1. Confirm the session is aligned with `jentrix session status`; otherwise direct the
   operator to `$jentrix-align` and create nothing.
2. Read the board's real columns.
3. Draft one measurable goal and one to four independent task titles. If the request
   is already one unit of work, create no extra tasks.
4. Ask the operator to approve or replace the goal and every title. Their wording is
   authoritative; never silently clean it up.
5. Create only approved tasks with stable idempotency keys, record the goal on the
   aligned task, push the opening prompt verbatim as a `prompt` artifact, and push
   the approved goal as a `goal` artifact.
6. Report created ids/keys and move only the task being started into the board's
   actual working column.

If approval is declined, write nothing.
