---
name: jentrix-connect
description: Connect the current Codex task to Jentrix (session anchor + capture in the folder's workspace).
---
<!-- Source of truth: cli/plugins/codex. Shipped verbatim in the npm package. -->

# Connect this Codex task

Run:

```bash
jentrix session connect --provider codex
```

The session's scope is the FOLDER's workspace (client-runtime v2): a
`FOLDER_NOT_ALIGNED` refusal means run `jentrix folder align`, then retry.
Connect is identity only — anchoring work is `$jentrix-align`, and a Project
is an optional task label (`jentrix task project add`). Do not pass a
model-authored provider-session id: the CLI resolves the current Codex task from
trusted environment and lifecycle-hook context. Relay the command output or error
verbatim. The command starts the hook-watching host in the background and prints
its pid; do not start a second host. Never put credentials on the command line.

When lifecycle hooks are unavailable, the CLI may recover telemetry only from the
exact `rollout-*-${CODEX_THREAD_ID}.jsonl` under the trusted Codex home. Accept that
exact match; never choose the newest session file. Explain that the fallback keeps
provider token receipts and opening-prompt provenance, but not prompt/tool/assistant
lifecycle events. Direct the operator to review and trust the plugin hooks by typing `/hooks` at Codex's own prompt
(an in-session Codex CLI command), then start a new Codex task for full lifecycle coverage. If trusted task
identity or the exact rollout is unavailable, relay the refusal and do not guess.
