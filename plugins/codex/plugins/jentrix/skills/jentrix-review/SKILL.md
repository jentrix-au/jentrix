---
name: jentrix-review
description: Review a Jentrix session's typed artifacts by category, verify the readiness contract, and post the verdict as a comment on the aligned task.
---
<!-- Source of truth: cli/plugins. Shipped verbatim in the npm package. -->

# Review a session's record

1. Resolve the target session (argument, else `jentrix session status`) and its
   aligned task — the verdict lands there.
2. `jentrix tool list_artifacts --args '{"workspaceId":"…","sessionId":"…"}'` and
   group by review category, walking in order: input → plan → decision → output →
   issue → gap → learning → record.
3. Read the RUN_SUMMARY, every DECISION_MEMO, and the outputs under judgment via
   `jentrix artifact get --artifact-id <id>` download URLs.
4. Verify the readiness contract yourself (never just quote the verdict): ≥1 input;
   every memo's `Based on:` refs resolve; ≥1 output or ≥1 gap; capture integrity
   holds or capture was off by design.
5. Post ONE task comment with per-category counts, each check with evidence, and
   the conclusion. Never move cards, never self-accept — Accept/Return belongs to
   the operator.
6. Offer (never auto-run) `jentrix push issue|gap` and the mint command for
   anything the walk surfaced that is not yet on the record.
